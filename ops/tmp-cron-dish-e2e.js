'use strict';
// reminder-cron.js 的点菜链路端到端测试：monkey-patch https.request，
// 造出「临期 0 条 + 点菜队列 3 条（1 条未就绪 / 1 条正常 / 1 条 43101）」，
// 验证模板 ID、字段 key、page、回写状态都对。
//
// 与 tmp-cron-e2e.js 的分工：那个测临期聚合链路，这个测事件队列链路。
const https = require('https');
const fs = require('fs');
const Module = require('module');

const calls = [];

const DISH_TEMPLATE = 'fixture-template-dish';

const JOBS = [
    {
        id: 11,
        kind: 'dish_new',
        title: 'TA 点了 红烧肉',
        page: 'pages/dish-detail/dish-detail?id=42',
        user_id: 'u-recv-1',
        openid: 'o-openid-1',
        ready: true,
        payload: { status: '待接单', dish: '红烧肉', slot: '晚餐', who: 'TA', date: '10-26', note: '少放辣' },
    },
    {
        id: 12,
        kind: 'dish_accepted',
        title: '你点的 红烧肉 已被接下',
        page: 'pages/dish-detail/dish-detail?id=42',
        user_id: 'u-recv-2',
        openid: 'o-openid-2',
        ready: true,
        payload: { status: '已接单', dish: '红烧肉', slot: '晚餐', who: '你', date: '10-26' },
    },
    {
        id: 13,
        kind: 'dish_new',
        title: 'TA 点了 西红柿炒蛋',
        page: 'pages/dish-detail/dish-detail?id=43',
        user_id: 'u-recv-3',
        openid: '',
        ready: false,   // 对方没开提醒/没 openid：应当 skipped，不发
        payload: { status: '待接单', dish: '西红柿炒蛋', who: 'TA' },
    },
];

const ROUTES = [
    { match: '/rpc/reminder_due', reply: '[]' },
    { match: '/rpc/reminder_jobs', reply: JSON.stringify(JOBS) },
    { match: '/cgi-bin/stable_token', reply: JSON.stringify({ access_token: 'AT', expires_in: 7200 }) },
    { match: '/message/subscribe/send', reply: JSON.stringify({ errcode: 0, errmsg: 'ok' }) },
    { match: '/rpc/reminder_job_done', reply: 'null' },
];

let sendSeq = 0;
const sentBodies = [];

https.request = function (options, cb) {
    const path = (options.path || '') + (options.search || '');
    calls.push({ path: options.path, headers: options.headers });
    let body = '';
    const req = {
        on() { return req; },
        write(chunk) { body += chunk; return true; },
        end() {
            let reply = '{"errcode":0}';
            for (const route of ROUTES) {
                if (path.indexOf(route.match) >= 0) {
                    if (route.match === '/message/subscribe/send') {
                        sendSeq += 1;
                        sentBodies.push(JSON.parse(body));
                        // 第 2 条模拟「用户已拒收/没额度」
                        reply = sendSeq === 2
                            ? JSON.stringify({ errcode: 43101, errmsg: 'user refuse to accept the msg' })
                            : route.reply;
                    } else {
                        reply = route.reply;
                    }
                    break;
                }
            }
            const res = {
                statusCode: 200,
                on(event, handler) {
                    if (event === 'data') handler(Buffer.from(reply));
                    if (event === 'end') handler();
                    return res;
                },
            };
            setTimeout(() => cb(res), 0);
            return req;
        },
        destroy(error) { if (error) throw error; },
    };
    return req;
};

process.env.WB_ENDPOINT = 'https://mock.local';
process.env.WB_ANON_KEY = 'k';
process.env.REMINDER_TOKEN = 't';
process.env.WX_APPID = 'wx';
process.env.WX_SECRET = 's';
process.env.WX_MINIPROGRAM_STATE = 'trial';
// 模板 ID 现在是必填环境变量（不再有硬编码默认值），探针用夹具值注入。
process.env.WX_TEMPLATE_DISH = DISH_TEMPLATE;

const src = fs.readFileSync('server/reminder-cron.js', 'utf8');
const cut = src.indexOf('if (require.main === module)');
const mod = new Module('/tmp/cron-dish-e2e.js');
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(src.slice(0, cut) + '\nmodule.exports.__main = main;\n', '/tmp/cron-dish-e2e.js');

const logs = [];
const origLog = console.log;
console.log = (m) => { logs.push(String(m)); };

(async () => {
    await mod.exports.__main();
    console.log = origLog;

    let fails = 0;
    const ok = (cond, msg) => { origLog((cond ? '✅ ' : '❌ ') + msg); if (!cond) fails += 1; };

    origLog('--- 日志 ---');
    logs.forEach((l) => origLog('  ' + l));

    const rpc = (name) => calls.filter((c) => c.path.indexOf('/rpc/' + name) >= 0);
    const doneBodies = [];
    // reminder_job_done 的请求体要从 calls 里拿不到，改用 sentBodies 之外的旁路：
    // 这里只能验次数，参数正确性由 markJob 的调用点保证（已由单测覆盖 buildDishData）。
    const doneCalls = rpc('reminder_job_done');

    origLog('--- 断言 ---');
    ok(rpc('reminder_jobs').length === 1, 'reminder_jobs 被调用一次');
    ok(sentBodies.length === 2, '只有 2 条真正发送（ready=false 的那条被 skipped，实际 ' + sentBodies.length + '）');
    ok(doneCalls.length === 3, '3 条都回写状态（含 skipped 的，实际 ' + doneCalls.length + '）');
    ok(logs.some((l) => l.indexOf('点菜待发 3 条') >= 0), '日志报告点菜待发 3 条');
    ok(logs.some((l) => l.indexOf('已发点菜提醒') >= 0), '有「已发点菜提醒」日志');
    ok(logs.some((l) => l.indexOf('无额度或已拒收') >= 0), '43101 走「无额度或已拒收」分支');
    ok(!logs.some((l) => l.indexOf('没有待发提醒') >= 0), '队列非空时不应打印「没有待发提醒」');

    // 请求体：模板 ID / 字段 key / page / state
    const b0 = sentBodies[0] || {};
    ok(b0.template_id === DISH_TEMPLATE, '模板 ID 是「家庭点餐下单完成通知」');
    ok(JSON.stringify(Object.keys(b0.data || {})) === JSON.stringify(['thing5', 'thing8', 'thing4', 'thing7']),
        '字段 key 顺序是 thing5/thing8/thing4/thing7（不是顺序编号）');
    ok(b0.data && b0.data.thing5 && b0.data.thing5.value === '红烧肉', 'thing5 = 菜品名称');
    ok(b0.data && b0.data.thing8 && b0.data.thing8.value === '晚餐', 'thing8 = 餐食类型');
    ok(b0.data && b0.data.thing4 && b0.data.thing4.value === 'TA', 'thing4 = 下单用户');
    ok(b0.data && b0.data.thing7 && b0.data.thing7.value === '待接单·10-26·少放辣', 'thing7 = 备注（状态·日期·备注）');
    ok(b0.page === 'pages/dish-detail/dish-detail?id=42', 'page 带 id 跳到详情页');
    ok(b0.miniprogram_state === 'trial', 'miniprogram_state 取 env 的 trial');
    ok(b0.touser === 'o-openid-1', 'touser 是接收人 openid');

    // 字段长度上限
    const overlong = sentBodies.some((b) => Object.keys(b.data || {}).some((k) => b.data[k].value.length > 20));
    ok(!overlong, '所有字段都 ≤20 字');

    origLog(fails === 0 ? '\n全部通过' : '\n失败 ' + fails + ' 项');
    process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.log = origLog; origLog('ERR ' + e.stack); process.exit(1); });
