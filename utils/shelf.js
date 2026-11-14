// 保质期建议：只处理「还没有保质期」的食材，按存放位置（冷藏 / 冷冻）分别估算。
// 已有保质期的食材根本不会进入这个流程，用户自己填的信息不会被覆盖。
//
// 通道统一走 utils/llm.js；task='shelf' 时提示词在 cloudfunctions/cook/prompts.js。
// 这里的 SYSTEM_PROMPT 只在 PROVIDER='platform'（回滚通道）时使用。

const llm = require('./llm');
const { resolveModel, friendlyMessage } = require('./cooking');
const { addDays, todayStr } = require('./format');

const MAX_ITEMS = 30;

const SYSTEM_PROMPT = [
    '你是专门做食材保质期评估的顾问。你只判断「从现在起还能放多久」，不做识别、不给菜谱、不给采购建议。',
    '你会收到一份已经由用户确认过的食材清单，每项包含：序号、名称、类别、存放位置（冷藏或冷冻）。',
    '你只输出一个 JSON 对象，不输出任何其他内容：',
    '{"items":[{"idx":0,"days":3,"note":"叶菜冷藏"}]}',
    '判断规则：',
    '1. days 是从今天起还能存放的天数，整数，最小 1，最大 730。',
    '2. 必须严格按该项标注的存放位置计算，绝不能把冷藏的期限套到冷冻上；同一食材冷冻通常是冷藏的 10 到 30 倍。',
    '3. 参考区间（未开封、家用冰箱 4℃ / -18℃）：',
    '   冷藏——叶菜 3 天；根茎瓜类 7 天；菌菇 4 天；浆果 3 天；其他水果 7 天；生鲜禽畜肉 2 天；生鲜水产 1 天；鸡蛋 30 天；巴氏奶 5 天；酸奶 14 天；豆制品 3 天；熟食剩菜 2 天；调味品 90 天；干货 180 天；',
    '   冷冻——禽畜肉 120 天；水产 90 天；速冻主食 60 天；冷冻蔬菜 90 天；冰淇淋 180 天。',
    '4. 名称或类别不明确时，取该类别里更短、更保守的值。',
    '5. 清单里同名但存放位置不同的项，要分别计算，不要合并。',
    '6. idx 必须与输入序号一一对应，有几项就输出几项，不能漏、不能多、不能改序号。',
    '7. note 不超过 12 个字，写清判断依据，例如「叶菜冷藏」「猪肉冷冻」。',
    '8. 不要输出保质期以外的任何建议。',
].join('\n');

function appError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function clean(value, max) {
    return String(value === null || value === undefined ? '' : value)
        .replace(/[\r\n\t]+/g, ' ')
        .trim()
        .slice(0, max);
}

function buildUserPrompt(items) {
    const lines = items.map((item) => item.idx + '. ' + item.name + '（' + item.category + '｜' + item.storage + '）');
    return [
        '下面是我的食材清单，每行格式是「序号. 名称（类别｜存放位置）」。',
        '<<<',
        lines.join('\n'),
        '>>>',
        '请按每样标注的存放位置，给出从今天起还能放多少天。',
    ].join('\n');
}

function toText(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    return '';
}

function parseSuggestions(rawText) {
    let text = toText(rawText).trim();
    if (text === '') return [];
    text = text.replace(/^\uFEFF/, '').replace(/[\u200b\u200c\u200d]/g, '');
    text = text.replace(/^```(?:json|JSON)?\s*/, '').replace(/```\s*$/, '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) text = text.slice(start, end + 1);
    text = text.replace(/[\u201c\u201d\u201e]/g, '"').replace(/[\u2018\u2019]/g, "'");
    text = text.replace(/,\s*([}\]])/g, '$1');

    let parsed = null;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        return [];
    }

    let list = null;
    if (Array.isArray(parsed)) list = parsed;
    else if (parsed && Array.isArray(parsed.items)) list = parsed.items;
    else if (parsed && Array.isArray(parsed.data)) list = parsed.data;
    if (!list) return [];

    const today = todayStr();
    const seen = {};
    const result = [];
    list.forEach((raw) => {
        if (!raw || typeof raw !== 'object') return;
        const idx = Number(raw.idx !== undefined ? raw.idx : raw.index);
        if (!isFinite(idx) || idx < 0) return;
        if (seen[idx]) return;
        let days = Number(raw.days);
        if (!isFinite(days)) days = Number(raw.shelf_life_days);
        if (!isFinite(days) || days <= 0) return;
        days = Math.min(Math.round(days), 730);
        seen[idx] = true;
        result.push({
            idx: idx,
            days: days,
            note: clean(raw.note || raw.reason, 24),
            expireAt: addDays(today, days),
        });
    });
    return result;
}

async function suggest(items, onProgress) {
    const list = (items || [])
        .slice(0, MAX_ITEMS)
        .map((item, index) => ({
            idx: index,
            name: clean(item.name, 20),
            category: clean(item.category, 10) || '其他',
            storage: item.storage === '冷冻' ? '冷冻' : '冷藏',
        }))
        .filter((item) => item.name !== '');

    if (list.length === 0) {
        throw appError('EMPTY', '没有需要补保质期的食材');
    }

    const model = await resolveModel();
    const params = {
        task: 'shelf',
        input: { items: list },
        model: model,
        temperature: 0.2,
        messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildUserPrompt(list) },
        ],
        stream: true,
        response_format: { type: 'json_object' },
    };

    let text = '';
    let finishReason = '';
    const stream = llm.chat.completions.create(params);
    for await (const chunk of stream) {
        const choice = chunk && chunk.choices ? chunk.choices[0] : null;
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta;
        if (delta && delta.content) {
            text += delta.content;
            if (typeof onProgress === 'function') onProgress(text.length);
        }
    }

    return {
        suggestions: parseSuggestions(text),
        count: list.length,
        raw: text,
        finishReason: finishReason,
    };
}

function friendly(error) {
    const code = (error && error.code) || (error && error.error && error.error.code) || '';
    if (code === 'EMPTY') return (error && error.message) || '没有需要补的';
    return friendlyMessage(error);
}

module.exports = {
    suggest,
    parseSuggestions,
    friendly,
    MAX_ITEMS,
};
