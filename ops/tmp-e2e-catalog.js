'use strict';
// 端到端验收：走真实 /llm/chat 接口（带自签令牌），验证
//   1. 识图不传 model → 兜底 NEWAPI_VISION_MODEL
//   2. 识图传目录内 :vision 模型 → 用用户的
//   3. 识图传非 :vision 模型（deepseek-v4）→ 回落兜底，不报错
//   4. 文本不传 model → 目录第一个（deepseek-v4）
//   5. 文本传目录内模型 → 用用户的
// 判定不只看 200，还看返回体里的 model 字段和内容能否被客户端解析。

const fs = require('fs');
const BASE = 'http://127.0.0.1:8787';

function token() {
    const crypto = require('crypto');
    const body = Buffer.from(JSON.stringify({ sub: 'e2e-probe', exp: Date.now() + 600000 })).toString('base64url');
    const mac = crypto.createHmac('sha256', process.env.LLM_TOKEN_SECRET).update(body).digest('base64url');
    return body + '.' + mac;
}

const TK = token();

async function chat(payload) {
    const started = Date.now();
    const r = await fetch(BASE + '/llm/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TK },
        // stream:false 才拿得到 JSON 信封；默认是 SSE，判定需要额外解流。
        body: JSON.stringify(Object.assign({ stream: false }, payload)),
    });
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch (e) { /* ignore */ }
    return { status: r.status, ms: Date.now() - started, json: j, text };
}

const IMG = fs.readFileSync('/tmp/fridge2.b64', 'utf8').trim();

(async () => {
    const cases = [
        { name: '识图 · 不传 model（期望兜底 glm-4.6v）', task: 'vision', payload: { task: 'vision', image: IMG, mime: 'image/jpeg' } },
        { name: '识图 · 选 Qwen3-VL（期望用它）', task: 'vision', payload: { task: 'vision', image: IMG, mime: 'image/jpeg', model: 'SiliconFlow/Qwen3-VL-30B-A3B-Instruct' } },
        { name: '识图 · 选 mimo-v2.6-flash（期望用它）', task: 'vision', payload: { task: 'vision', image: IMG, mime: 'image/jpeg', model: 'mimo-v2.6-flash' } },
        { name: '识图 · 选 deepseek-v4（非识图，期望回落 glm-4.6v）', task: 'vision', payload: { task: 'vision', image: IMG, mime: 'image/jpeg', model: 'Tark1/deepseek-v4-flash' } },
        { name: '识图 · 选目录外模型（期望回落 glm-4.6v）', task: 'vision', payload: { task: 'vision', image: IMG, mime: 'image/jpeg', model: 'gpt-4o' } },
        { name: '文本 · 不传 model（期望 deepseek-v4）', task: 'shelf', payload: { task: 'shelf', items: [{ name: '西红柿', category: '蔬菜', storage: '冷藏' }, { name: '鸡蛋', category: '肉蛋', storage: '冷藏' }] } },
        { name: '文本 · 选 sensenova（期望用它）', task: 'shelf', payload: { task: 'shelf', items: [{ name: '西红柿', category: '蔬菜', storage: '冷藏' }], model: 'sensenova-6.8-flash-lite' } },
    ];

    for (const c of cases) {
        const r = await chat(c.payload);
        let verdict = '';
        if (r.status !== 200) {
            verdict = '❌ HTTP ' + r.status + ' ' + JSON.stringify(r.json && (r.json.code + ':' + r.json.message));
        } else {
            const used = r.json && r.json.model;
            const content = (r.json && r.json.content) || '';
            verdict = '✅ ' + used + '  ' + r.ms + 'ms  ' + content.length + 'B';
            if (c.task === 'vision') {
                let n = -1;
                try {
                    const s = content.indexOf('{'); const e = content.lastIndexOf('}');
                    const obj = JSON.parse(content.slice(s, e + 1));
                    const arr = Array.isArray(obj) ? obj : (obj.items || obj.foods || obj.data || []);
                    n = arr.length;
                } catch (err) { n = -2; }
                verdict += '  items=' + n;
            }
        }
        console.log(c.name.padEnd(48) + verdict);
    }
})();
