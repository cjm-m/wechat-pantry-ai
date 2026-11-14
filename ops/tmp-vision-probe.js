'use strict';
// 识图模型盲测 v2：把「能不能看图」和「JSON 形态合不合规」拆成两个独立测试。
//
//  A. 视觉能力：直接问「图里最大的那行字是什么」，回答里出现随机指纹才算真看见（防幻觉复述）。
//     这一步刻意不用生产 VISION prompt——生产 prompt 要求「不是食物就不要输出」，
//     拿指纹图喂它会得到空 items，那是正确行为，不能当成「看不见」。
//  B. JSON 形态：用生产 VISION prompt，只检查返回结构是不是 {"items":[...]}（空数组也算合规）。
//  C. 400 重试：完全复刻 llm-proxy 的 upstreamCall——先摘思考字段，再摘 response_format。

const http = require('http');
const https = require('https');
const fs = require('fs');

const NEWAPI_BASE = String(process.env.NEWAPI_BASE || 'http://new-api:3000').replace(/\/+$/, '');
const NEWAPI_KEY = String(process.env.NEWAPI_KEY || '').trim();
const IMAGE = fs.readFileSync(process.env.PROBE_IMAGE || '/app/probe.b64', 'utf8').trim();
const FP = String(process.env.PROBE_FP || '').trim().toUpperCase();
const RUNS = Number(process.env.PROBE_RUNS || 2);
const MODELS = (process.env.PROBE_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean);

const VISION_PROMPT = [
    '你是冰箱食材识别助手。你只做一件事：认出照片里有哪些食材。',
    '你只输出一个 JSON 对象，不输出任何其他内容。',
    '结构固定为：',
    '{"items":[{"name":"食物名称","category":"类别","quantity":"数量","unit":"单位","storage":"冷藏"}]}',
    '规则：',
    '1. 不要输出 markdown 代码块、解释或前后缀文字。',
    '2. 只做识别。不要输出保质期、保质天数、生产日期、购买日期、开封日期等任何时间信息——那是另一个环节的工作。',
    '3. name 用日常叫法，不超过 10 个字，例如「鸡胸肉」「娃娃菜」。',
    '4. category 只能是下面之一：蔬菜、肉蛋、水产、豆制品、乳制品、主食、调料、水果、其他。',
    '5. quantity 是数字或「半」，unit 从 个/袋/盒/瓶/斤/把/根/块/片/份/颗/包/罐 里选一个。',
    '6. storage 只能是「冷藏」或「冷冻」，作为存放建议：生鲜肉禽、水产、速冻食品、短期吃不完需要分装冷冻的填「冷冻」；蔬菜、水果、蛋奶、豆制品、调料、熟食填「冷藏」。',
    '7. 看不清、或者不确定是不是食物的，不要输出。',
    '8. 最多 12 样，重复的合并成一条。',
].join('\n');

function request(body) {
    return new Promise((resolve) => {
        const payload = Buffer.from(JSON.stringify(body), 'utf8');
        const isHttp = /^http:\/\//i.test(NEWAPI_BASE);
        const client = isHttp ? http : https;
        const target = new URL(NEWAPI_BASE + '/v1/chat/completions');
        const started = Date.now();
        const req = client.request({
            hostname: target.hostname,
            port: target.port || (isHttp ? 80 : 443),
            path: target.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': payload.length,
                Authorization: 'Bearer ' + NEWAPI_KEY,
            },
            timeout: 60000,
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
                resolve({ status: res.statusCode, ms: Date.now() - started, json, text });
            });
        });
        req.on('timeout', () => { req.destroy(); resolve({ status: 0, ms: Date.now() - started, error: 'timeout' }); });
        req.on('error', (e) => resolve({ status: 0, ms: Date.now() - started, error: e.message }));
        req.end(payload);
    });
}

// 完全复刻 server/llm-proxy.js 的 upstreamCall：400 时先摘思考字段，再摘 response_format
function stripThinkingPolicy(body) {
    const had = body.enable_thinking !== undefined || body.thinking !== undefined;
    delete body.enable_thinking;
    delete body.thinking;
    return had;
}

async function upstreamCall(body) {
    const tried = [];
    const attempt = async () => {
        const r = await request(body);
        tried.push(r.status);
        return r;
    };
    let r = await attempt();
    if (r.status === 400) {
        if (stripThinkingPolicy(body)) { r = await attempt(); }
        if (r.status === 400 && body.response_format) {
            delete body.response_format;
            r = await attempt();
        }
    }
    r.tried = tried;
    return r;
}

function contentOf(r) {
    const choice = r.json && r.json.choices && r.json.choices[0];
    return (choice && choice.message && choice.message.content) || '';
}

function shapeOf(content) {
    const t = String(content || '').trim();
    try {
        const obj = JSON.parse(t);
        if (Array.isArray(obj)) return { shape: 'BARE_ARRAY', items: obj.length };
        if (obj && Array.isArray(obj.items)) return { shape: '{"items":[...]}', items: obj.items.length };
        return { shape: 'OTHER_OBJECT:' + Object.keys(obj || {}).join('|'), items: null };
    } catch (e) {
        const s = t.indexOf('{');
        const e2 = t.lastIndexOf('}');
        if (s >= 0 && e2 > s) {
            try {
                const obj = JSON.parse(t.slice(s, e2 + 1));
                if (obj && Array.isArray(obj.items)) return { shape: '{"items":[...]}(fenced)', items: obj.items.length };
                return { shape: 'OTHER_OBJECT(fenced)', items: null };
            } catch (e3) { return { shape: 'PARSE_FAIL', items: null }; }
        }
        return { shape: 'PARSE_FAIL', items: null };
    }
}

// A. 视觉能力：直接问图上的字，不要 JSON，不要食材约束
async function probeVision(model) {
    const body = {
        model: model,
        temperature: 0,
        stream: false,
        messages: [{
            role: 'user',
            content: [
                { type: 'text', text: '这张图片里最大的那行字符是什么？只原样输出那串字符，不要任何解释。' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,' + IMAGE } },
            ],
        }],
    };
    const r = await upstreamCall(body);
    const content = contentOf(r);
    const sawFp = FP !== '' && content.toUpperCase().indexOf(FP) >= 0;
    return { model, status: r.status, tried: r.tried, ms: r.ms, sawFp, content: content.trim().slice(0, 120), error: r.error };
}

// B. JSON 形态：生产 prompt，只看结构
async function probeJson(model) {
    const body = {
        model: model,
        temperature: 0.2,
        stream: false,
        response_format: { type: 'json_object' },
        enable_thinking: false,
        thinking: { type: 'disabled' },
        messages: [
            { role: 'system', content: VISION_PROMPT },
            {
                role: 'user',
                content: [
                    { type: 'text', text: '请识别这张照片里的食材，按约定输出 JSON。' },
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,' + IMAGE } },
                ],
            },
        ],
    };
    const r = await upstreamCall(body);
    const content = contentOf(r);
    const info = shapeOf(content);
    return {
        model, status: r.status, tried: r.tried, ms: r.ms,
        shape: info.shape, items: info.items,
        content: content.trim().slice(0, 100), error: r.error,
    };
}

(async () => {
    console.log('指纹 = ' + FP + '，每模型每项 ' + RUNS + ' 次\n');
    const rows = [];
    for (const model of MODELS) {
        console.log('########## ' + model + ' ##########');
        const vis = [];
        const js = [];
        for (let i = 0; i < RUNS; i += 1) {
            const a = await probeVision(model);
            vis.push(a);
            console.log('  A 视觉  HTTP ' + a.status + ' [' + a.tried.join('>') + ']  ' + a.ms + 'ms  '
                + (a.status === 200 ? (a.sawFp ? '看见指纹 ✓' : '没看见 ✗  答:' + JSON.stringify(a.content)) : 'ERR ' + (a.error || a.content)));
        }
        if (vis.some((v) => v.status === 200)) {
            for (let i = 0; i < RUNS; i += 1) {
                const b = await probeJson(model);
                js.push(b);
                console.log('  B JSON  HTTP ' + b.status + ' [' + b.tried.join('>') + ']  ' + b.ms + 'ms  '
                    + (b.status === 200 ? b.shape + ' items=' + b.items : 'ERR ' + (b.error || b.content)));
            }
        }
        const visOk = vis.filter((v) => v.status === 200 && v.sawFp).length;
        const httpOk = vis.filter((v) => v.status === 200).length;
        const jsonOk = js.filter((b) => b.status === 200 && (b.shape === '{"items":[...]}' || b.shape === '{"items":[...]}(fenced)')).length;
        const lat = vis.filter((v) => v.status === 200).map((v) => v.ms).sort((a, b) => a - b);
        const median = lat.length ? lat[Math.floor(lat.length / 2)] : null;
        let verdict;
        if (httpOk === 0) verdict = '不可用';
        else if (visOk === 0) verdict = '看不见图';
        else if (visOk < vis.length) verdict = '识图不稳定';
        else if (jsonOk < js.length) verdict = '识图OK/JSON不合规';
        else verdict = '✓ 可作识图模型';
        rows.push({ model, http: httpOk + '/' + vis.length, fp: visOk + '/' + vis.length, json: jsonOk + '/' + (js.length || 0), median, verdict });
        console.log('');
    }

    console.log('================= 汇总 =================');
    for (const r of rows) {
        console.log((r.verdict.indexOf('✓') === 0 ? '✅ ' : '❌ ') + r.model);
        console.log('     视觉 ' + r.fp + '   JSON ' + r.json + '   中位 ' + (r.median || '-') + 'ms   判定: ' + r.verdict);
    }
})();
