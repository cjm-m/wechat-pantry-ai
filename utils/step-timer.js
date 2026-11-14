// 步骤计时（M11 cook mode）—— 从中文做法里抠时长，纯函数、零依赖、可单测。
//
// 为什么需要它：菜谱的 steps 是纯字符串（utils/cooking.js 的 normalizeSteps 拍平成
// 字符串数组），没有结构化的 duration 字段。要让 cook mode 自动填计时器，
// 只能从文字里抽——而步骤文本本来就要求写清时长（server/prompts.js RECIPE 规则 4：
// 「写清…大约多久」），所以这条启发式的命中率有保证。
//
// 为什么不改提示词让模型多输出 duration：会影响三份提示词副本 + 全部历史菜谱
// 仍然没有该字段，收益不如正则直接。

const CN_DIGITS = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function parseNumber(raw) {
    const text = String(raw === null || raw === undefined ? '' : raw).trim();
    if (text === '') return null;
    if (/^[0-9]+$/.test(text)) return Number(text);
    // 「半小时」「半分钟」= 0.5。中文菜谱里极常见，忽略它等于丢掉一整类步骤。
    if (text === '半') return 0.5;
    // 「一刻」= 15 分钟（「炖一刻钟」）
    if (text === '一刻') return 15;
    if (CN_DIGITS[text]) return CN_DIGITS[text];
    if (/^十[一二三四五六七八九]$/.test(text)) return 10 + CN_DIGITS[text.slice(1)];
    if (/^[一二三四五六七八九]十$/.test(text)) return CN_DIGITS[text[0]] * 10;
    if (/^[一二三四五六七八九]十[一二三四五六七八九]$/.test(text)) {
        return CN_DIGITS[text[0]] * 10 + CN_DIGITS[text[2]];
    }
    return null;
}

// 返回秒数；找不到返回 0（调用方据此不自动填计时器，改为手动加时）。
//
// 匹配策略：把三种单位的所有命中都收集起来，按「出现位置」取最靠前的那个，
// 位置相同时取更大的单位（小时 > 分钟 > 秒）。
//   * 不能简单地「先试分钟再试秒」：「先焯水 30 秒，再炖 20 分钟」会选中后者，
//     而用户此刻要做的恰恰是前 30 秒那步。
//   * 也不能只按单位优先级：「炖 1 小时 30 分钟」里两个单位都在，必须取前面的 1 小时，
//     否则从「1 小时」里拿到 30 变成 30 分钟，错一个数量级。
function parseDuration(text) {
    const source = String(text === null || text === undefined ? '' : text);
    if (source === '') return 0;

    const amount = '([0-9]+(?:\\.[0-9]+)?|[一二两三四五六七八九十]+|半|一刻)';
    const units = [
        { rank: 0, factor: 3600, pattern: new RegExp(amount + '\\s*(?:个)?\\s*小时', 'g') },
        { rank: 1, factor: 60, pattern: new RegExp(amount + '\\s*(?:分钟|分)', 'g') },
        { rank: 2, factor: 1, pattern: new RegExp(amount + '\\s*秒', 'g') },
    ];

    let best = null;
    units.forEach((unit) => {
        unit.pattern.lastIndex = 0;
        let hit = unit.pattern.exec(source);
        while (hit) {
            const value = parseNumber(hit[1]);
            if (value !== null) {
                const candidate = {
                    index: hit.index,
                    rank: unit.rank,
                    seconds: Math.round(value * unit.factor),
                };
                if (best === null
                    || candidate.index < best.index
                    || (candidate.index === best.index && candidate.rank < best.rank)) {
                    best = candidate;
                }
            }
            hit = unit.pattern.exec(source);
        }
    });

    return best === null ? 0 : best.seconds;
}

function formatClock(totalSeconds) {
    const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
}

module.exports = {
    parseDuration,
    formatClock,
    parseNumber,
};
