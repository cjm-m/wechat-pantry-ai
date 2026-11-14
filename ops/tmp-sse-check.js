'use strict';
// SSE 通道 + 真实任务验收：客户端默认 stream:true，必须确认没有退化成一次性返回。
const crypto = require('crypto');
const fs = require('fs');
const BASE = 'http://127.0.0.1:8787';
const body = Buffer.from(JSON.stringify({ sub: 'e2e-probe', exp: Date.now() + 600000 })).toString('base64url');
const TK = body + '.' + crypto.createHmac('sha256', process.env.LLM_TOKEN_SECRET).update(body).digest('base64url');
const IMG = fs.readFileSync('/tmp/fridge2.b64', 'utf8').trim();

async function sse(name, payload) {
    const t0 = Date.now();
    const r = await fetch(BASE + '/llm/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TK },
        body: JSON.stringify(payload),
    });
    if (r.status !== 200) { console.log(name.padEnd(30) + '❌ HTTP ' + r.status); return; }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let first = 0, chunks = 0, total = 0, last = 0, buf = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const now = Date.now();
        if (first === 0) first = now - t0;
        last = now - t0;
        chunks += 1;
        buf += dec.decode(value, { stream: true });
        total += value.length;
    }
    const doneMark = buf.indexOf('[DONE]') >= 0;
    const pings = (buf.match(/: ping/g) || []).length;
    console.log(name.padEnd(30) + '✅ 首块 ' + first + 'ms  末块 ' + last + 'ms  ' + chunks + ' 块  ' + total + 'B  [DONE]=' + doneMark + '  ping=' + pings);
    return buf;
}

(async () => {
    // 1. 识图流式
    await sse('识图 · 流式', { task: 'vision', image: IMG, mime: 'image/jpeg' });
    // 2. 菜谱（默认文本模型 deepseek-v4），这是最高频任务
    const rbuf = await sse('菜谱 · 流式', {
        task: 'recipe',
        count: 2,
        ingredients: [
            { name: '西红柿', amount: '2个', category: '蔬菜' },
            { name: '鸡蛋', amount: '3个', category: '肉蛋' },
            { name: '小葱', amount: '一把', category: '蔬菜' },
        ],
    });
    if (rbuf) {
        const s = rbuf.indexOf('{'); const e = rbuf.lastIndexOf('}');
        // SSE 里每块是 data: {...}，直接找最后的 JSON 片段做结构判断
        let dishes = 0;
        try {
            const m = rbuf.match(/data: (\{.*\})/g) || [];
            let acc = '';
            m.forEach((line) => {
                const payload = line.slice(6);
                try { const o = JSON.parse(payload); acc += (o.choices && o.choices[0] && o.choices[0].delta && o.choices[0].delta.content) || ''; } catch (e) { /* 非 JSON 行 */ }
            });
            const s2 = acc.indexOf('{'); const e2 = acc.lastIndexOf('}');
            const obj = JSON.parse(acc.slice(s2, e2 + 1));
            const list = obj.dishes || obj.recipes || obj.data || (Array.isArray(obj) ? obj : []);
            dishes = list.filter((d) => d && (d.title || d.name || d.dish) && Array.isArray(d.steps) && d.steps.length > 0).length;
        } catch (err) { dishes = -1; }
        console.log('   菜谱可解析道数（按客户端判定）=' + dishes);
    }
})();
