'use strict';
// 压测：一次要 3 道复杂菜，看输出会不会被上游 max_tokens 截断（finishReason）。
// 这是「步骤变长 → token 变多」最可能踩的坑。
//
// 用法：docker exec llm-proxy node /tmp/recipe-trunc.js

const crypto = require('crypto');
const BASE = 'http://127.0.0.1:8787';

function token() {
    const body = Buffer.from(JSON.stringify({ sub: 'trunc-probe', exp: Date.now() + 600000 })).toString('base64url');
    const mac = crypto.createHmac('sha256', process.env.LLM_TOKEN_SECRET).update(body).digest('base64url');
    return body + '.' + mac;
}

async function chat(payload) {
    const started = Date.now();
    const r = await fetch(BASE + '/llm/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() },
        body: JSON.stringify(Object.assign({ stream: false }, payload)),
    });
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch (e) { /* ignore */ }
    return { status: r.status, ms: Date.now() - started, json: j, text };
}

function unfence(t) {
    return String(t || '').replace(/^\uFEFF/, '').replace(/^```(?:json|JSON)?\s*/, '').replace(/```\s*$/, '').trim();
}

const INGREDIENTS = [
    { name: '五花肉', amount: '500g', category: '肉类' },
    { name: '猪肋排', amount: '400g', category: '肉类' },
    { name: '鸡腿', amount: '4只', category: '肉类' },
    { name: '冰糖', amount: '30g', category: '调料' },
    { name: '香醋', amount: '2勺', category: '调料' },
    { name: '生抽', amount: '3勺', category: '调料' },
    { name: '生姜', amount: '5片', category: '调料' },
    { name: '八角', amount: '2个', category: '调料' },
];

(async () => {
    console.log('=== 一次 3 道复杂菜（最容易触发 token 截断）===');
    const res = await chat({ task: 'recipe', ingredients: INGREDIENTS, count: 3 });
    console.log('HTTP ' + res.status + '  ' + res.ms + 'ms  model=' + ((res.json && res.json.model) || '?'));
    console.log('finishReason=' + ((res.json && res.json.finishReason) || '(未返回)'));

    if (res.status !== 200 || !res.json || typeof res.json.content !== 'string') {
        console.log('✗ 失败：' + JSON.stringify(res.json || res.text).slice(0, 300));
        process.exit(1);
    }

    const content = unfence(res.json.content);
    console.log('正文长度=' + content.length + ' 字符');

    let parsed = null;
    let parseErr = '';
    try {
        const a = content.indexOf('{');
        const b = content.lastIndexOf('}');
        parsed = JSON.parse(content.slice(a, b + 1));
    } catch (e) {
        parseErr = e.message;
    }

    const finish = (res.json.finishReason || '').toLowerCase();
    let pass = 0;
    let fail = 0;
    function check(name, ok, extra) {
        console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra ? '  ' + extra : ''));
        ok ? pass++ : fail++;
    }

    check('finishReason 不是 length（没被 max_tokens 截断）', finish !== 'length', finish || '(空)');
    check('JSON 能完整解析', parsed !== null, parseErr ? '解析错误：' + parseErr : '');

    if (parsed) {
        const list = Array.isArray(parsed) ? parsed : (parsed.dishes || parsed.recipes || parsed.data || []);
        check('拿到 3 道菜', Array.isArray(list) && list.length === 3, (Array.isArray(list) ? list.length : 0) + ' 道');
        if (Array.isArray(list)) {
            for (const d of list) {
                const title = d.title || d.name || d.dish || '(无名)';
                const steps = (Array.isArray(d.steps) ? d.steps : []).map((s) => (s && typeof s === 'object' ? (s.text || s.desc || '') : String(s))).filter((x) => x.trim());
                const lens = steps.map((s) => s.length);
                const max = lens.length ? Math.max.apply(null, lens) : 0;
                const avg = lens.length ? Math.round(lens.reduce((a, b) => a + b, 0) / lens.length) : 0;
                console.log('  《' + title + '》 steps=' + steps.length + ' 平均 ' + avg + ' 字 最长 ' + max + ' 字');
            }
            const totalSteps = list.reduce((n, d) => n + (Array.isArray(d.steps) ? d.steps.length : 0), 0);
            console.log('  三步合计 ' + totalSteps + ' 步');
        }
    }

    console.log('\npass=' + pass + ' fail=' + fail);
    process.exit(fail === 0 ? 0 : 1);
})();
