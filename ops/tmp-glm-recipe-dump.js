'use strict';
const crypto = require('crypto');
const BASE = 'http://127.0.0.1:8787';
const b = Buffer.from(JSON.stringify({ sub: 'probe', exp: Date.now() + 600000 })).toString('base64url');
const TK = b + '.' + crypto.createHmac('sha256', process.env.LLM_TOKEN_SECRET).update(b).digest('base64url');

(async () => {
    const r = await fetch(BASE + '/llm/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TK },
        body: JSON.stringify({
            stream: false, model: 'Free-glm-4.6v-flash', task: 'recipe', count: 2,
            ingredients: [
                { name: '西红柿', amount: '2个', category: '蔬菜' },
                { name: '鸡蛋', amount: '3个', category: '肉蛋' },
                { name: '小葱', amount: '一把', category: '蔬菜' },
            ],
        }),
    });
    const j = await r.json();
    console.log('status=' + r.status + ' model=' + j.model + ' finishReason=' + j.finishReason);
    const c = j.content || '';
    console.log('len=' + c.length);
    console.log('--- head ---');
    console.log(c.slice(0, 400));
    console.log('--- tail 400 ---');
    console.log(c.slice(-400));
    const s = c.indexOf('{'); const e = c.lastIndexOf('}');
    console.log('brace idx: first=' + s + ' last=' + e);
    try { JSON.parse(c.slice(s, e + 1)); console.log('slice parse OK'); }
    catch (err) { console.log('slice parse FAIL: ' + err.message); }
    try { JSON.parse(c); console.log('full parse OK'); }
    catch (err) { console.log('full parse FAIL: ' + err.message); }
})();
