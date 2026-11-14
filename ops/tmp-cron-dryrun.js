'use strict';
// DRY_RUN 必须「只打印不回写」：如果它在空跑时也调 reminder_confirm，
// 就会把当天的 last_sent_on 写成今天，真到点反而发不出去了。
const https = require('https');
const fs = require('fs');
const Module = require('module');

const calls = [];
https.request = function (options, cb) {
    const path = options.path || '';
    calls.push(path);
    let body = '';
    const req = {
        on() { return req; },
        write(c) { body += c; return true; },
        end() {
            let reply = 'null';
            if (path.indexOf('/rpc/reminder_due') >= 0) {
                reply = JSON.stringify([{ user_id: 'u1', openid: 'o1', item_count: 1, item_names: '牛奶', earliest_days: 0, earliest_date: '2026-10-25', earliest_storage: '冷藏' }]);
            } else if (path.indexOf('/stable_token') >= 0) {
                reply = JSON.stringify({ access_token: 'T' });
            }
            const res = { statusCode: 200, on(e, h) { if (e === 'data') h(Buffer.from(reply)); if (e === 'end') h(); return res; } };
            setTimeout(() => cb(res), 0);
            return req;
        },
        destroy(e) { if (e) throw e; },
    };
    return req;
};

process.env.WB_ENDPOINT = 'https://mock.local';
process.env.WB_ANON_KEY = 'k';
process.env.REMINDER_TOKEN = 't';
process.env.WX_APPID = 'wx';
process.env.WX_SECRET = 's';
process.env.DRY_RUN = '1';
// 临期模板 ID 现在是必填环境变量（不再有硬编码默认值），探针用夹具值注入。
process.env.WX_TEMPLATE_EXPIRE = 'fixture-template-expire';

const src = fs.readFileSync('server/reminder-cron.js', 'utf8');
const cut = src.indexOf('if (require.main === module)');
const mod = new Module('/tmp/dry.js');
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(src.slice(0, cut) + '\nmodule.exports.__main = main;\n', '/tmp/dry.js');

const logs = [];
const orig = console.log;
console.log = (m) => logs.push(String(m));

(async () => {
    await mod.exports.__main();
    console.log = orig;
    let fails = 0;
    const ok = (c, m) => { orig((c ? '✅ ' : '❌ ') + m); if (!c) fails += 1; };
    logs.forEach((l) => orig('  ' + l));
    const sends = calls.filter((p) => p.indexOf('/message/subscribe/send') >= 0);
    const confirms = calls.filter((p) => p.indexOf('/rpc/reminder_confirm') >= 0);
    ok(sends.length === 0, 'DRY_RUN 没有真的发请求（' + sends.length + '）');
    ok(confirms.length === 0, 'DRY_RUN 没有回写 last_sent_on（' + confirms.length + '）');
    ok(logs.some((l) => l.indexOf('DRY_RUN') >= 0), 'DRY_RUN 打印了请求体');
    orig(fails === 0 ? '\n全部通过' : '\n失败 ' + fails + ' 项');
    process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.log = orig; orig('ERR ' + e.stack); process.exit(1); });
