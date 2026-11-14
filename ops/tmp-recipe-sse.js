'use strict';
// 验 SSE 路径 + 客户端 parseDishes/normalizeDishes 能完整吃下变长的 steps。
// 关注两点：
//   1. SSE 首块延迟没退化（不能变成一次性返回）
//   2. 复杂菜的 8-15 步经过真实客户端解析后一条不少
//
// 用法：docker exec llm-proxy node /tmp/recipe-sse.js

const crypto = require('crypto');
const BASE = 'http://127.0.0.1:8787';

function token() {
    const body = Buffer.from(JSON.stringify({ sub: 'sse-probe', exp: Date.now() + 600000 })).toString('base64url');
    const mac = crypto.createHmac('sha256', process.env.LLM_TOKEN_SECRET).update(body).digest('base64url');
    return body + '.' + mac;
}

// 复刻 utils/cooking.js:239 parseDishes 的去围栏 + JSON 截取
function unfence(text) {
    return String(text || '')
        .replace(/^\uFEFF/, '')
        .replace(/^```(?:json|JSON)?\s*/, '')
        .replace(/```\s*$/, '')
        .trim();
}

function parseDishes(text) {
    const t = unfence(text);
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a < 0 || b <= a) return [];
    let body = t.slice(a, b + 1);
    try {
        const obj = JSON.parse(body);
        const list = Array.isArray(obj) ? obj : (obj.dishes || obj.recipes || obj.data || [obj]);
        if (!Array.isArray(list)) return [];
        // 复刻 normalizeDishes 的必要条件：title|name|dish 非空 且 steps 非空
        return list.filter((d) => {
            if (!d || typeof d !== 'object') return false;
            const title = d.title || d.name || d.dish;
            const steps = Array.isArray(d.steps) ? d.steps : [];
            return String(title || '').trim() !== '' && steps.length > 0;
        });
    } catch (e) {
        return [];
    }
}

async function run() {
    const payload = {
        task: 'recipe',
        ingredients: [
            { name: '五花肉', amount: '500g', category: '肉类' },
            { name: '冰糖', amount: '30g', category: '调料' },
            { name: '生姜', amount: '3片', category: '调料' },
            { name: '八角', amount: '2个', category: '调料' },
            { name: '桂皮', amount: '1小块', category: '调料' },
        ],
        count: 1,
        stream: true,
    };

    const started = Date.now();
    const r = await fetch(BASE + '/llm/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() },
        body: JSON.stringify(payload),
    });

    console.log('HTTP ' + r.status + ' content-type=' + r.headers.get('content-type'));

    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let firstChunkAt = 0;
    let chunks = 0;
    let buf = '';

    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!firstChunkAt) firstChunkAt = Date.now() - started;
        chunks++;
        buf += dec.decode(value, { stream: true });
    }
    const total = Date.now() - started;

    console.log('首块 ' + firstChunkAt + 'ms / 共 ' + chunks + ' 块 / 总 ' + total + 'ms');

    // 拼出正文：逐条 data: 取 delta.content
    let content = '';
    let sawDone = false;
    for (const line of buf.split('\n')) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const payloadText = s.slice(5).trim();
        if (payloadText === '[DONE]') { sawDone = true; continue; }
        try {
            const j = JSON.parse(payloadText);
            const ch = j.choices && j.choices[0];
            const d = ch && ch.delta && ch.delta.content;
            if (d) content += d;
        } catch (e) { /* 心跳注释等 */ }
    }

    console.log('[DONE] 收到=' + sawDone + '  正文长度=' + content.length);

    const dishes = parseDishes(content);
    console.log('客户端解析出 ' + dishes.length + ' 道菜');

    let pass = 0;
    let fail = 0;
    function check(name, ok, extra) {
        console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra ? '  ' + extra : ''));
        ok ? pass++ : fail++;
    }

    check('SSE 首块 < 8s（没退化成一次性返回）', firstChunkAt > 0 && firstChunkAt < 8000, firstChunkAt + 'ms');
    check('分块数 > 5（真流式）', chunks > 5, chunks + ' 块');
    check('收到 [DONE]', sawDone);
    check('解析出至少 1 道菜', dishes.length >= 1, dishes.length + ' 道');

    if (dishes.length > 0) {
        const d = dishes[0];
        const steps = d.steps.map((s) => (s && typeof s === 'object' ? (s.text || s.desc || '') : String(s))).filter((x) => x.trim());
        console.log('  《' + (d.title || d.name) + '》 steps=' + steps.length);
        steps.forEach((s, i) => console.log('    ' + (i + 1) + '. ' + s));
        check('复杂菜步数 ≥5（原固定 3 条）', steps.length >= 5, steps.length + ' 步');
        check('有步骤 >30 字（原每步 ≤30）', steps.some((s) => s.length > 30), '最长 ' + Math.max.apply(null, steps.map((s) => s.length)) + ' 字');
    }

    console.log('\npass=' + pass + ' fail=' + fail);
    process.exit(fail === 0 ? 0 : 1);
}

run().catch((e) => {
    console.error('FAILED: ' + e.message);
    process.exit(1);
});
