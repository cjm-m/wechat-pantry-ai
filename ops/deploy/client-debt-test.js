'use strict';
/**
 * 客户端两个小债的离线验证（不需要微信环境）：
 *   1) utils/workbuddy-data-access.js 的 list() 现在会带 limit
 *   2) app.js 的 onShow 复用窗口：30 秒内不重算、超过就重算、resetAuth 立即失效
 *
 * 跑法：node ops/deploy/client-debt-test.js
 * 原理：用一个假的 cloud / 假的 App() 全局把这两个模块装载进来，
 *       只观察它们对外表现出的行为（发了哪些链式调用），不看内部实现。
 */
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
let failed = 0;
function check(cond, label, detail) {
    if (cond) {
        console.log('  PASS  ' + label);
    } else {
        failed += 1;
        console.log('  FAIL  ' + label + (detail ? '  → ' + detail : ''));
    }
}

// ---- 1) data-access 的 limit ---------------------------------------------------
function fakeCloud() {
    const log = [];
    function makeQuery() {
        const q = {};
        const record = (name) => (arg) => { log.push([name, arg]); return q; };
        q.select = record('select');
        q.eq = record('eq');
        q.order = record('order');
        q.limit = record('limit');
        q.insert = record('insert');
        q.update = record('update');
        q.delete = record('delete');
        q.single = () => Promise.resolve({ data: null, error: null });
        q.maybeSingle = () => Promise.resolve({ data: null, error: null });
        q.then = (resolve) => resolve({ data: [], error: null });
        return q;
    }
    return { log, database: { from: (table) => { log.push(['from', table]); return makeQuery(); } } };
}

async function testDataAccessLimit() {
    console.log('== data-access.list() 带 limit ==');
    const { createTableAccess } = require(path.join(ROOT, 'utils', 'workbuddy-data-access.js'));

    const cloud = fakeCloud();
    const access = createTableAccess(cloud, {
        table: 'ingredient',
        columns: ['id', 'name'],
        orderBy: { column: 'created_at', ascending: false },
    });
    await access.list();

    const ops = cloud.log.map(([name]) => name);
    check(ops.indexOf('limit') >= 0, 'list() 调用了 .limit()', ops.join(','));
    const limitArg = (cloud.log.find(([name]) => name === 'limit') || [])[1];
    check(limitArg === 500, 'limit 默认 500', String(limitArg));
    const limitAt = ops.lastIndexOf('limit');
    const orderAt = ops.indexOf('order');
    check(orderAt >= 0 && limitAt > orderAt, '.limit() 排在 .order() 之后（先排序再截断）',
        'order@' + orderAt + ' limit@' + limitAt);

    // 自定义上限要生效
    const cloud2 = fakeCloud();
    const access2 = createTableAccess(cloud2, { table: 'recipe_favorite', columns: ['id'], limit: 50 });
    await access2.list();
    const arg2 = (cloud2.log.find(([name]) => name === 'limit') || [])[1];
    check(arg2 === 50, 'options.limit 覆盖默认值', String(arg2));

    // 只有一张表的 list 有量级风险；确认写路径没被波及
    const cloud3 = fakeCloud();
    const access3 = createTableAccess(cloud3, { table: 'ingredient', columns: ['id'] });
    await access3.create({ name: '鸡蛋' });
    const ops3 = cloud3.log.map(([name]) => name);
    check(ops3.indexOf('insert') >= 0, 'create() 仍然走 insert');
    check(ops3.indexOf('limit') < 0, 'create() 不带 limit（写路径不该被改）', ops3.join(','));
}

// ---- 2) app.js 的上下文复用窗口 --------------------------------------------------
async function testContextReuse() {
    console.log('== app.js onShow 复用窗口 ==');

    // 每个「版本」的 app 模块都要重新装载，因为它是单例。
    // 注意：Date.now 的桩由调用方在整个测试期间保持，这里不再临时替换——
    // 一旦在装载后还原，app.onShow 里读到的就是真实时间，测不出窗口行为。
    function loadApp() {
        for (const key of Object.keys(require.cache)) {
            if (key.indexOf(path.join(ROOT, 'utils')) === 0 || key === path.join(ROOT, 'app.js')) {
                delete require.cache[key];
            }
        }

        let appInstance = null;
        const calls = { loadContext: 0 };
        const noop = { init() {}, subscribeCommitted() {} };

        // 桩掉 app.js 依赖的三个模块
        require.cache[path.join(ROOT, 'utils', 'cloud.js')] = {
            id: path.join(ROOT, 'utils', 'cloud.js'),
            filename: path.join(ROOT, 'utils', 'cloud.js'),
            loaded: true,
            exports: { cloud: { auth: { onAuthStateChange() {} } } },
        };
        require.cache[path.join(ROOT, 'utils', 'context.js')] = {
            id: path.join(ROOT, 'utils', 'context.js'),
            filename: path.join(ROOT, 'utils', 'context.js'),
            loaded: true,
            exports: {
                loadContext() {
                    calls.loadContext += 1;
                    return Promise.resolve({ session: { user: { id: 'wx:test' } }, space: { id: 1 }, meId: 'wx:test', error: null });
                },
            },
        };
        require.cache[path.join(ROOT, 'utils', 'notify-settings.js')] = {
            id: path.join(ROOT, 'utils', 'notify-settings.js'),
            filename: path.join(ROOT, 'utils', 'notify-settings.js'),
            loaded: true,
            exports: { ensureBind() { return { ok: true }; } },
        };
        require.cache[path.join(ROOT, 'utils', 'selection.js')] = {
            id: path.join(ROOT, 'utils', 'selection.js'),
            filename: path.join(ROOT, 'utils', 'selection.js'),
            loaded: true,
            exports: noop,
        };

        global.App = (config) => { appInstance = config; };
        require(path.join(ROOT, 'app.js'));
        global.App = undefined;

        return { app: appInstance, calls };
    }

    const clock = { now: 1000000 };
    const realDateNow = Date.now;
    Date.now = () => clock.now;   // 整个用例期间保持，逻辑结束时还原

    const { app, calls } = loadApp();
    app.onLaunch();

    // 首次取上下文 → 查一次
    await app.ensureContext();
    check(calls.loadContext === 1, '首次 ensureContext 查一次库', String(calls.loadContext));

    // 30 秒内回前台 → onShow 不清缓存
    clock.now += 10 * 1000;
    app.onShow();
    await app.ensureContext();
    check(calls.loadContext === 1, '10 秒后回前台不重查（缓存还在）', String(calls.loadContext));

    // 超过 30 秒 → 清缓存，下次重查
    clock.now += 25 * 1000;   // 累计 35 秒
    app.onShow();
    await app.ensureContext();
    check(calls.loadContext === 2, '35 秒后回前台重查一次', String(calls.loadContext));

    // 显式 resetAuth（登录/退出/建小家后）必须立刻失效，不受窗口限制
    clock.now += 1000;
    app.resetAuth();
    await app.ensureContext();
    check(calls.loadContext === 3, 'resetAuth 后立刻重查（不等窗口）', String(calls.loadContext));

    // 窗口内的重复调用（多 tab 同时 onShow）仍然只发一次：
    // 先显式作废缓存，再同时发两次，应该只多出 1 次请求。
    clock.now += 1000;
    app.resetAuth();
    const a = app.ensureContext();
    const b = app.ensureContext();
    await Promise.all([a, b]);
    check(calls.loadContext === 4, '并发 ensureContext 只发一次', String(calls.loadContext));

    Date.now = realDateNow;
}

(async () => {
    await testDataAccessLimit();
    await testContextReuse();
    console.log(failed === 0 ? '== 全部通过 ==' : '== 有 ' + failed + ' 项失败 ==');
    process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
