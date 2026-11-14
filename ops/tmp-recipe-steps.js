'use strict';
// 验「做法步骤不再被压成 3 条」：走真实 /llm/chat 的 recipe task，
// 用不同复杂度的菜，统计 steps 条数与每步字数。
// 必须在 llm-proxy 容器内跑（要用 LLM_TOKEN_SECRET 自签令牌 + 本机 8787）。
//
// 用法：docker exec llm-proxy node /tmp/recipe-steps.js

const BASE = 'http://127.0.0.1:8787';

function token() {
    const crypto = require('crypto');
    const body = Buffer.from(JSON.stringify({ sub: 'steps-probe', exp: Date.now() + 600000 })).toString('base64url');
    const mac = crypto.createHmac('sha256', process.env.LLM_TOKEN_SECRET).update(body).digest('base64url');
    return body + '.' + mac;
}

const TK = token();

async function chat(payload) {
    const started = Date.now();
    const r = await fetch(BASE + '/llm/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TK },
        body: JSON.stringify(Object.assign({ stream: false }, payload)),
    });
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch (e) { /* ignore */ }
    return { status: r.status, ms: Date.now() - started, json: j, text };
}

// 复刻 utils/cooking.js 的 parseDishes 关键部分（去围栏 + 认 dishes/recipes/data）
function unfence(text) {
    return String(text || '')
        .replace(/^\uFEFF/, '')
        .replace(/^```(?:json|JSON)?\s*/, '')
        .replace(/```\s*$/, '')
        .trim();
}

function parseDishes(raw) {
    const text = unfence(raw);
    const a = text.indexOf('{');
    const b = text.lastIndexOf('}');
    if (a < 0 || b <= a) return [];
    let body = text.slice(a, b + 1);
    try {
        const obj = JSON.parse(body);
        const list = Array.isArray(obj) ? obj : (obj.dishes || obj.recipes || obj.data || [obj]);
        return Array.isArray(list) ? list : [];
    } catch (e) {
        return [];
    }
}

const CASES = [
    {
        name: '复杂菜 · 红烧肉（期望 10-15 步）',
        count: 1,
        ingredients: [
            { name: '五花肉', amount: '500g', category: '肉类' },
            { name: '冰糖', amount: '30g', category: '调料' },
            { name: '生姜', amount: '3片', category: '调料' },
            { name: '八角', amount: '2个', category: '调料' },
        ],
    },
    {
        name: '复杂菜 · 糖醋排骨（期望 10-15 步）',
        count: 1,
        ingredients: [
            { name: '猪肋排', amount: '500g', category: '肉类' },
            { name: '香醋', amount: '2勺', category: '调料' },
            { name: '白糖', amount: '2勺', category: '调料' },
            { name: '白芝麻', amount: '少许', category: '调料' },
        ],
    },
    {
        name: '普通炒菜 · 青椒肉丝（期望 6-9 步）',
        count: 1,
        ingredients: [
            { name: '青椒', amount: '3个', category: '蔬菜' },
            { name: '猪里脊', amount: '200g', category: '肉类' },
        ],
    },
    {
        name: '快手菜 · 西红柿炒蛋（期望 3-5 步）',
        count: 1,
        ingredients: [
            { name: '西红柿', amount: '2个', category: '蔬菜' },
            { name: '鸡蛋', amount: '3个', category: '蛋类' },
        ],
    },
];

const ONLY = (process.env.PROBE_ONLY || '').trim();

function stepText(s) {
    if (s && typeof s === 'object') return String(s.text || s.desc || s.description || s.content || s.detail || '');
    return String(s === null || s === undefined ? '' : s);
}

(async () => {
    let pass = 0;
    let fail = 0;
    let globalMax = 0;

    for (const c of CASES) {
        if (ONLY && c.name.indexOf(ONLY) < 0) continue;
        const res = await chat({ task: 'recipe', ingredients: c.ingredients, count: c.count, model: process.env.PROBE_MODEL || undefined });
        console.log('\n=== ' + c.name + ' ===');
        console.log('HTTP ' + res.status + '  ' + res.ms + 'ms  model=' + ((res.json && res.json.model) || '?'));

        if (res.status !== 200 || !res.json || typeof res.json.content !== 'string') {
            console.log('  ✗ 没有拿到 content：' + JSON.stringify(res.json || res.text).slice(0, 300));
            fail++;
            continue;
        }

        const dishes = parseDishes(res.json.content);
        if (dishes.length === 0) {
            console.log('  ✗ 一道菜都解析不出来');
            console.log('  原文前 400 字：' + unfence(res.json.content).slice(0, 400));
            fail++;
            continue;
        }

        for (const d of dishes) {
            const title = String(d.title || d.name || d.dish || '(无名)');
            const steps = (Array.isArray(d.steps) ? d.steps : []).map(stepText).filter((s) => s.trim() !== '');
            const lens = steps.map((s) => s.length);
            const avg = lens.length ? Math.round(lens.reduce((a, b) => a + b, 0) / lens.length) : 0;
            const max = lens.length ? Math.max.apply(null, lens) : 0;
            const over60 = lens.filter((n) => n > 60).length;

            console.log('  《' + title + '》 steps=' + steps.length + ' 平均 ' + avg + ' 字 最长 ' + max + ' 字 超60字=' + over60);
            steps.forEach((s, i) => console.log('    ' + (i + 1) + '. ' + s));

            // 判据（不按 prompt 的理想区间卡，按「改造前是什么样」卡）：
            //   改造前恒定 3 步、每步 ≤30 字。所以
            //   ① 每个菜 steps ≥ minWant 且 ≤20（20 是 normalizeSteps 的防御上限）→ 步数约束松开了
            //   ② 全局至少一步 >30 字 → 字数约束松开了（单道菜偶尔全写短句是模型波动，不算失败）
            const minWant = c.name.indexOf('复杂菜') >= 0 ? 5 : 3;
            const okCount = steps.length >= minWant && steps.length <= 20;
            if (max > globalMax) globalMax = max;
            if (okCount) {
                console.log('  ✓ 步数 ' + steps.length + '（≥' + minWant + '，≤20）最长一步 ' + max + ' 字');
                pass++;
            } else {
                console.log('  ✗ 步数=' + steps.length + '（期望 ≥' + minWant + ' 且 ≤20）');
                fail++;
            }
        }
    }

    console.log('\n=== 汇总：pass=' + pass + ' fail=' + fail + ' 全局最长一步=' + globalMax + ' 字（原上限 30）===');
    if (globalMax <= 30) {
        console.log('✗ 没有任何一步超过 30 字，字数约束可能没生效');
        process.exit(1);
    }
    console.log('✓ 有步骤超过 30 字，证明「每步 ≤30 字」的旧约束已解除');
    process.exit(fail === 0 ? 0 : 1);
})();
