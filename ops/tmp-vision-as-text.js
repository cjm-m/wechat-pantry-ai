'use strict';
// 验证「识图模型能否承担文本任务」：走真实 /llm/chat，把 :vision 模型当文本模型用。
// 判定用生产 prompts + 客户端解析逻辑，不看 HTTP 200。
const crypto = require('crypto');
const BASE = 'http://127.0.0.1:8787';
const b = Buffer.from(JSON.stringify({ sub: 'probe', exp: Date.now() + 600000 })).toString('base64url');
const TK = b + '.' + crypto.createHmac('sha256', process.env.LLM_TOKEN_SECRET).update(b).digest('base64url');

async function chat(payload) {
    const t0 = Date.now();
    const r = await fetch(BASE + '/llm/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TK },
        body: JSON.stringify(Object.assign({ stream: false }, payload)),
    });
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch (e) { /* ignore */ }
    return { status: r.status, ms: Date.now() - t0, json: j, text };
}

// 复刻客户端 utils/cooking.js:239 parseDishes 的去围栏步骤——漏了会把 ```json 包着的合法 JSON 误判成失败。
function unfence(content) {
    return String(content || '')
        .replace(/^\uFEFF/, '').replace(/[\u200b\u200c\u200d]/g, '')
        .replace(/^```(?:json|JSON)?\s*/, '').replace(/```\s*$/, '').trim();
}

function parseShelf(content) {
    const text = unfence(content);
    const s = text.indexOf('{'); const e = text.lastIndexOf('}');
    if (s < 0 || e <= s) return -1;
    let o = null;
    try { o = JSON.parse(text.slice(s, e + 1)); } catch (err) { return -2; }
    const list = Array.isArray(o) ? o : (o.items || o.data || []);
    return list.filter((x) => x && Number(x.idx !== undefined ? x.idx : x.index) >= 0
        && Number(x.days || x.shelf_life_days) > 0).length;
}

function parseRecipe(content) {
    const text = unfence(content);
    const s = text.indexOf('{'); const e = text.lastIndexOf('}');
    if (s < 0 || e <= s) return -1;
    let o = null;
    try { o = JSON.parse(text.slice(s, e + 1)); } catch (err) { return -2; }
    const list = Array.isArray(o) ? o : (o.dishes || o.recipes || o.data || []);
    return list.filter((d) => d && (d.title || d.name || d.dish) && Array.isArray(d.steps) && d.steps.length > 0).length;
}

const SHELF = { task: 'shelf', items: [
    { name: '西红柿', category: '蔬菜', storage: '冷藏' },
    { name: '鸡蛋', category: '肉蛋', storage: '冷藏' },
    { name: '牛奶', category: '乳制品', storage: '冷藏' },
] };
const RECIPE = { task: 'recipe', count: 2, ingredients: [
    { name: '西红柿', amount: '2个', category: '蔬菜' },
    { name: '鸡蛋', amount: '3个', category: '肉蛋' },
    { name: '小葱', amount: '一把', category: '蔬菜' },
] };

(async () => {
    const models = (process.env.PROBE_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean);
    console.log('把识图模型当文本模型用（shelf / recipe 各 2 次）\n');
    for (const m of models) {
        const out = [];
        for (let i = 0; i < 2; i += 1) {
            const a = await chat(Object.assign({}, SHELF, { model: m }));
            const b2 = await chat(Object.assign({}, RECIPE, { model: m }));
            const shelfOk = a.status === 200 ? parseShelf((a.json && a.json.content) || '') : -1;
            const recipeOk = b2.status === 200 ? parseRecipe((b2.json && b2.json.content) || '') : -1;
            const used = (a.json && a.json.model) || '-';
            out.push({ shelf: shelfOk, recipe: recipeOk, ms: a.ms + b2.ms, used, st: a.status + '/' + b2.status });
        }
        const okAll = out.every((o) => o.shelf >= 3 && o.recipe >= 1);
        console.log(m.padEnd(42) + (okAll ? '✅' : '❌')
            + '  shelf=' + out.map((o) => o.shelf).join(',')
            + '  recipe=' + out.map((o) => o.recipe).join(',')
            + '  总耗时=' + out.map((o) => o.ms + 'ms').join(',')
            + '  实际模型=' + out[0].used);
    }
})();
