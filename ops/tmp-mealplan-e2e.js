'use strict';
// N9 四表闭环的单元测试 + 真库联调脚本。
//
// 两种模式：
//   node ops/tmp-mealplan-e2e.js            纯本地：mock cloud.database.rpc，测客户端逻辑与打分
//   node ops/tmp-mealplan-e2e.js --live     真库：直连 PostgREST 跑同样用例（需要环境变量）
//
// 为什么要 mock 之外还要 live：mock 只能证明「客户端把参数拼对了」，
// 证明不了 PostgREST 那边函数签名能对上、JWT 里的 sub 能被 auth.uid() 读出来。
// 只有 live 能证明整条链路。
//
// live 模式需要的环境变量：
//   MP_ENDPOINT   https://your-domain.example.com
//   MP_ANON_KEY   发布的 publishableKey
//   MP_TOKEN      一个有效 access_token（从开发者工具里复制）
//   或者 MP_OPENID 让脚本自己走 /llm/login？不行——那需要小程序 code，脚本拿不到。
//   所以 live 模式只能复用现成 token。

const Module = require('module');
const path = require('path');

const LIVE = process.argv.indexOf('--live') >= 0;

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, msg, detail) {
    if (cond) {
        pass += 1;
        console.log('  ✅ ' + msg);
    } else {
        fail += 1;
        failures.push(msg + (detail ? ' —— ' + detail : ''));
        console.log('  ❌ ' + msg + (detail ? ' —— ' + detail : ''));
    }
}

function eq(actual, expected, msg) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    ok(a === e, msg, a === e ? '' : '期望 ' + e + '，实际 ' + a);
}

// ══════════════════════════════════════════════════════════════════════════════
// 一、纯函数测试（不需要网络）
// ══════════════════════════════════════════════════════════════════════════════

// 加载打分模块前先桩掉 cloud —— 它 require 了 miniprogram SDK，Node 里加载不了。
function stubCloud() {
    const cloudPath = require.resolve('../utils/cloud.js');
    require.cache[cloudPath] = {
        id: cloudPath,
        filename: cloudPath,
        loaded: true,
        exports: {
            cloud: {
                database: {
                    rpc: function () {
                        return Promise.resolve({ data: [], error: null });
                    },
                    from: function () {
                        const q = {
                            select: function () { return q; },
                            eq: function () { return q; },
                            order: function () { return q; },
                            limit: function () { return q; },
                            maybeSingle: function () { return Promise.resolve({ data: null, error: null }); },
                            then: function (r) { return Promise.resolve({ data: [], error: null }).then(r); },
                        };
                        return q;
                    },
                },
            },
        },
    };
}

function runPure() {
    console.log('\n########## P1 打分：临期因子 ##########');
    const rec = require('../utils/meal-plan-recommend.js');

    const today = new Date(2026, 10, 12); // 2026-11-12

    eq(rec.daysUntil('2026-11-12', today), 0, 'daysUntil 当天 = 0');
    eq(rec.daysUntil('2026-11-15', today), 3, 'daysUntil 三天后 = 3');
    eq(rec.daysUntil('', today), null, 'daysUntil 空 = null（无保质期）');

    const inv = [
        { name: '豆腐', expireAt: '2026-11-13' },
        { name: '鸡蛋', expireAt: '2026-12-30' },
        { name: '盐', expireAt: '' },
    ];

    const e1 = rec.expireScore([{ name: '豆腐', fromFridge: true }], inv, today);
    ok(e1.score >= 0.99, '明天到期的豆腐 → 临期分接近 1.0', '实际 ' + e1.score);
    eq(e1.name, '豆腐', '临期分记下了是哪个食材');

    const e2 = rec.expireScore([{ name: '鸡蛋', fromFridge: true }], inv, today);
    eq(e2.score, 0, '还有 48 天的鸡蛋 → 临期分 0');

    const e3 = rec.expireScore([{ name: '盐', fromFridge: false }], inv, today);
    eq(e3.score, 0, '调料（fromFridge=false）不参与临期分');

    console.log('\n########## P2 打分：覆盖因子 ##########');
    const c1 = rec.coverScore(
        [
            { name: '鸡蛋', fromFridge: true },
            { name: '番茄', fromFridge: true },
            { name: '盐', fromFridge: false },
        ],
        [{ name: '鸡蛋' }, { name: '番茄' }]
    );
    eq(c1.score, 1, '两样主料都有 → 覆盖分 1.0');
    eq(c1.total, 2, '调料不计入总数');

    const c2 = rec.coverScore(
        [{ name: '鸡蛋', fromFridge: true }, { name: '猪肉', fromFridge: true }],
        [{ name: '鸡蛋' }]
    );
    eq(c2.score, 0.5, '两样缺一样 → 覆盖分 0.5');

    // 关键语义：库存「鸡蛋面」对需求「鸡蛋」是 maybe，算半分而不是满分
    const c3 = rec.coverScore(
        [{ name: '鸡蛋', fromFridge: true }],
        [{ name: '鸡蛋面' }]
    );
    eq(c3.score, 0.5, '库存「鸡蛋面」对需求「鸡蛋」→ maybe 半分（不是满分）');

    console.log('\n########## P3 打分：多样性因子 ##########');
    const v1 = rec.varietyScore(
        [{ name: '鸡蛋', fromFridge: true }, { name: '番茄', fromFridge: true }],
        []
    );
    eq(v1.score, 1, '本周还没排菜 → 多样性满分');

    const v2 = rec.varietyScore(
        [{ name: '鸡蛋', fromFridge: true }, { name: '番茄', fromFridge: true }],
        [{ title: '番茄炒蛋', used: [{ name: '番茄', fromFridge: true }, { name: '鸡蛋', fromFridge: true }] }]
    );
    eq(v2.score, 0, '和已排的菜完全同料 → 多样性 0');
    eq(v2.overlapWith, '番茄炒蛋', '记下了和哪道菜重合');

    const v3 = rec.varietyScore(
        [{ name: '鸡蛋', fromFridge: true }, { name: '番茄', fromFridge: true }],
        [{ title: '西红柿蛋汤', used: [{ name: '鸡蛋', fromFridge: true }] }]
    );
    ok(v3.score > 0 && v3.score < 1, '重合一半 → 多样性在 0..1 之间', '实际 ' + v3.score);

    console.log('\n########## P4 打分：忌口一票否决 ##########');
    const candidates = [
        { title: '虾仁炒蛋', used: [{ name: '虾仁', fromFridge: true }, { name: '鸡蛋', fromFridge: true }] },
        { title: '番茄炒蛋', used: [{ name: '番茄', fromFridge: true }, { name: '鸡蛋', fromFridge: true }] },
        { title: '蒜蓉西兰花', used: [{ name: '西兰花', fromFridge: true }] },
    ];
    const withAvoid = rec.scoreDishes({
        candidates: candidates,
        inventory: [],
        planned: [],
        prefs: { avoid: ['虾'] },
        today: today,
    });
    eq(withAvoid.length, 2, '忌口「虾」→ 只剩 2 道');
    ok(!withAvoid.some((x) => x.candidate.title === '虾仁炒蛋'), '虾仁炒蛋被整条剔除（不是低分）');

    const noAvoid = rec.scoreDishes({ candidates: candidates, inventory: [], planned: [], prefs: {}, today: today });
    eq(noAvoid.length, 3, '不忌口 → 3 道都在');

    console.log('\n########## P5 打分：排序与可解释 ##########');
    const ranked = rec.scoreDishes({
        candidates: [
            { title: '青椒肉丝', used: [{ name: '青椒', fromFridge: true }, { name: '猪肉', fromFridge: true }] },
            { title: '豆腐汤', used: [{ name: '豆腐', fromFridge: true }] },
            { title: '白粥', used: [{ name: '大米', fromFridge: true }] },
        ],
        inventory: [
            { name: '豆腐', expireAt: '2026-11-13' },  // 明天到期
            { name: '青椒', expireAt: '2026-11-30' },
            { name: '猪肉', expireAt: '2026-11-30' },
        ],
        planned: [],
        prefs: {},
        today: today,
    });
    eq(ranked[0].candidate.title, '豆腐汤', '含明日期食材的菜排第一（A6）');
    ok(ranked[0].factors.expire >= 0.99, '第一名的 expire 因子接近 1.0', '实际 ' + ranked[0].factors.expire);
    ok(typeof ranked[0].reason === 'string' && ranked[0].reason.length > 0, '每条都有推荐理由');
    ok(ranked[0].reason.indexOf('豆腐') >= 0, '理由里点名了临期食材', ranked[0].reason);
    ok(ranked.every((x) => x.score >= 0 && x.score <= 1), '所有分数都在 0..1');
    ok(ranked[0].score >= ranked[1].score, '按分数降序');

    console.log('\n########## P6 日期工具 ##########');
    const mp = require('../utils/meal-plan.js');
    // 2026-11-12 是周四
    const thursday = new Date(2026, 10, 12);
    eq(mp.ymd(mp.toMonday(thursday)), '2026-11-09', '周四 → 本周一 2026-11-09');
    eq(mp.ymd(mp.toMonday(new Date(2026, 10, 9))), '2026-11-09', '周一 → 它自己');
    eq(mp.ymd(mp.toMonday(new Date(2026, 10, 15))), '2026-11-09', '周日 → 本周一（不是下周一）');
    eq(mp.ymd(mp.addDays(new Date(2026, 10, 9), 6)), '2026-11-15', '周一 +6 = 周日');
    eq(mp.weekLabel(new Date(2026, 10, 9)), '11/9 - 11/15', '周区间文案');

    console.log('\n########## P7 buildGrid 布局 ##########');
    const grid = mp.buildGrid(
        [
            { id: '1', dayOffset: 0, slot: 'dinner', title: '番茄炒蛋', status: 'planned', used: [] },
            { id: '2', dayOffset: 0, slot: 'lunch', title: '面条', status: 'cooked', used: [] },
        ],
        new Date(2026, 10, 9)
    );
    eq(grid.length, 7, '7 天');
    eq(grid[0].label, '一', '第一天是周一');
    eq(grid[6].label, '日', '第七天是周日');
    eq(grid[0].meals.length, 3, '每天 3 餐');
    eq(grid[0].meals[1].item.title, '面条', '午餐位放对了');
    eq(grid[0].meals[2].item.title, '番茄炒蛋', '晚餐位放对了');
    eq(grid[1].meals[0].item, null, '空位是 null');

    console.log('\n########## P8 缺料分组 ##########');
    const grouped = mp.groupShortage([
        { name: '蒜', level: 'miss' },
        { name: '青椒', level: 'maybe' },
        { name: '鸡蛋', level: 'have' },
    ]);
    eq(grouped.miss.length, 1, 'miss 1 项');
    eq(grouped.maybe.length, 1, 'maybe 1 项（默认不勾选）');
    eq(grouped.have.length, 1, 'have 1 项');

    console.log('\n########## P9 行映射：snake_case → camelCase ##########');
    const mapped = mp.mapItem({
        id: 7, plan_id: 3, day_offset: 2, meal_slot: 'lunch', dish_title: '番茄炒蛋',
        used: [{ name: '番茄', amount: '2 个', from_fridge: true }, { name: '盐', amount: '', from_fridge: false }],
        servings: 2, status: 'planned', recipe_id: null, cooked_at: null,
    });
    eq(mapped.id, '7', 'id 转成字符串（小程序 data 里数字 id 会丢精度风险）');
    eq(mapped.slotLabel, '午餐', '餐次有中文标签');
    eq(mapped.used[0].fromFridge, true, 'from_fridge → fromFridge');
    eq(mapped.used[1].fromFridge, false, '调料 fromFridge=false');
    eq(mapped.canCook, true, 'planned 可做');
    eq(mapped.canRemove, true, 'planned 可删');
}

// ══════════════════════════════════════════════════════════════════════════════
// 二、mock RPC：客户端链路（A1–A12 的客户端侧）
// ══════════════════════════════════════════════════════════════════════════════

function runMocked() {
    console.log('\n########## M1 mock RPC：参数拼装正确 ##########');

    const calls = [];
    let seq = 100;
    const state = {
        plan: { id: 1, week_start: '2026-11-09', status: 'drafted', shortage: [], shortage_at: null, confirmed_at: null, created_at: '' },
        items: [],
    };

    const cloudPath = require.resolve('../utils/cloud.js');
    require.cache[cloudPath] = {
        id: cloudPath,
        filename: cloudPath,
        loaded: true,
        exports: {
            cloud: {
                database: {
                    rpc: function (name, params) {
                        calls.push({ name: name, params: params });
                        if (name === 'plan_ensure_week') {
                            return Promise.resolve({ data: [state.plan], error: null });
                        }
                        if (name === 'plan_get') {
                            return Promise.resolve({
                                data: { plan: state.plan, items: state.items },
                                error: null,
                            });
                        }
                        if (name === 'plan_add_item') {
                            seq += 1;
                            const row = {
                                id: seq,
                                plan_id: params.p_plan_id,
                                day_offset: params.p_day_offset,
                                meal_slot: params.p_slot,
                                dish_title: params.p_title,
                                used: params.p_used || [],
                                servings: 2,
                                status: 'planned',
                                recipe_id: params.p_recipe_id || null,
                                cooked_at: null,
                            };
                            state.items.push(row);
                            return Promise.resolve({ data: [row], error: null });
                        }
                        if (name === 'plan_remove_item') {
                            state.items = state.items.filter((x) => String(x.id) !== String(params.p_item_id));
                            return Promise.resolve({ data: true, error: null });
                        }
                        if (name === 'plan_confirm' || name === 'plan_shortage' || name === 'plan_cancel') {
                            if (name === 'plan_confirm') state.plan.status = 'confirmed';
                            if (name === 'plan_cancel') state.plan.status = 'cancelled';
                            return Promise.resolve({ data: [state.plan], error: null });
                        }
                        if (name === 'plan_cook_item') {
                            return Promise.resolve({
                                data: { ok: true, dup: false, item: state.items[0] || {}, removed: [] },
                                error: null,
                            });
                        }
                        if (name === 'dish_consume') {
                            return Promise.resolve({ data: { ok: true, dup: false, removed: [] }, error: null });
                        }
                        return Promise.resolve({ data: null, error: { message: '未知 RPC ' + name } });
                    },
                },
            },
        },
    };

    // 重新加载被测模块（清掉之前 require 的缓存）
    delete require.cache[require.resolve('../utils/meal-plan.js')];
    const mp = require('../utils/meal-plan.js');

    return (async function () {
        mp.setScope(1, '我');

        // ensureWeek：必须传字符串日期，不能传 Date
        const ensured = await mp.ensureWeek('2026-11-12');
        ok(!ensured.error && ensured.plan, 'ensureWeek 成功');
        eq(calls[calls.length - 1].params.p_day, '2026-11-12', 'ensureWeek 传的是 YYYY-MM-DD 字符串');

        // addItem：参数名必须与 SQL 函数签名一致
        const added = await mp.addItem({
            planId: 1, dayOffset: 2, slot: 'dinner', title: '番茄炒蛋',
            used: [
                { name: '番茄', amount: '2 个', fromFridge: true },
                { name: '盐', amount: '', fromFridge: false },
            ],
        });
        ok(!added.error && added.item, 'addItem 成功');
        const addCall = calls.filter((c) => c.name === 'plan_add_item').pop();
        eq(addCall.params.p_day_offset, 2, 'p_day_offset 是数字 2（不是字符串）');
        eq(addCall.params.p_slot, 'dinner', 'p_slot 对');
        eq(addCall.params.p_title, '番茄炒蛋', 'p_title 对');
        eq(addCall.params.p_used[0].from_fridge, true, 'used 里用 from_fridge（snake_case），不是 fromFridge');
        ok(!('p_recipe_id' in addCall.params), '没有 recipeId 时不发 p_recipe_id');
        ok(!('p_idempotency_key' in addCall.params), 'addItem 不发幂等键（服务端生成）');

        // cookItem：绝不发幂等键
        await mp.cookItem({
            itemId: 101,
            consume: [{ ingredientId: 5, action: 'removed' }, { ingredientId: 6, action: 'kept' }],
        });
        const cookCall = calls.filter((c) => c.name === 'plan_cook_item').pop();
        eq(cookCall.params.p_item_id, 101, 'cookItem 传 p_item_id');
        eq(cookCall.params.p_consume[0], { ingredient_id: 5, action: 'removed' }, 'consume 转成 snake_case');
        eq(cookCall.params.p_consume[1].action, 'kept', 'kept 保留');
        ok(Object.keys(cookCall.params).length === 2, 'cookItem 只发 p_item_id + p_consume（不传幂等键）',
            JSON.stringify(Object.keys(cookCall.params)));

        // get：返回 plan + items
        const detail = await mp.get(1);
        ok(!detail.error && detail.plan && detail.items.length === 1, 'get 返回 plan + 1 个 item');

        // removeItem
        const removed = await mp.removeItem(101);
        ok(!removed.error && removed.removed === true, 'removeItem 成功');

        // confirm / cancel
        const confirmed = await mp.confirm(1);
        eq(confirmed.plan.status, 'confirmed', 'confirm 后状态是 confirmed');
        const cancelled = await mp.cancel(1);
        eq(cancelled.plan.status, 'cancelled', 'cancel 后状态是 cancelled');

        // dish_consume
        const dc = await mp.dishConsume(42, [{ ingredientId: 9, action: 'removed' }]);
        ok(!dc.error && dc.result && dc.result.ok, 'dishConsume 成功');
        const dcCall = calls.filter((c) => c.name === 'dish_consume').pop();
        eq(dcCall.params.p_dish_id, 42, 'dish_consume 传 p_dish_id');
        ok(!('p_idempotency_key' in dcCall.params), 'dish_consume 也不传幂等键');

        console.log('\n########## M2 mock：错误处理 ##########');
        // schema cache 友好化
        const badCloud = {
            database: {
                rpc: function () {
                    return Promise.resolve({
                        data: null,
                        error: { message: 'PGRST202: Could not find the function public.plan_get' },
                    });
                },
            },
        };
        require.cache[cloudPath] = {
            id: cloudPath, filename: cloudPath, loaded: true,
            exports: { cloud: badCloud },
        };
        delete require.cache[require.resolve('../utils/meal-plan.js')];
        const mp2 = require('../utils/meal-plan.js');
        const err = await mp2.get(1);
        ok(err.error && err.error.message.indexOf('还没部署好') >= 0,
            'PGRST202 被翻译成「还没部署好」', err.error && err.error.message);
    }());
}

// ══════════════════════════════════════════════════════════════════════════════
// 三、live 模式：真库联调
// ══════════════════════════════════════════════════════════════════════════════

async function runLive() {
    console.log('\n########## L1 真库联调 ##########');

    const endpoint = process.env.MP_ENDPOINT;
    const anonKey = process.env.MP_ANON_KEY;
    const token = process.env.MP_TOKEN;

    if (!endpoint || !anonKey || !token) {
        console.log('  ⏭  跳过：需要 MP_ENDPOINT / MP_ANON_KEY / MP_TOKEN');
        return;
    }

    async function rpc(name, params) {
        const url = endpoint + '/.cloud/database/rest/rpc/' + name;
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-wb-webapp-access-key': anonKey,
                'Authorization': 'Bearer ' + token,
            },
            body: JSON.stringify(params || {}),
        });
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch (e) { data = text; }
        return { status: res.status, data: data };
    }

    const today = new Date();
    const pad = (n) => (n < 10 ? '0' + n : String(n));
    const day = today.getFullYear() + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate());

    const ensured = await rpc('plan_ensure_week', { p_day: day });
    ok(ensured.status === 200, 'plan_ensure_week 返回 200', 'status=' + ensured.status + ' body=' + JSON.stringify(ensured.data).slice(0, 200));
    if (ensured.status !== 200) return;

    const plan = Array.isArray(ensured.data) ? ensured.data[0] : ensured.data;
    ok(!!plan && !!plan.id, '拿到了计划 id', JSON.stringify(plan).slice(0, 200));
    if (!plan) return;

    const planId = plan.id;
    const got = await rpc('plan_get', { p_plan_id: planId });
    ok(got.status === 200, 'plan_get 返回 200');
    ok(got.data && got.data.plan, 'plan_get 返回 {plan, items}');

    const slot = 'dinner';
    const added = await rpc('plan_add_item', {
        p_plan_id: planId, p_day_offset: 0, p_slot: slot, p_title: '联调测试菜',
        p_used: [{ name: '鸡蛋', amount: '2 个', from_fridge: true }],
    });
    ok(added.status === 200, 'plan_add_item 返回 200（证明 int 参数可用）',
        'status=' + added.status + ' body=' + JSON.stringify(added.data).slice(0, 200));

    const shortage = await rpc('plan_shortage', { p_plan_id: planId });
    ok(shortage.status === 200, 'plan_shortage 返回 200');

    // 清理：删掉刚加的格子
    const addedRow = Array.isArray(added.data) ? added.data[0] : added.data;
    if (addedRow && addedRow.id) {
        const del = await rpc('plan_remove_item', { p_item_id: addedRow.id });
        ok(del.status === 200, 'plan_remove_item 返回 200（清理成功）');
    }
}

// ══════════════════════════════════════════════════════════════════════════════

(async function main() {
    stubCloud();

    runPure();

    await runMocked();

    if (LIVE) {
        await runLive();
    } else {
        console.log('\n（跳过真库联调；加 --live 和环境变量可跑）');
    }

    console.log('\n════════════════════════════════════');
    console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    if (fail > 0) {
        console.log('\n失败项：');
        failures.forEach((f) => console.log('  - ' + f));
        process.exit(1);
    }
    console.log('全部通过 ✅');
}()).catch((error) => {
    console.error('脚本自身出错：', error);
    process.exit(2);
});
