'use strict';
// Agent 通道（M5）的离线测试：mock 上游模型 + mock PostgREST，验证
//   1) 工具调用能被正确解析与执行
//   2) 没有工具调用时直接返回总结
//   3) 工具失败时把错误交给模型而不是 500
//   4) 轮数上限能收敛
//   5) JWT 里的 sub 带 wx: 前缀（数据库里 couple_member.user_id 是这个形状）
process.env.NEWAPI_BASE = 'https://mock.upstream';
process.env.NEWAPI_KEY = 'k';
process.env.NEWAPI_MODELS = 'test-model';
process.env.LLM_TOKEN_SECRET = 'test-token-secret-1234567890';
process.env.WX_APPID = 'wx';
process.env.WX_SECRET = 's';
process.env.PGRST_URL = 'http://mock.pgrst:3000';
process.env.CLOUD_JWT_SECRET = 'test-jwt-secret-1234567890abcdef';

const https = require('https');
const http = require('http');

let upstreamCalls = [];
let dbCalls = [];
let upstreamReplies = [];
let dbReplies = {};

// mock 上游（https）
https.request = function (options, cb) {
    const chunks = [];
    const req = {
        on() { return req; },
        write(c) { chunks.push(Buffer.from(c)); return true; },
        // llm-proxy 是 request.end(payload) 直接把 body 交进来的，不一定先 write
        end(payload) {
            if (payload) chunks.push(Buffer.from(payload));
            const text = Buffer.concat(chunks).toString();
            const parsed = text ? JSON.parse(text) : {};
            upstreamCalls.push(parsed);
            const reply = upstreamReplies.shift() || { choices: [{ message: { role: 'assistant', content: '默认回答' } }] };
            const res = {
                statusCode: 200,
                on(ev, h) {
                    if (ev === 'data') h(Buffer.from(JSON.stringify(reply)));
                    if (ev === 'end') h();
                    return res;
                },
            };
            setTimeout(() => cb(res), 0);
            return req;
        },
        destroy() {},
    };
    return req;
};

// mock PostgREST（http）
http.request = function (options, cb) {
    const chunks = [];
    const req = {
        on() { return req; },
        write(c) { chunks.push(Buffer.from(c)); return true; },
        end(payload) {
            if (payload) chunks.push(Buffer.from(payload));
            const seg = options.path || '';
            const method = options.method || 'GET';
            const text = Buffer.concat(chunks).toString();
            let body = null;
            try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
            dbCalls.push({ path: seg, method: method, auth: options.headers && options.headers.Authorization, body: body });
            let reply = { ok: true };
            const keys = Object.keys(dbReplies);
            for (let i = 0; i < keys.length; i += 1) {
                if (seg.indexOf(keys[i]) >= 0) { reply = dbReplies[keys[i]]; break; }
            }
            const res = {
                statusCode: reply.status || 200,
                on(ev, h) {
                    if (ev === 'data') h(Buffer.from(JSON.stringify(reply.body === undefined ? reply : reply.body)));
                    if (ev === 'end') h();
                    return res;
                },
            };
            setTimeout(() => cb(res), 0);
            return req;
        },
        destroy() {},
    };
    return req;
};

const fs = require('fs');
const path = require('path');
const src = fs.readFileSync('server/llm-proxy.js', 'utf8');
const cut = src.indexOf('checkConfig();');
// 必须把测试副本真实写到 server/ 目录里再 require，否则 './prompts' 解析不到。
// 跑完在 finally 里删掉。
const modPath = path.resolve('server/__agent-test-tmp.js');
fs.writeFileSync(
    modPath,
    src.slice(0, cut) + '\nmodule.exports.__agent = { runAgent, AGENT_TOOLS, TOOL_SPECS, mondayOf, pgTokenFor, guessCategory, pgInsert, currentSpaceId };\n'
);
const A = require(modPath).__agent;
fs.unlinkSync(modPath);


let pass = 0;
let fail = 0;
const ok = (c, m, d) => {
    if (c) { pass += 1; console.log('  PASS ' + m); }
    else { fail += 1; console.log('  FAIL ' + m + (d ? ' -- ' + d : '')); }
};
// 严格相等断言：方便断言 false / 0 / 'ok' 这类值，而不靠 >0 这种恒真条件
const eq0 = (actual, expected, msg) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    ok(a === e, msg, a === e ? '' : '期望 ' + e + '，实际 ' + a);
};

(async () => {
    // 用真实的 pgTokenFor 产出 JWT，而不是假字符串 ——
    // 否则「数据库调用带 JWT」这条断言测的是测试自己的桩，不是被测代码。
    const ctx = { token: A.pgTokenFor('o1'), openid: 'o1' };

    console.log('\n########## A1 工具调用链 ##########');
    upstreamCalls = []; dbCalls = [];
    dbReplies = {
        '/rpc/plan_ensure_week': { body: [{ id: 7, week_start: '2026-11-09', status: 'drafted' }] },
        '/rpc/plan_get': { body: { plan: { id: 7, week_start: '2026-11-09', status: 'drafted' }, items: [] } },
    };
    upstreamReplies = [
        { choices: [{ message: {
            role: 'assistant', content: '',
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_week_plan', arguments: '{"week_offset":0}' } }],
        } }] },
        { choices: [{ message: { role: 'assistant', content: '这周还没排菜，要不要我帮你排？' } }] },
    ];
    const r1 = await A.runAgent(ctx, '这周安排了什么', null);
    ok(r1.ok === true, '返回 ok');
    ok(r1.status === 'ok', 'status = ok（没工具失败）', r1.status);
    ok(r1.steps.length === 1, '执行了 1 个工具', '实际 ' + r1.steps.length);
    ok(r1.steps[0].tool === 'get_week_plan', '工具名对');
    ok(r1.steps[0].ok === true, '工具成功');
    ok(r1.answer.indexOf('没排菜') >= 0, '最终回答来自模型', r1.answer);
    ok(upstreamCalls.length === 2, '两次模型调用', '实际 ' + upstreamCalls.length);
    ok(upstreamCalls[0].tools && upstreamCalls[0].tools.length > 0, '第一次请求带了 tools');
    ok(dbCalls.length >= 2, '至少两次数据库调用', '实际 ' + dbCalls.length);
    ok((dbCalls[0].auth || '').indexOf('Bearer ey') === 0, '数据库调用带 JWT', '实际: ' + String(dbCalls[0].auth).slice(0,30));

    console.log('\n########## A2 无工具调用 ##########');
    upstreamCalls = [];
    upstreamReplies = [{ choices: [{ message: { role: 'assistant', content: '今天深圳多云，不过我只能管你的冰箱和菜单。' } }] }];
    const r2 = await A.runAgent(ctx, '深圳天气怎么样', null);
    ok(r2.steps.length === 0, '没调工具');
    ok(upstreamCalls.length === 1, '只调一次模型');
    ok(r2.answer.indexOf('多云') >= 0, '回答透传');

    console.log('\n########## A3 工具失败不 500 ##########');
    upstreamCalls = []; dbReplies = {};
    dbReplies['/rpc/plan_ensure_week'] = { status: 403, body: { code: '28000', message: '未登录或还没有小家' } };
    upstreamReplies = [
        { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'get_week_plan', arguments: '{}' } }] } }] },
        { choices: [{ message: { role: 'assistant', content: '现在读不到你的菜单，可能是登录过期了，重新进一下小程序。' } }] },
    ];
    const r3 = await A.runAgent(ctx, '这周吃什么', null);
    ok(r3.ok === true, '整次请求没崩');
    ok(r3.steps[0].ok === false, '工具标记为失败');
    ok(r3.steps[0].summary.indexOf('未登录') >= 0, '错误原因传给了上层', r3.steps[0].summary);
    ok(r3.answer.indexOf('登录过期') >= 0, '模型基于错误给出了人话');

    console.log('\n########## A4 轮数上限 ##########');
    upstreamCalls = [];
    dbReplies = {};
    dbReplies['/ingredient'] = { body: [] };
    upstreamReplies = [];
    for (let i = 0; i < 10; i += 1) {
        upstreamReplies.push({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'query_inventory', arguments: '{}' } }] } }] });
    }
    const r4 = await A.runAgent(ctx, '一直查', null);
    ok(r4.truncated === true, '标记为 truncated');
    ok(r4.steps.length > 0, '有步骤记录');
    ok(r4.answer.length > 0, '仍然给了回答');

    console.log('\n########## A5 JWT 里的 sub 带 wx: 前缀 ##########');
    const tok = A.pgTokenFor('oABC123');
    const payload = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString());
    ok(payload.sub === 'wx:oABC123', 'sub = wx:openid', payload.sub);
    ok(payload.role === 'authenticated', 'role = authenticated');
    ok(payload.exp > payload.iat, 'exp 在 iat 之后');

    console.log('\n########## A6 未知工具 ##########');
    upstreamCalls = [];
    upstreamReplies = [
        { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c3', type: 'function', function: { name: 'delete_everything', arguments: '{}' } }] } }] },
        { choices: [{ message: { role: 'assistant', content: '我没有这个能力。' } }] },
    ];
    const r6 = await A.runAgent(ctx, '删掉所有数据', null);
    ok(r6.steps[0].ok === false, '未知工具被拒绝');
    ok(r6.steps[0].summary.indexOf('没有这个工具') >= 0, '说明了原因');

    console.log('\n########## A7 坏 JSON 参数 ##########');
    upstreamCalls = [];
    upstreamReplies = [
        { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c4', type: 'function', function: { name: 'query_inventory', arguments: '{bad json' } }] } }] },
        { choices: [{ message: { role: 'assistant', content: '我理解错了，再说一次？' } }] },
    ];
    const r7 = await A.runAgent(ctx, '查库存', null);
    ok(r7.steps[0].ok === false, '坏参数被拒绝');
    ok(r7.steps[0].summary.indexOf('JSON') >= 0, '说明是 JSON 问题');

    console.log('\n########## A8 工具清单 ##########');
    ok(A.AGENT_TOOLS.length === 12, '12 个工具', '实际 ' + A.AGENT_TOOLS.length);
    const names = A.AGENT_TOOLS.map((t) => t.name).join(',');
    ok(names === 'query_inventory,get_week_plan,add_plan_item,get_shortage,add_to_cart,add_ingredient,query_cart,query_consumption,query_favorites,remove_plan_item,cook_plan_item,confirm_week_plan', '工具名与顺序', names);
    ok(A.TOOL_SPECS.every((s) => s.type === 'function' && s.function.name), 'OpenAI 工具格式');

    // 写工具必须要求 itemId，不能在提示里暗示可以按菜名删
    const rm = A.AGENT_TOOLS.filter((t) => t.name === 'remove_plan_item')[0];
    const rmParams = JSON.stringify(rm.function ? rm.function.parameters : rm.parameters);
    ok(rmParams.indexOf('plan_item_id') >= 0, 'remove_plan_item 要 plan_item_id');
    ok(rmParams.indexOf('title') < 0, 'remove_plan_item 不接受菜名参数');

    console.log('\n########## A9 mondayOf ##########');
    ok(A.mondayOf(new Date(2026, 10, 12), 0) === '2026-11-09', '周四 → 本周一');
    ok(A.mondayOf(new Date(2026, 10, 15), 0) === '2026-11-09', '周日 → 本周一');
    ok(A.mondayOf(new Date(2026, 10, 12), 1) === '2026-11-16', '周四 +1周 → 下周一');

    console.log('\n########## A10 add_ingredient：类别猜测 ##########');
    ok(A.guessCategory('排骨') === '肉蛋', '排骨 → 肉蛋', A.guessCategory('排骨'));
    ok(A.guessCategory('西兰花') === '蔬菜', '西兰花 → 蔬菜', A.guessCategory('西兰花'));
    ok(A.guessCategory('鲈鱼') === '水产', '鲈鱼 → 水产');
    ok(A.guessCategory('豆腐') === '豆制品', '豆腐 → 豆制品');
    ok(A.guessCategory('牛奶') === '乳制品', '牛奶 → 乳制品');
    ok(A.guessCategory('大米') === '主食', '大米 → 主食');
    ok(A.guessCategory('生抽') === '调料', '生抽 → 调料');
    ok(A.guessCategory('苹果') === '水果', '苹果 → 水果');
    ok(A.guessCategory('不知道啥') === '其他', '猜不出 → 其他');
    ok(A.guessCategory('排骨', '水产') === '水产', '显式给的类别优先');

    console.log('\n########## A11 add_ingredient：落库形状 ##########');
    dbCalls = [];
    dbReplies = {
        '/rpc/dish_current_space': { body: 3 },
        '/ingredient': { body: [{ id: 9, name: '排骨', quantity: '2', unit: '斤' }] },
    };
    const tool = A.AGENT_TOOLS.filter((t) => t.name === 'add_ingredient')[0];
    const r11 = await tool.run(ctx, {
        items: [
            { name: '排骨', quantity: '2', unit: '斤', expire_days: 3 },
            { name: '西兰花' },
            { name: '' },
        ],
    });
    ok(r11.ok === true, '工具成功');
    ok(r11.data.count === 1, '只写入返回的行数', '实际 ' + r11.data.count);

    const insertCall = dbCalls.filter((c) => c.method === 'POST' && c.path === '/ingredient')[0];
    ok(!!insertCall, '确实发了 POST /ingredient', JSON.stringify(dbCalls.map((c) => c.method + ' ' + c.path)));
    if (insertCall) {
        ok(insertCall.body.length === 2, '空名字被过滤，剩 2 行', '实际 ' + insertCall.body.length);
        ok(insertCall.body[0].space_id === 3, 'space_id 来自 dish_current_space', String(insertCall.body[0].space_id));
        ok(insertCall.body[0].owner_id === 'wx:o1', 'owner_id 是 wx:<openid>', insertCall.body[0].owner_id);
        ok(insertCall.body[0].category === '肉蛋', '排骨自动归类肉蛋');
        ok(insertCall.body[0].storage === '冷藏', '默认冷藏');
        ok(/^\d{4}-\d{2}-\d{2}$/.test(insertCall.body[0].expire_at || ''), 'expire_days=3 转成了日期', insertCall.body[0].expire_at);
        ok(insertCall.body[1].expire_at === undefined, '没给天数就不写 expire_at');
    }

    console.log('\n########## A12 闲聊不再被限制 ##########');
    upstreamCalls = [];
    upstreamReplies = [{ choices: [{ message: { role: 'assistant', content: '深圳今天多云，26 度左右。不过我查不到实时天气，你自己瞄一眼手机更准。' } }] }];
    const r12 = await A.runAgent(ctx, '今天深圳天气怎么样', null);
    ok(r12.steps.length === 0, '闲聊不调工具');
    ok(r12.answer.indexOf('多云') >= 0, '正常回答了天气');
    ok(r12.answer.indexOf('只能') < 0, '没有「我只能管内冰箱」这种拒绝话', r12.answer);

    console.log('\n########## A13 系统提示词允许闲聊 ##########');
    const sysMsg = upstreamCalls.length > 0 ? upstreamCalls[0].messages[0].content : '';
    ok(sysMsg.indexOf('正常聊天') >= 0, '提示词里明确允许闲聊');
    ok(sysMsg.indexOf('add_ingredient') >= 0, '提示词里提到了 add_ingredient');
    ok(sysMsg.indexOf('不要说"我只管冰箱和菜单"') >= 0, '明确禁止拒绝式回答');

    console.log('\n########## A13b add_ingredient 的 schema 要教模型收中文数词 ##########');
    {
        const t = A.AGENT_TOOLS.filter((x) => x.name === 'add_ingredient')[0];
        const sch = t.parameters.properties.items.items.properties;
        // 提示词示例里只有「2」「半」时，模型会把「一块」「一盒」当成"没说"直接丢掉。
        // 这是线上真实踩过的坑，所以断言里锁住中文数词。
        ok(/一、两块|一、两|半/.test(sch.quantity.description) || /中文数词/.test(sch.quantity.description),
            'quantity 描述里提到中文数词', sch.quantity.description);
        ok(/不要把「块」写进 quantity|不带量词/.test(sch.quantity.description),
            'quantity 要求只放数词、量词归 unit', sch.quantity.description);
        ok(/块|盒|袋/.test(sch.unit.description), 'unit 描述里给了块/盒/袋', sch.unit.description);
        ok(/冷冻/.test(sch.storage.description) && /冷藏/.test(sch.storage.description),
            'storage 描述要求按用户说的存', sch.storage.description);
        ok(/用户说了就一定要传/.test(sch.quantity.description), 'quantity 要求不能丢');
    }

    // ── 以下是 Agent 契约的三条：schema 校验 / 失败重试 / 降级 ───────────────

    console.log('\n########## A14 schema 校验：缺必填参数 ##########');
    upstreamCalls = []; dbCalls = []; dbReplies = {};
    upstreamReplies = [
        // add_plan_item 必填 day_offset / slot / title，这里只给 title
        { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 's1', type: 'function', function: { name: 'add_plan_item', arguments: '{"title":"番茄炒蛋"}' } }] } }] },
        { choices: [{ message: { role: 'assistant', content: '参数不全，我重新问一下。' } }] },
    ];
    const r14 = await A.runAgent(ctx, '排个菜', null);
    ok(r14.steps[0].ok === false, '缺必填被拒');
    ok(r14.steps[0].summary.indexOf('缺少') >= 0, '错误说明缺了什么', r14.steps[0].summary);
    ok(r14.steps[0].summary.indexOf('day_offset') >= 0, '点名了 day_offset');
    eq0(r14.steps[0].retried, false, 'schema 错不重试');
    eq0(dbCalls.length, 0, 'schema 错时一次库都没碰');

    console.log('\n########## A15 schema 校验：类型错 ##########');
    upstreamCalls = []; dbCalls = [];
    upstreamReplies = [
        { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 's2', type: 'function', function: { name: 'add_plan_item', arguments: '{"day_offset":"周三","slot":"dinner","title":"x"}' } }] } }] },
        { choices: [{ message: { role: 'assistant', content: '日子得是数字。' } }] },
    ];
    const r15 = await A.runAgent(ctx, '排菜', null);
    ok(r15.steps[0].ok === false, '类型错被拒');
    ok(r15.steps[0].summary.indexOf('必须是数字') >= 0, '说明是类型问题', r15.steps[0].summary);
    eq0(dbCalls.length, 0, '类型错时一次库都没碰');

    console.log('\n########## A16 schema 校验：枚举越界 ##########');
    upstreamCalls = []; dbCalls = [];
    upstreamReplies = [
        { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 's3', type: 'function', function: { name: 'add_plan_item', arguments: '{"day_offset":0,"slot":"midnight","title":"x"}' } }] } }] },
        { choices: [{ message: { role: 'assistant', content: '餐次只能是三餐之一。' } }] },
    ];
    const r16 = await A.runAgent(ctx, '排菜', null);
    ok(r16.steps[0].ok === false, '枚举越界被拒');
    ok(r16.steps[0].summary.indexOf('只能是') >= 0, '列出了合法值', r16.steps[0].summary);
    ok(r16.steps[0].summary.indexOf('breakfast') >= 0, '枚举值有 breakfast');

    console.log('\n########## A17 合法参数能通过校验 ##########');
    upstreamCalls = []; dbCalls = []; dbReplies = {};
    dbReplies['/rpc/plan_ensure_week'] = { body: [{ id: 5, status: 'drafted', week_start: '2026-11-09' }] };
    dbReplies['/rpc/plan_add_item'] = { body: [{ id: 88, dish_title: '番茄炒蛋' }] };
    upstreamReplies = [
        { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 's4', type: 'function', function: { name: 'add_plan_item', arguments: '{"day_offset":2,"slot":"dinner","title":"番茄炒蛋","used":[]}' } }] } }] },
        { choices: [{ message: { role: 'assistant', content: '排好了。' } }] },
    ];
    const r17 = await A.runAgent(ctx, '周三晚上番茄炒蛋', null);
    ok(r17.steps[0].ok === true, '合法参数通过校验并执行');
    ok(dbCalls.length >= 2, '真的访问了数据库', '实际 ' + dbCalls.length);

    console.log('\n########## A18 失败重试 1 次（执行层失败）##########');
    upstreamCalls = []; dbCalls = [];
    // 第一次查库存 503，第二次成功
    let invCalls = 0;
    dbReplies = {};
    const origHttp = http.request;
    http.request = function (options, cb) {
        const chunks = [];
        const req = {
            on() { return req; },
            write(c) { chunks.push(Buffer.from(c)); return true; },
            end(payload) {
                if (payload) chunks.push(Buffer.from(payload));
                const seg = options.path || '';
                dbCalls.push({ path: seg, method: options.method || 'GET', auth: options.headers && options.headers.Authorization });
                let reply = { ok: true };
                if (seg.indexOf('/ingredient') >= 0) {
                    invCalls += 1;
                    reply = invCalls === 1
                        ? { status: 503, body: { message: '数据库暂时不可用' } }
                        : { body: [] };
                }
                const res = {
                    statusCode: reply.status || 200,
                    on(ev, h) {
                        if (ev === 'data') h(Buffer.from(JSON.stringify(reply.body === undefined ? reply : reply.body)));
                        if (ev === 'end') h();
                        return res;
                    },
                };
                setTimeout(() => cb(res), 0);
                return req;
            },
            destroy() {},
        };
        return req;
    };
    upstreamReplies = [
        { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 's5', type: 'function', function: { name: 'query_inventory', arguments: '{}' } }] } }] },
        { choices: [{ message: { role: 'assistant', content: '冰箱是空的。' } }] },
    ];
    const r18 = await A.runAgent(ctx, '冰箱里有什么', null);
    http.request = origHttp;
    ok(invCalls === 2, '查询执行了两次（第一次失败）', '实际 ' + invCalls);
    ok(r18.steps[0].ok === true, '重试后成功');
    eq0(r18.steps[0].retried, true, '标记了 retried');
    eq0(r18.status, 'ok', '最终 status = ok');

    console.log('\n########## A19 重试也失败 → degraded ##########');
    upstreamCalls = []; dbCalls = [];
    dbReplies = {};
    dbReplies['/rpc/plan_ensure_week'] = { status: 503, body: { message: '数据库暂时不可用' } };
    upstreamReplies = [
        { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 's6', type: 'function', function: { name: 'get_week_plan', arguments: '{}' } }] } }] },
        { choices: [{ message: { role: 'assistant', content: '这周菜单读不出来，数据库有点问题。' } }] },
    ];
    const r19 = await A.runAgent(ctx, '这周吃什么', null);
    ok(r19.steps[0].ok === false, '两次都失败');
    eq0(r19.steps[0].retried, true, '尝试过重试');
    eq0(r19.status, 'degraded', 'status = degraded（有工具失败但给了回答）');
    ok(r19.answer.length > 0, '仍然有回答');

    console.log('\n########## A20 schema 错不重试（对照）##########');
    upstreamCalls = []; dbCalls = [];
    upstreamReplies = [
        { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 's7', type: 'function', function: { name: 'remove_plan_item', arguments: '{}' } }] } }] },
        { choices: [{ message: { role: 'assistant', content: '需要告诉我要删哪道。' } }] },
    ];
    const r20 = await A.runAgent(ctx, '删个菜', null);
    eq0(r20.steps[0].retried, false, 'schema 错没有触发重试');
    eq0(r20.status, 'degraded', 'schema 失败也算 degraded');

    console.log('\n════════════════════════════════════');
    console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('脚本出错', e); process.exit(2); });
