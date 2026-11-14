'use strict';
// 复现并验证「刷新小程序后被踢回绑定页」这个 bug。
//
// 现象：token 处于 SDK 的 refresh 窗口期时，请求不带 Authorization，
// PostgREST 以 anon 执行，RLS 过滤掉所有行，返回 200 []。
// loadContext 把「查不到」当成「没加入小家」，于是跳绑定页。
//
// 本测试用假的 cloud 模拟这条链路，验证修复后能自愈。

const path = require('path');
const fs = require('fs');
const Module = require('module');

let pass = 0, fail = 0;
const ok = (c, m, d) => { if (c) { pass++; console.log('  PASS ' + m); } else { fail++; console.log('  FAIL ' + m + (d ? ' -- ' + d : '')); } };
const eq = (a, e, m) => ok(JSON.stringify(a) === JSON.stringify(e), m, '期望 ' + JSON.stringify(e) + '，实际 ' + JSON.stringify(a));

// ── 构造假 cloud ──────────────────────────────────────────────────────────────
// anon 态：查询返回 []（模拟 RLS 过滤）；带身份：返回真实行。
function makeCloud(opts) {
    const state = {
        authed: opts.authedInitially !== false,
        refreshCalls: 0,
        memberQueries: 0,
        sessionCalls: 0,
        sessionUserIdAfterRefresh: opts.sessionUserIdAfterRefresh,
    };

    const MEMBER = { space_id: 1, user_id: 'wx:me', display_name: null, joined_at: '2026-01-01' };
    const SPACE = { id: 1, name: '我们的小家', invite_code: 'ABCDEF', created_by: 'wx:me', created_at: '2026-01-01' };

    function tableQuery(table) {
        const q = {
            _filtered: false,
            select() { return q; },
            eq() { q._filtered = true; return q; },
            limit() { return q; },
            maybeSingle() { return Promise.resolve(resolveOne()); },
            then(res, rej) { return Promise.resolve(resolveList()).then(res, rej); },
        };
        function resolveList() {
            if (table === 'couple_member') {
                state.memberQueries += 1;
                // opts.memberError：模拟 401（token 被拒），这是真实复现里看到的形态
                if (opts.memberError && !state.authed) {
                    return { data: null, error: { message: 'JWT expired', code: 'PGRST303', status: 401 } };
                }
                return { data: state.authed ? [MEMBER] : [], error: null };
            }
            if (table === 'couple_space') {
                return { data: [SPACE], error: null };
            }
            return { data: [], error: null };
        }
        function resolveOne() {
            if (table === 'couple_space') {
                return { data: state.authed ? SPACE : null, error: null };
            }
            return { data: null, error: null };
        }
        return q;
    }

    const cloud = {
        auth: {
            getSession() {
                state.sessionCalls += 1;
                if (opts.sessionNull) return Promise.resolve({ data: null, error: null });
                // 残包态：session 存在但 user.id 为空
                if (opts.sessionNoUserId && !state.authed) {
                    return Promise.resolve({ data: { user: {} }, error: null });
                }
                return Promise.resolve({ data: { user: { id: 'wx:me' } }, error: null });
            },
            refreshSession() {
                state.refreshCalls += 1;
                if (opts.refreshFails) return Promise.resolve({ data: null, error: { message: 'refresh failed' } });
                // 刷新成功后身份恢复
                state.authed = true;
                return Promise.resolve({ data: { user: { id: 'wx:me' } }, error: null });
            },
            signOut() { return Promise.resolve({ error: null }); },
        },
        database: {
            from: tableQuery,
            rpc() { return Promise.resolve({ data: [], error: null }); },
        },
    };
    return { cloud, state };
}

// ── 装载被测模块（把 utils/cloud 换成假实现）──────────────────────────────────
function loadContextWith(cloud) {
    const cloudPath = require.resolve('../utils/cloud.js');
    const ctxPath = require.resolve('../utils/context.js');
    delete require.cache[ctxPath];
    require.cache[cloudPath] = {
        id: cloudPath, filename: cloudPath, loaded: true,
        exports: { cloud: cloud },
    };
    return require(ctxPath);
}

(async () => {
    console.log('\n########## C1 正常：有身份，直接查到成员 ##########');
    {
        const { cloud, state } = makeCloud({});
        const ctx = loadContextWith(cloud);
        const r = await ctx.loadContext();
        ok(!!r.member, '查到成员');
        ok(!!r.space, '查到小家');
        eq(state.refreshCalls, 0, '不该触发 refresh');
        eq(state.memberQueries, 1, '只查一次');
    }

    console.log('\n########## C2 回归 bug：第一次空（anon），refresh 后能查到 ##########');
    {
        // authedInitially=false 模拟 refresh 窗口期：第一次查询不带身份
        const { cloud, state } = makeCloud({ authedInitially: false });
        const ctx = loadContextWith(cloud);
        const r = await ctx.loadContext();
        ok(!!r.member, '修复后能查到成员', JSON.stringify(r));
        ok(!!r.space, '能查到小家');
        eq(state.refreshCalls, 1, '触发了一次 refresh');
        eq(state.memberQueries, 2, '查了两次（第一次空、第二次有）');
    }

    console.log('\n########## C3 真的没加入：两次都空，才判定未绑定 ##########');
    {
        const { cloud, state } = makeCloud({ authedInitially: false, refreshFails: true });
        const ctx = loadContextWith(cloud);
        const r = await ctx.loadContext();
        ok(!r.member, '仍然判定为没加入');
        ok(!r.space, '没有小家');
        eq(r.error, null, '不是错误，是正常未绑定状态');
        eq(state.refreshCalls, 1, '尝试过 refresh');
    }

    console.log('\n########## C4 残包会话（无 user.id）+ refresh 能救 ##########');
    {
        const { cloud, state } = makeCloud({ authedInitially: false, sessionNoUserId: true });
        const ctx = loadContextWith(cloud);
        const r = await ctx.loadContext();
        ok(!!r.member, 'refresh 后拿到完整会话并查到成员', JSON.stringify(r));
        eq(state.refreshCalls, 1, '触发了一次 refresh');
    }

    console.log('\n########## C5 残包会话 + refresh 失败：报错而不是「未绑定」 ##########');
    {
        const { cloud } = makeCloud({ authedInitially: false, sessionNoUserId: true, refreshFails: true });
        const ctx = loadContextWith(cloud);
        const r = await ctx.loadContext();
        ok(!r.member, '没有成员');
        ok(!!r.error, '带 error（登录异常）', JSON.stringify(r.error));
        ok(r.error.message.indexOf('登录') >= 0, '错误文案提到登录', r.error.message);
    }

    console.log('\n########## C6 完全没会话：直接返回空，不调 refresh ##########');    {
        const { cloud, state } = makeCloud({ sessionNull: true });
        const ctx = loadContextWith(cloud);
        const r = await ctx.loadContext();
        eq(r.session, null, 'session 为空');
        eq(state.refreshCalls, 0, '不该调 refresh');
    }

    console.log('\n########## C6b 回归真实现象：查询直接 401，refresh 后恢复 ##########');
    {
        // 生产日志里看到的：couple_member 返回 401（JWT expired），不是 200 []
        const { cloud, state } = makeCloud({ authedInitially: false, memberError: true });
        const ctx = loadContextWith(cloud);
        const r = await ctx.loadContext();
        ok(!!r.member, '401 后 refresh 能查到成员', JSON.stringify(r));
        ok(!!r.space, '能查到小家');
        eq(state.refreshCalls, 1, '触发了一次 refresh');
        eq(r.error, null, '最终没有 error');
    }

    console.log('\n########## C6c 查询 401 且 refresh 也失败：报错，不当未绑定 ##########');
    {
        const { cloud, state } = makeCloud({ authedInitially: false, memberError: true, refreshFails: true });
        const ctx = loadContextWith(cloud);
        const r = await ctx.loadContext();
        ok(!r.member, '没查到成员');
        ok(!!r.error, '带 error（读失败）', JSON.stringify(r.error));
        ok(r.error.message.indexOf('JWT') >= 0 || r.error.message.indexOf('expired') >= 0, 'error 是 401 的原文', r.error.message);
        eq(state.refreshCalls, 1, '尝试过一次 refresh');
    }

    console.log('\n########## C7 不会无限递归 ##########');
    {
        // refresh 每次都「成功」但 session 始终没有 user.id
        const { cloud } = makeCloud({ authedInitially: false, sessionNoUserId: true });
        // 让 refresh 成功后 session 仍然是残包
        let n = 0;
        const origGet = cloud.auth.getSession;
        cloud.auth.getSession = function () { n += 1; return Promise.resolve({ data: { user: {} }, error: null }); };
        const ctx = loadContextWith(cloud);
        const r = await ctx.loadContext();
        ok(n <= 3, 'session 读取次数有限（<=3）', '实际 ' + n);
        ok(!!r.error, '最终返回错误而不是挂死');
    }

    console.log('\n════════════════════════════════════');
    console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('脚本出错', e); process.exit(2); });
