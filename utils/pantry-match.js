// 缺料比对：归一化 + 单向包含 + 三档结论（have / maybe / miss）。
//
// 注意：这里和 pages/cook.js 里的 nameMatched 不是同一套规则，故意没有合并。
// 那边的双向 contains 只用来给 AI 生成的菜谱标一个小标签，误判代价低；
// 这边是「要不要现在去买」的二元决策：库存有「鸡蛋面」时不能算「有鸡蛋」，
// 否则人按清单做完才发现少东西。所以这里只做单向包含，且把拿不准的单列成 maybe。

// 全角字符转半角，只处理可打印的 ASCII 区段。
function toHalfWidth(text) {
    return String(text).replace(/[\uFF01-\uFF5E]/g, (ch) =>
        String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)
    );
}

const PREFIX_RE = /^(新鲜|冰鲜|冷冻|冷藏|散装|袋装|盒装|瓶装|罐装|整只|去皮|切好的?)+/;

// 归一化：去全角/空白、去修饰前缀、小写。只用于比对，不用于展示。
function normalizeName(text) {
    const raw = text === null || text === undefined ? '' : String(text);
    return toHalfWidth(raw)
        .replace(/\u3000/g, ' ')
        .replace(/\s+/g, '')
        .replace(PREFIX_RE, '')
        .toLowerCase();
}

// need 在 pool 里的匹配档位。
// have：完全同名；maybe：库存名单向包含需求名且长度接近（鸡蛋 → 鸡蛋面）；
// miss：其余。反向包含一律不算（需要鸡蛋面、只有鸡蛋 → 缺）。
function levelOf(need, pool) {
    const target = normalizeName(need);
    if (target === '') return { level: 'miss', hit: '' };

    const items = Array.isArray(pool) ? pool : [];
    for (let i = 0; i < items.length; i += 1) {
        if (normalizeName(items[i]) === target) {
            return { level: 'have', hit: items[i] };
        }
    }

    for (let i = 0; i < items.length; i += 1) {
        const candidate = normalizeName(items[i]);
        if (candidate === '' || candidate.indexOf(target) < 0) continue;
        const diff = candidate.length - target.length;
        // 两字以上允许差 2 个字（鸡蛋 → 鸡蛋面 / 鸡蛋干）；单字只差 1 个（葱 → 小葱、蒜 → 大蒜）。
        if (target.length >= 2 ? diff <= 2 : diff <= 1) {
            return { level: 'maybe', hit: items[i] };
        }
    }

    return { level: 'miss', hit: '' };
}

// needItems: [{ name, amount }]，调用方应先滤掉 fromFridge === false 的基础调料。
// stockNames: ['鸡蛋', '番茄', ...]
// 返回 { rows, have, maybe, miss }：rows 供列表展示，其余三个是去重后的名称数组。
function diffNeeds(needItems, stockNames) {
    const seen = {};
    const rows = [];
    const have = [];
    const maybe = [];
    const miss = [];

    (needItems || []).forEach((item) => {
        const name = String((item && item.name) || '').trim();
        if (name === '') return;
        const key = normalizeName(name);
        if (seen[key]) return;
        seen[key] = true;

        const matched = levelOf(name, stockNames);
        rows.push({
            name: name,
            amount: (item && item.amount) || '',
            level: matched.level,
            hint: matched.hit,
        });
        if (matched.level === 'have') have.push(name);
        else if (matched.level === 'maybe') maybe.push(name);
        else miss.push(name);
    });

    return { rows: rows, have: have, maybe: maybe, miss: miss };
}

module.exports = {
    normalizeName,
    levelOf,
    diffNeeds,
};
