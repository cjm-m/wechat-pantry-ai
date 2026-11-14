'use strict';
// 识图质量盲测：用 3 张真实食材照片 + 生产 VISION prompt，
// 判定标准是「客户端 parseItems 之后用户能看到几样食材」，而不是 HTTP 200。
// 同时检查字段合规（category / unit / storage 是否在枚举内）。

const http = require('http');
const fs = require('fs');

const BASE = String(process.env.NEWAPI_BASE || 'http://new-api:3000').replace(/\/+$/, '');
const KEY = String(process.env.NEWAPI_KEY || '').trim();
const MODELS = (process.env.PROBE_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean);
const IMAGES = (process.env.PROBE_IMAGES || '').split(',').map((s) => s.trim()).filter(Boolean);
const PROMPTS = require(process.env.PROMPTS_FILE || '/app/prompts.js');

const CATS = ['蔬菜', '肉蛋', '水产', '豆制品', '乳制品', '主食', '调料', '水果', '其他'];
const UNITS = ['个', '袋', '盒', '瓶', '斤', '把', '根', '块', '片', '份', '颗', '包', '罐'];
const STORAGE = ['冷藏', '冷冻'];

function toText(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
    if (Array.isArray(v)) return v.map((p) => (typeof p === 'string' ? p : (p && typeof p.text === 'string' ? p.text : ''))).join('');
    return '';
}

// 复刻 utils/vision.js 的 parseItems
function clientParseItems(rawText) {
    let text = toText(rawText).trim();
    if (text === '') return { items: [], stage: 'empty' };
    text = text.replace(/^\uFEFF/, '').replace(/[\u200b\u200c\u200d]/g, '');
    text = text.replace(/^```(?:json|JSON)?\s*/, '').replace(/```\s*$/, '').trim();
    const start = text.indexOf('{'); const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) text = text.slice(start, end + 1);
    text = text.replace(/[\u201c\u201d\u201e]/g, '"').replace(/[\u2018\u2019]/g, "'");
    text = text.replace(/,\s*([}\]])/g, '$1');
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (e) { return { items: [], stage: 'json-parse-fail' }; }
    let list = null;
    if (Array.isArray(parsed)) list = parsed;
    else if (parsed && Array.isArray(parsed.items)) list = parsed.items;
    else if (parsed && Array.isArray(parsed.foods)) list = parsed.foods;
    else if (parsed && Array.isArray(parsed.data)) list = parsed.data;
    if (!list) return { items: [], stage: 'no-list' };
    const seen = {};
    const items = [];
    list.forEach((raw) => {
        if (!raw || typeof raw !== 'object') return;
        const name = toText(raw.name || raw.food || raw.title).trim().slice(0, 20);
        if (name === '') return;
        const unit = toText(raw.unit).trim();
        const key = name + '|' + unit;
        if (seen[key]) return;
        seen[key] = true;
        items.push({
            name,
            category: toText(raw.category).trim(),
            unit,
            storage: toText(raw.storage).trim(),
            quantity: toText(raw.quantity).trim(),
        });
    });
    return { items, stage: items.length ? 'ok' : 'no-valid-items' };
}

function post(body) {
    return new Promise((resolve) => {
        const payload = Buffer.from(JSON.stringify(body), 'utf8');
        const t = new URL(BASE + '/v1/chat/completions');
        const started = Date.now();
        const req = http.request({
            hostname: t.hostname, port: t.port || 80, path: t.pathname, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, Authorization: 'Bearer ' + KEY },
            timeout: 60000,
        }, (res) => {
            const cs = [];
            res.on('data', (c) => cs.push(c));
            res.on('end', () => {
                const text = Buffer.concat(cs).toString('utf8');
                let j = null;
                try { j = JSON.parse(text); } catch (e) { /* ignore */ }
                resolve({ status: res.statusCode, ms: Date.now() - started, json: j, text });
            });
        });
        req.on('timeout', () => { req.destroy(); resolve({ status: 0, ms: Date.now() - started, error: 'timeout' }); });
        req.on('error', (e) => resolve({ status: 0, ms: Date.now() - started, error: e.message }));
        req.end(payload);
    });
}

function stripT(b) {
    const had = b.enable_thinking !== undefined || b.thinking !== undefined;
    delete b.enable_thinking; delete b.thinking; return had;
}

async function upstreamCall(body) {
    const tried = [];
    let r = await post(body); tried.push(r.status);
    if (r.status === 400) {
        if (stripT(body)) { r = await post(body); tried.push(r.status); }
        if (r.status === 400 && body.response_format) { delete body.response_format; r = await post(body); tried.push(r.status); }
    }
    r.tried = tried;
    return r;
}

function contentOf(r) {
    const c = r.json && r.json.choices && r.json.choices[0];
    return (c && c.message && c.message.content) || '';
}

(async () => {
    console.log('生产 VISION prompt + 客户端 parseItems；' + IMAGES.length + ' 张真实食材图\n');
    const rows = [];
    for (const model of MODELS) {
        console.log('########## ' + model + ' ##########');
        const stats = { ok: 0, total: 0, items: [], ms: [], badField: 0, badItem: 0 };
        for (const img of IMAGES) {
            const b64 = fs.readFileSync(img, 'utf8').trim();
            const body = {
                model, temperature: 0.2, stream: false,
                response_format: { type: 'json_object' },
                enable_thinking: false, thinking: { type: 'disabled' },
                messages: [
                    { role: 'system', content: PROMPTS.VISION },
                    { role: 'user', content: [
                        { type: 'text', text: '请识别这张照片里的食材，按约定输出 JSON。' },
                        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } },
                    ] },
                ],
            };
            const r = await upstreamCall(body);
            const name = img.split('/').pop();
            if (r.status !== 200) {
                console.log('  ' + name.padEnd(14) + ' HTTP ' + r.status + ' [' + r.tried.join('>') + ']  ' + (r.error || (r.text || '').slice(0, 100)));
                stats.total += 1;
                continue;
            }
            const content = contentOf(r);
            const parsed = clientParseItems(content);
            stats.total += 1;
            stats.ms.push(r.ms);
            if (parsed.items.length > 0) stats.ok += 1;
            stats.items.push(parsed.items.length);
            let bad = 0;
            parsed.items.forEach((it) => {
                if (CATS.indexOf(it.category) < 0) bad += 1;
                else if (it.unit !== '' && UNITS.indexOf(it.unit) < 0) bad += 1;
                else if (STORAGE.indexOf(it.storage) < 0) bad += 1;
            });
            stats.badItem += bad;
            if (bad > 0) stats.badField += 1;
            console.log('  ' + name.padEnd(14) + r.ms + 'ms  items=' + parsed.items.length
                + (bad ? '  ⚠字段违规' + bad : '') + '  ' + JSON.stringify(parsed.items.map((i) => i.name).slice(0, 8)));
            if (parsed.items.length === 0) console.log('      stage=' + parsed.stage + '  raw=' + JSON.stringify(content.slice(0, 120)));
        }
        const lat = stats.ms.slice().sort((a, b) => a - b);
        rows.push({
            model,
            ok: stats.ok, total: stats.total,
            avgItems: stats.items.length ? (stats.items.reduce((a, b) => a + b, 0) / stats.items.length).toFixed(1) : '-',
            med: lat.length ? lat[Math.floor(lat.length / 2)] : null,
            badField: stats.badField, badItem: stats.badItem,
        });
        console.log('');
    }
    console.log('===== 汇总 =====');
    console.log('model'.padEnd(44) + '解析成功  平均条数  中位ms  字段违规');
    for (const r of rows) {
        console.log(r.model.padEnd(44) + (r.ok + '/' + r.total).padEnd(10) + String(r.avgItems).padEnd(10)
            + String(r.med || '-').padEnd(8) + (r.badItem ? r.badItem + ' 处' : '无'));
    }
})();
