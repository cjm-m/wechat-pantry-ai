'use strict';
// reminder-cron.js 的控制流端到端测试：monkey-patch https.request 造出
// 「2 条待发 + 1 条 43101」的场景，验证发送、回写、错误分流都对。
const https = require('https');
const fs = require('fs');
const Module = require('module');

const calls = [];
let tokenIssued = 0;

const ROUTES = [
    { match: '/rpc/reminder_due', reply: JSON.stringify([
        { user_id: 'u1', openid: 'o-openid-1', item_count: 1, item_names: '牛奶', earliest_days: 0, earliest_date: '2026-10-25', earliest_storage: '冷藏' },
        { user_id: 'u2', openid: 'o-openid-2', item_count: 3, item_names: '鸡蛋、青菜、豆腐', earliest_days: 2, earliest_date: '2026-10-27', earliest_storage: '冷冻' },
        { user_id: 'u3', openid: 'o-openid-3', item_count: 1, item_names: '酸奶', earliest_days: 1, earliest_date: '2026-10-26', earliest_storage: '冷藏' },
    ]) },
    { match: '/cgi-bin/stable_token', reply: JSON.stringify({ access_token: 'TOKEN-' + (++tokenIssued), expires_in: 7200 }) },
    { match: '/message/subscribe/send', reply: JSON.stringify({ errcode: 0, errmsg: 'ok' }) },
    { match: '/rpc/reminder_confirm', reply: 'null' },
];

let sendSeq = 0;
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
                        // 第 3 条模拟「用户已拒收/没额度」
                        reply = sendSeq === 3 ? JSON.stringify({ errcode: 43101, errmsg: 'user refuse to accept the msg' }) : route.reply;
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
process.env.WX_MINIPROGRAM_STATE = 'formal';
// 临期模板 ID 现在是必填环境变量（不再有硬编码默认值），探针用夹具值注入。
process.env.WX_TEMPLATE_EXPIRE = 'fixture-template-expire';

const src = fs.readFileSync('server/reminder-cron.js', 'utf8');
const cut = src.indexOf('if (require.main === module)');
const mod = new Module('/tmp/cron-e2e.js');
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(src.slice(0, cut) + '\nmodule.exports.__main = main;\n', '/tmp/cron-e2e.js');

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
    const sends = calls.filter((c) => c.path.indexOf('/message/subscribe/send') >= 0);
    const confirms = rpc('reminder_confirm');

    ok(rpc('reminder_due').length === 1, 'reminder_due 被调用一次');
    ok(sends.length === 3, '3 条都尝试发送（' + sends.length + '）');
    ok(confirms.length === 3, '3 条都回写了 last_sent_on（含 43101 那条，' + confirms.length + '）');
    ok(calls[0].path.indexOf('/.cloud/database/rest/rpc/') === 0, 'RPC 走 /.cloud/database/rest 前缀');
    ok(calls[0].headers['x-wb-webapp-access-key'] === 'k', '鉴权头是 x-wb-webapp-access-key');
    ok(calls[0].headers.apikey === undefined, '没有残留 Supabase 的 apikey 头');
    ok(logs.some((l) => l.indexOf('待发 3 条') >= 0), '日志报告待发 3 条');
    ok(logs.some((l) => l.indexOf('user=u3') >= 0 && l.indexOf('额度') >= 0), '43101 走「没额度」分支且有日志');
    ok(logs.every((l) => l.indexOf('+08') > 0), '所有日志都带 +08 时区标记');
    origLog(fails === 0 ? '\n全部通过' : '\n失败 ' + fails + ' 项');
    process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.log = origLog; origLog('ERR ' + e.stack); process.exit(1); });
