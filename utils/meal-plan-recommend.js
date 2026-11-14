// 菜谱推荐打分（N9）—— 纯函数，零网络、零副作用、可单测。
//
// 权重：临期 0.35 / 覆盖 0.30 / 多样性 0.20 / 偏好 0.15。
// 这版 pref 恒为中性 0.5（M7 个性化才实现），avoid 机制先留着、传空数组。
//
// 为什么在客户端而不是服务端：服务端现在只有「被 cron 或 HTTP 直接调用」的 4 个文件，
// 没有能放业务纯计算的位置（设计 §13 决策 3）。纯函数放客户端的好处是页面能同步拿到
// 分数、能直接在手机上改权重试效果；坏处是 M5 Agent 将来要用得再搬一次——那时再说。

const { levelOf, normalizeName } = require('./pantry-match');

const WEIGHTS = {
    expire: 0.35,
    cover: 0.30,
    variety: 0.20,
    pref: 0.15,
};

// 临期阈值：3 天内的算全分，7 天以上算 0，中间线性。
const EXPIRE_FULL_DAYS = 3;
const EXPIRE_ZERO_DAYS = 7;

const NEUTRAL_PREF = 0.5;

function clamp01(value) {
    if (!isFinite(value)) return 0;
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
}

function textOf(value) {
    return value === null || value === undefined ? '' : String(value);
}

// 距过期还有几天（本地时间，按日历天算，不按 24 小时）。
// expireAt 是 'YYYY-MM-DD'（DATE 列，无时区）。空值 → null（表示「没有保质期」）。
function daysUntil(expireAt, today) {
    const raw = textOf(expireAt).slice(0, 10);
    if (raw === '') return null;
    const parts = raw.split('-');
    if (parts.length !== 3) return null;
    const target = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    if (isNaN(target.getTime())) return null;
    const base = today ? new Date(today.getFullYear(), today.getMonth(), today.getDate())
        : (function () {
            const now = new Date();
            return new Date(now.getFullYear(), now.getMonth(), now.getDate());
        }());
    const diff = Math.round((target.getTime() - base.getTime()) / 86400000);
    return isFinite(diff) ? diff : null;
}

// 临期分：取这道菜用到的食材里**最紧迫**的那个。
// 没有保质期的食材不参与（不能假设它们临期，否则所有菜都会被拉平）。
function expireScore(used, inventory, today) {
    let best = 0;
    let bestName = '';
    let bestDays = null;

    (used || []).forEach((unit) => {
        if (!unit || unit.fromFridge === false) return;
        const key = normalizeName(unit.name);
        if (key === '') return;
        for (let i = 0; i < (inventory || []).length; i += 1) {
            const row = inventory[i];
            if (normalizeName(row && row.name) !== key) continue;
            const days = daysUntil(row && row.expireAt, today);
            if (days === null) continue;
            const score = days <= EXPIRE_FULL_DAYS
                ? 1
                : (days >= EXPIRE_ZERO_DAYS
                    ? 0
                    : 1 - (days - EXPIRE_FULL_DAYS) / (EXPIRE_ZERO_DAYS - EXPIRE_FULL_DAYS));
            if (score > best) {
                best = score;
                bestName = row.name;
                bestDays = days;
            }
            break;
        }
    });

    return { score: clamp01(best), name: bestName, days: bestDays };
}

// 覆盖分：这道菜需要的主料里，冰箱能提供的比例。
// 复用 pantry.levelOf 的三档（have / maybe / miss），maybe 算半分——
// 「鸡蛋面」对「鸡蛋」这种拿不准的情况，不该和「完全没有」同分。
function coverScore(used, inventory) {
    const stockNames = (inventory || []).map((row) => (row && row.name) || '').filter((name) => name !== '');
    let total = 0;
    let got = 0;

    (used || []).forEach((unit) => {
        if (!unit || unit.fromFridge === false) return;
        const name = textOf(unit.name).trim();
        if (name === '') return;
        total += 1;
        const matched = levelOf(name, stockNames);
        if (matched.level === 'have') got += 1;
        else if (matched.level === 'maybe') got += 0.5;
    });

    if (total === 0) return { score: 0, have: 0, maybe: 0, total: 0 };
    return { score: clamp01(got / total), have: got, maybe: 0, total: total };
}

// 多样性分：与本周已排的菜重合度越低越好。
// 重合按「食材名的归一化集合」算 Jaccard，取与已排菜品里最高的那个作为惩罚基准。
function varietyScore(used, planned) {
    const mine = {};
    (used || []).forEach((unit) => {
        if (!unit || unit.fromFridge === false) return;
        const key = normalizeName(unit.name);
        if (key !== '') mine[key] = true;
    });
    const mineKeys = Object.keys(mine);
    if (mineKeys.length === 0) return { score: 1, overlapWith: '' };
    if (!Array.isArray(planned) || planned.length === 0) return { score: 1, overlapWith: '' };

    let worst = 0;
    let worstTitle = '';
    planned.forEach((row) => {
        const theirs = {};
        ((row && row.used) || []).forEach((unit) => {
            if (!unit || unit.fromFridge === false) return;
            const key = normalizeName(unit.name);
            if (key !== '') theirs[key] = true;
        });
        const theirKeys = Object.keys(theirs);
        if (theirKeys.length === 0) return;
        let shared = 0;
        mineKeys.forEach((key) => {
            if (theirs[key]) shared += 1;
        });
        const union = mineKeys.length + theirKeys.length - shared;
        const jaccard = union > 0 ? shared / union : 0;
        if (jaccard > worst) {
            worst = jaccard;
            worstTitle = (row && row.title) || '';
        }
    });

    return { score: clamp01(1 - worst), overlapWith: worstTitle };
}

// 偏好分：这版恒为中性。M7 接 user_prefs 后再实现。
function prefScore() {
    return { score: NEUTRAL_PREF, hit: '' };
}

// 主入口。
// candidates: [{ title, used: [{name, amount, fromFridge}], ...}]
// inventory:  [{ name, expireAt, category }]
// planned:    [{ title, used }]          本周已排的，用于多样性惩罚
// prefs:      { avoid: ['香菜', ...] }   命中即整条剔除（不是打低分）
// today:      Date，可省略（默认今天）—— 传进来是为了单测可复现
function scoreDishes(options) {
    const opts = options || {};
    const candidates = Array.isArray(opts.candidates) ? opts.candidates : [];
    const inventory = Array.isArray(opts.inventory) ? opts.inventory : [];
    const planned = Array.isArray(opts.planned) ? opts.planned : [];
    const avoid = (opts.prefs && Array.isArray(opts.prefs.avoid)) ? opts.prefs.avoid : [];
    const today = opts.today || null;

    const avoidKeys = avoid.map(normalizeName).filter((key) => key !== '');

    const scored = [];
    candidates.forEach((candidate) => {
        if (!candidate || !candidate.title) return;
        const used = Array.isArray(candidate.used) ? candidate.used : [];

        // 一票否决：菜名或任一食材命中忌口，整道菜不出现在结果里。
        // 为什么是剔除而不是打低分：忌口/过敏不是「不太想吃」，是「不能吃」。
        let vetoed = false;
        let vetoReason = '';
        const titleKey = normalizeName(candidate.title);
        for (let i = 0; i < avoidKeys.length; i += 1) {
            if (titleKey.indexOf(avoidKeys[i]) >= 0) {
                vetoed = true;
                vetoReason = candidate.title;
                break;
            }
        }
        if (!vetoed) {
            for (let i = 0; i < used.length; i += 1) {
                const nameKey = normalizeName(used[i] && used[i].name);
                for (let j = 0; j < avoidKeys.length; j += 1) {
                    if (nameKey !== '' && nameKey.indexOf(avoidKeys[j]) >= 0) {
                        vetoed = true;
                        vetoReason = (used[i] && used[i].name) || '';
                        break;
                    }
                }
                if (vetoed) break;
            }
        }
        if (vetoed) return;

        const expire = expireScore(used, inventory, today);
        const cover = coverScore(used, inventory);
        const variety = varietyScore(used, planned);
        const pref = prefScore();

        const score = WEIGHTS.expire * expire.score
            + WEIGHTS.cover * cover.score
            + WEIGHTS.variety * variety.score
            + WEIGHTS.pref * pref.score;

        scored.push({
            candidate: candidate,
            score: Math.round(score * 1000) / 1000,
            factors: {
                expire: Math.round(expire.score * 1000) / 1000,
                cover: Math.round(cover.score * 1000) / 1000,
                variety: Math.round(variety.score * 1000) / 1000,
                pref: Math.round(pref.score * 1000) / 1000,
                expireName: expire.name,
                expireDays: expire.days,
                coverRatio: cover.total > 0 ? Math.round((cover.have / cover.total) * 100) / 100 : 0,
                overlapWith: variety.overlapWith,
            },
            reason: buildReason(expire, cover, variety),
        });
    });

    scored.sort((a, b) => b.score - a.score);
    return scored;
}

// 给每条推荐一句人话，界面直接显示。按「最值得说的那个因子」选一句，不堆所有理由。
function buildReason(expire, cover, variety) {
    if (expire.score >= 0.9 && expire.name) {
        const days = expire.days;
        if (days !== null && days <= 0) return '正好用掉今天到期的' + expire.name;
        return '用掉快过期的' + expire.name + (days !== null ? '（还剩 ' + days + ' 天）' : '');
    }
    if (cover.total > 0 && cover.score >= 0.95) return '冰箱里配料齐全';
    if (cover.total > 0 && cover.score > 0) {
        return '冰箱里能凑齐 ' + cover.have + '/' + cover.total + ' 样';
    }
    if (variety.overlapWith) return '和「' + variety.overlapWith + '」不重样';
    return '换换口味';
}

module.exports = {
    WEIGHTS,
    EXPIRE_FULL_DAYS,
    EXPIRE_ZERO_DAYS,
    daysUntil,
    expireScore,
    coverScore,
    varietyScore,
    scoreDishes,
    buildReason,
};
