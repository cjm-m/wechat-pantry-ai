'use strict';
/**
 * gw-probe.js —— 在 gateway 容器内部自测三条链路
 *   A. /.cloud/healthz            gateway 自己活着
 *   B. /llm/healthz               原 llm-proxy 仍可达（同进程 8788 + 透明转发）
 *   C. /.cloud/database/rest/*    gateway → postgrest → postgres，带真 JWT
 * 用法：docker cp gw-probe.js <容器>:/tmp/ && docker exec <容器> node /tmp/gw-probe.js
 */
const crypto = require('crypto');
const BASE = 'http://127.0.0.1:8787';
const KEY = process.env.CLOUD_PUBLISHABLE_KEY || '';
// 客户端 SDK 每个请求都带 x-wb-webapp-access-key，gateway 用它挡掉白瞟
const KEYH = KEY ? { 'x-wb-webapp-access-key': KEY } : {};
// 每次跑用一个专属的探针 IP：网关按 client IP 分桶，探针不该和真实用户、
// 也不该和上一次的探针共用额度（否则连跑两次就会把自己的桶打满，D 项假失败）。
const PROBE_IP = process.env.PROBE_IP || ('10.255.255.' + (1 + Math.floor(Math.random() * 250)));
const IPH = { 'cf-connecting-ip': PROBE_IP };

function b64(o) { return Buffer.from(JSON.stringify(o)).toString('base64url'); }
function sign(payload, secret) {
    const h = b64({ alg: 'HS256', typ: 'JWT' });
    const p = b64(payload);
    const sig = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
    return `${h}.${p}.${sig}`;
}

(async () => {
    const out = [];
    const rec = (name, ok, detail) => out.push({ name, ok, detail });

    try {
        const r = await fetch(`${BASE}/.cloud/healthz`);
        const t = await r.text();
        rec('A gateway healthz', r.status === 200, `${r.status} ${t.slice(0, 160)}`);
    } catch (e) { rec('A gateway healthz', false, String(e)); }

    try {
        const r = await fetch(`${BASE}/llm/healthz`);
        const t = await r.text();
        rec('B llm-proxy 透传', r.status === 200, `${r.status} ${t.slice(0, 160)}`);
    } catch (e) { rec('B llm-proxy 透传', false, String(e)); }

    const secret = process.env.CLOUD_JWT_SECRET || '';
    const jwt = sign({ sub: 'wx:probe', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 300 }, secret);
    try {
        const r = await fetch(`${BASE}/.cloud/database/rest/couple_member`, {
            headers: { ...KEYH, ...IPH, Authorization: `Bearer ${jwt}`, Accept: 'application/json' },
        });
        const t = await r.text();
        rec('C1 DB 代理(JWT)', r.status === 200, `${r.status} ${t.slice(0, 160)}`);
    } catch (e) { rec('C1 DB 代理(JWT)', false, String(e)); }

    try {
        const r = await fetch(`${BASE}/.cloud/database/rest/couple_member`, {
            headers: { ...KEYH, ...IPH, Accept: 'application/json' },
        });
        const t = await r.text();
        rec('C2 DB 代理(匿名必须拿不到数据)', r.status === 401 || t === '[]', `${r.status} ${t.slice(0, 160)}`);
    } catch (e) { rec('C2 DB 代理(匿名)', false, String(e)); }

    try {
        const r = await fetch(`${BASE}/.cloud/auth/v1/login-wechat`, {
            method: 'POST',
            headers: { ...KEYH, ...IPH, 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        const t = await r.text();
        rec('D 缺 code 应 400', r.status === 400, `${r.status} ${t.slice(0, 160)}`);
    } catch (e) { rec('D 缺 code 应 400', false, String(e)); }

    try {
        const r = await fetch(`${BASE}/.cloud/auth/v1/verification`, { method: 'POST', headers: { ...KEYH, ...IPH } });
        rec('E 邮箱登录应 501', r.status === 501, `${r.status}`);
    } catch (e) { rec('E 邮箱登录应 501', false, String(e)); }

    let bad = 0;
    for (const r of out) {
        if (!r.ok) bad += 1;
        console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ->  ${r.detail}`);
    }
    console.log(`探针 IP = ${PROBE_IP}`);
    console.log(bad === 0 ? 'ALL_PASS' : `FAILED=${bad}`);
    process.exit(bad === 0 ? 0 : 1);
})();