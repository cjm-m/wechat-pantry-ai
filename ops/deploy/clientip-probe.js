'use strict';
/**
 * clientip-probe.js —— 验证网关取客户端 IP 的顺序没被伪造头绕过
 *
 * 在 llm-proxy 容器里跑（从 127.0.0.1 打，桶独立，不吃真实用户额度）：
 *   docker cp clientip-probe.js llm-proxy:/tmp/ && docker exec llm-proxy node /tmp/clientip-probe.js
 *
 * 背景：NPM 的 proxy.conf 用
 *   proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;   ← 追加语义
 *   proxy_set_header X-Real-IP       $remote_addr;                 ← 覆写
 * 所以 XFF 的第一段完全由客户端决定。旧实现取 split(',')[0] = 攻击者每次换头即可绕限流。
 * 新实现按伪造难度排：cf-connecting-ip > x-real-ip > XFF 最后一段 > socket 地址。
 *
 * 三个断言：
 *   A) 只改 XFF 第一段、最后一段不变 → 仍然被同一个桶限流（证明不再看第一段）
 *   B) 每次换 XFF 最后一段 → 换成不同桶，不被限流（证明它确实在看最后一段，不是干脆忽略 XFF）
 *   C) 带 cf-connecting-ip 时以它为准，覆盖掉任意伪造的 XFF
 */
const http = require('http');

const PORT = 8787;
const HOST = '127.0.0.1';
const MAX = Number(process.env.CLOUD_LOGIN_MAX || 20);
const LOGIN_PATH = '/.cloud/auth/v1/login-wechat';
const KEY = process.env.CLOUD_PUBLISHABLE_KEY || '';

let pass = 0;
let fail = 0;
function check(ok, label, detail) {
    if (ok) { pass += 1; console.log('  PASS  ' + label); }
    else { fail += 1; console.log('  FAIL  ' + label + (detail ? '  ← ' + detail : '')); }
}

function post(path, headers) {
    const body = Buffer.from(JSON.stringify({ code: 'probe-not-a-real-code' }), 'utf8');
    return new Promise((resolve) => {
        const req = http.request({
            host: HOST,
            port: PORT,
            path: path,
            method: 'POST',
            timeout: 15000,
            headers: Object.assign({
                'content-type': 'application/json',
                'content-length': body.length,
                'x-wb-webapp-access-key': KEY
            }, headers)
        }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { text += c; });
            res.on('end', () => {
                let code = '';
                try { code = (JSON.parse(text) || {}).code || ''; } catch { code = ''; }
                resolve({ status: res.statusCode, retryAfter: res.headers['retry-after'] || '', code: code });
            });
        });
        req.on('error', (e) => resolve({ status: 0, retryAfter: '', code: 'ERR:' + (e && e.message) }));
        req.on('timeout', () => { req.destroy(); resolve({ status: 0, retryAfter: '', code: 'TIMEOUT' }); });
        req.end(body);
    });
}

async function main() {
    if (!KEY) {
        console.log('缺 CLOUD_PUBLISHABLE_KEY，无法通过 publishableKey 闸门');
        process.exit(1);
    }

    // ---- A) 第一段每轮都换，最后一段固定：应当仍在同一桶，第 MAX+1 次 429 ----
    console.log('A) 伪造 XFF 第一段（最后一段固定 10.9.9.9）');
    let got429At = 0;
    for (let i = 0; i <= MAX; i += 1) {
        const r = await post(LOGIN_PATH, { 'x-forwarded-for': '1.2.3.' + (i + 1) + ', 10.9.9.9' });
        if (r.status === 429 && !got429At) got429At = i + 1;
    }
    check(got429At === MAX + 1, '第 ' + (MAX + 1) + ' 次被限流（换第一段绕不过去）', '实际第 ' + (got429At || '-') + ' 次');
    const again = await post(LOGIN_PATH, { 'x-forwarded-for': '9.9.9.9, 10.9.9.9' });
    check(again.status === 429 && again.code === 'RATE_LIMITED',
        '再来一次仍是 429 / RATE_LIMITED', 'status=' + again.status + ' code=' + again.code);
    check(String(again.retryAfter || '').length > 0, '仍带 retry-after 头', 'retry-after=' + again.retryAfter);

    // ---- B) 最后一段每次都换：应当是不同桶，不被限流 ----
    console.log('B) 每次换 XFF 最后一段（模拟不同真实来源）');
    let b429 = 0;
    for (let i = 0; i < 5; i += 1) {
        const r = await post(LOGIN_PATH, { 'x-forwarded-for': '1.2.3.4, 10.9.8.' + (i + 1) });
        if (r.status === 429) b429 += 1;
    }
    check(b429 === 0, '5 个不同来源都没被限流（证明仍在按 IP 分桶，不是把 XFF 丢掉）', '429 次数=' + b429);

    // ---- C) cf-connecting-ip 优先，伪造 XFF 无效 ----
    console.log('C) cf-connecting-ip 优先');
    let c429At = 0;
    for (let i = 0; i <= MAX; i += 1) {
        const r = await post(LOGIN_PATH, {
            'cf-connecting-ip': '10.7.7.7',
            'x-forwarded-for': '5.6.7.' + (i + 1) + ', 10.9.8.250'
        });
        if (r.status === 429 && !c429At) c429At = i + 1;
    }
    check(c429At === MAX + 1, '第 ' + (MAX + 1) + ' 次被限流（cf-connecting-ip 压过伪造 XFF）', '实际第 ' + (c429At || '-') + ' 次');

    // ---- D) 不同 cf-connecting-ip 互不影响 ----
    const d = await post(LOGIN_PATH, { 'cf-connecting-ip': '10.7.7.8' });
    check(d.status !== 429, '换一个 cf-connecting-ip 立刻恢复（桶键含 IP）', 'status=' + d.status);

    console.log('\n== ' + (fail === 0 ? '全部通过' : (fail + ' 项失败')) + ' ==');
    process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
    console.log('探针异常：' + (e && e.stack ? e.stack : e));
    process.exit(1);
});
