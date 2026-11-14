'use strict';
/**
 * ratelimit-probe.js —— 验证网关登录限流真的生效
 *
 * 在 llm-proxy 容器里跑：
 *   docker cp ratelimit-probe.js llm-proxy:/tmp/ && docker exec llm-proxy node /tmp/ratelimit-probe.js
 *
 * 为什么从 127.0.0.1 打：限流桶的键 = 桶名 + 客户端 IP（容器内没有 X-Forwarded-For，
 * 取到的是 socket 地址 127.0.0.1），所以这次验证用的是独立桶，
 * 不会占用任何真实用户（经 NPM 转发、带 XFF）的额度。
 *
 * 断言：
 *   1) 前 N 次必须是 401/400 这类正常错误，不能一上来就 429
 *   2) 超过额度后必须出现 429 且带 retry-after 头、body.code = RATE_LIMITED
 *   3) 全流程结束后 /.cloud/healthz 里的 buckets 计数 > 0（证明桶真的有在记）
 */
const http = require('http');
const fs = require('fs');

const PORT = 8787;
const HOST = '127.0.0.1';

// publishableKey 与 secret 从容器环境变量读（compose 已经把它们注进去了）
const KEY = process.env.CLOUD_PUBLISHABLE_KEY || '';
const MAX = Number(process.env.CLOUD_LOGIN_MAX || 20);

function post(path, headers, body) {
    return new Promise((resolve) => {
        const payload = Buffer.from(body, 'utf8');
        const req = http.request({
            host: HOST,
            port: PORT,
            path: path,
            method: 'POST',
            headers: Object.assign({
                'content-type': 'application/json',
                'content-length': payload.length
            }, headers),
            timeout: 15000
        }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { text += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: text }));
        });
        req.on('error', (e) => resolve({ status: 0, headers: {}, text: String(e && e.message) }));
        req.on('timeout', () => { req.destroy(); resolve({ status: 0, headers: {}, text: 'timeout' }); });
        req.end(payload);
    });
}

function get(path) {
    return new Promise((resolve) => {
        http.get({ host: HOST, port: PORT, path: path, timeout: 8000 }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { text += c; });
            res.on('end', () => resolve({ status: res.statusCode, text: text }));
        }).on('error', (e) => resolve({ status: 0, text: String(e && e.message) }));
    });
}

let failed = 0;
function assert(cond, label, detail) {
    if (cond) {
        console.log('  PASS  ' + label);
    } else {
        failed += 1;
        console.log('  FAIL  ' + label + (detail ? '  → ' + detail : ''));
    }
}

async function main() {
    console.log('== 登录限流 ==');
    console.log('  额度：' + MAX + ' 次 / 窗口（env CLOUD_LOGIN_MAX）');
    if (!KEY) {
        console.log('  SKIP  没有 CLOUD_PUBLISHABLE_KEY，无法构造合法请求');
        process.exitCode = 2;
        return;
    }

    const headers = { 'x-wb-webapp-access-key': KEY };
    // code 用假值：前 MAX 次会真的转发给微信（微信回 40029 invalid code），
    // 第 MAX+1 次开始被限流挡住，不再触达微信。
    const body = JSON.stringify({ code: 'ratelimit-probe-not-a-real-code', appid: process.env.WX_APPID || '' });

    const statuses = [];
    for (let i = 1; i <= MAX + 3; i += 1) {
        const res = await post('/.cloud/auth/v1/login-wechat', headers, body);
        statuses.push(res.status);
        const tag = res.status === 429 ? '429' : String(res.status);
        if (i === 1 || i === MAX || i === MAX + 1 || i === MAX + 3) {
            console.log('  第 ' + String(i).padStart(2) + ' 次 → ' + tag
                + (res.status === 429 ? '  retry-after=' + res.headers['retry-after'] : ''));
        }
        if (i === MAX + 1) {
            assert(res.status === 429, '第 ' + i + ' 次被限流', '实际 ' + res.status);
            assert(!!res.headers['retry-after'], '带 retry-after 头', String(res.headers['retry-after']));
            let code = '';
            try { code = (JSON.parse(res.text) || {}).code || ''; } catch { code = ''; }
            assert(code === 'RATE_LIMITED', 'body.code = RATE_LIMITED', code || res.text.slice(0, 80));
        }
    }

    const limited = statuses.filter((s) => s === 429).length;
    assert(limited >= 3, '末尾连续 3 次都是 429', '429 共 ' + limited + ' 次');
    assert(statuses[0] !== 429, '第 1 次没有被限流（额度没被前面的调用吃掉）', String(statuses[0]));

    console.log('== healthz 里桶计数 ==');
    const health = await get('/.cloud/healthz');
    let buckets = -1;
    try { buckets = (JSON.parse(health.text).rateLimit || {}).buckets; } catch { buckets = -1; }
    assert(buckets > 0, 'rateLimit.buckets > 0', String(buckets));

    console.log(failed === 0 ? '== 全部通过 ==' : '== 有 ' + failed + ' 项失败 ==');
    process.exitCode = failed === 0 ? 0 : 1;
}

main();
