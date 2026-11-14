// 营养统计（M12）—— 纯计算 + 一张目标表，零网络、零副作用、可单测。
//
// 数据从哪来：`mealPlan.nutritionDaily(days)` 调 `nutrition_daily` RPC，
// 拿回来的是已经按本地日分好桶的 [{day, kcal, protein, carb, fat, meals, estimated}]。
// 这个模块只负责把数字翻译成「环形百分比 / 进度条 / 一句话总结」，不碰网络。
//
// 为什么营养是「估算」而不是精算：数值由 LLM 在生成菜谱时一并给出
// （server/prompts.js 的 RECIPE 规则 8），依据是 used 里的自由文本用量
// （「500g」「2 个」「一小把」）。ingredient.quantity 也是 TEXT，从来没有数值口径。
// 所以全部结果都带 approx 语义，页面必须显式标「约」，不能当成营养标签用。

// 每日目标：参考中国居民膳食指南的成年女性/男性折中值（轻体力活动）。
// 两个年轻人共用一个目标，是刻意的取舍——按性别/体重分别建表需要一份
// 用户档案，而这个 App 连「谁是谁」都只有 openid，不值得为此加一张表。
const GOALS = {
    kcal: 2000,
    protein: 60,
    carb: 250,
    fat: 65,
};

const MACROS = [
    { key: 'protein', label: '蛋白质', unit: 'g', goal: GOALS.protein },
    { key: 'carb', label: '碳水', unit: 'g', goal: GOALS.carb },
    { key: 'fat', label: '脂肪', unit: 'g', goal: GOALS.fat },
];

function clampPercent(value) {
    const number = Number(value);
    if (!isFinite(number) || number <= 0) return 0;
    if (number >= 100) return 100;
    return Math.round(number);
}

// 环形进度：conic-gradient 需要 0..100 的百分比。超目标时钉在 100（环形画不出来
// 「超过一圈」），但数字仍按真实值显示——把 2500 显示成 2000 是撒谎。
function ringPercent(value, goal) {
    const total = Number(goal) > 0 ? Number(goal) : GOALS.kcal;
    return clampPercent((Number(value) / total) * 100);
}

function ringStyle(value, goal) {
    const percent = ringPercent(value, goal);
    return 'background: conic-gradient(var(--primary) 0% ' + percent + '%, var(--line) ' + percent + '% 100%);';
}

function macroRows(nutrition) {
    const source = nutrition || {};
    return MACROS.map((macro) => {
        const value = Number(source[macro.key]) || 0;
        return {
            key: macro.key,
            label: macro.label,
            unit: macro.unit,
            value: Math.round(value),
            goal: macro.goal,
            percent: ringPercent(value, macro.goal),
            style: 'width: ' + ringPercent(value, macro.goal) + '%;',
        };
    });
}

// 把「日」补齐成连续 N 天：RPC 只返回有记录的日子，趋势图需要连成一条不断开的柱。
// 缺失的日子补 0 且 meals=0，前端据 meals===0 画成空心柱而不是实心 0。
function fillDays(rows, days, today) {
    const count = Math.max(1, Math.min(Number(days) || 7, 30));
    const map = {};
    (rows || []).forEach((row) => {
        if (row && row.day) map[String(row.day).slice(0, 10)] = row;
    });

    const base = today ? new Date(today.getFullYear(), today.getMonth(), today.getDate()) : new Date();
    const out = [];
    for (let i = count - 1; i >= 0; i -= 1) {
        const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() - i);
        const key = [
            d.getFullYear(),
            String(d.getMonth() + 1).padStart(2, '0'),
            String(d.getDate()).padStart(2, '0'),
        ].join('-');
        const hit = map[key];
        out.push({
            day: key,
            label: String(d.getDate()),
            kcal: hit ? hit.kcal : 0,
            protein: hit ? hit.protein : 0,
            carb: hit ? hit.carb : 0,
            fat: hit ? hit.fat : 0,
            meals: hit ? hit.meals : 0,
            estimated: hit ? hit.estimated : 0,
        });
    }
    return out;
}

// 柱状图高度：相对窗口内最大值的百分比。全是 0 时统一给 6%，
// 否则柱子高度 0 会让整块区域看起来像没加载出来。
function barRows(days, goal) {
    const list = days || [];
    const max = list.reduce((best, day) => Math.max(best, Number(day.kcal) || 0), 0);
    const ceiling = max > 0 ? max : (Number(goal) || GOALS.kcal);
    return list.map((day) => {
        const kcal = Number(day.kcal) || 0;
        const height = kcal > 0 ? Math.max(6, Math.round((kcal / ceiling) * 100)) : 4;
        return {
            day: day.day,
            label: day.label,
            kcal: kcal,
            meals: Number(day.meals) || 0,
            empty: kcal === 0,
            style: 'height: ' + height + '%;',
        };
    });
}

function summarize(days) {
    const list = days || [];
    let kcal = 0;
    let meals = 0;
    let estimated = 0;
    let activeDays = 0;
    list.forEach((day) => {
        kcal += Number(day.kcal) || 0;
        meals += Number(day.meals) || 0;
        estimated += Number(day.estimated) || 0;
        if ((Number(day.meals) || 0) > 0) activeDays += 1;
    });

    if (meals === 0) {
        return {
            empty: true,
            avgKcal: 0,
            activeDays: 0,
            meals: 0,
            missing: 0,
            text: '还没有消耗记录。做一道菜并打卡，这里就会开始有数。',
        };
    }

    const missing = meals - estimated;
    const avgKcal = activeDays > 0 ? Math.round(kcal / activeDays) : 0;
    // 「缺估算」必须说出来：只报总量会让用户以为这就是全部摄入，
    // 而实际上漏掉的那几餐可能占了一大半。
    const text = missing === 0
        ? '有记录的 ' + activeDays + ' 天里，平均每天约 ' + avgKcal + ' 千卡。'
        : '有记录的 ' + activeDays + ' 天里，平均每天约 ' + avgKcal + ' 千卡；'
            + '其中 ' + missing + ' 餐没有营养估算（手写菜名或模型没给），未计入。';
    return {
        empty: false,
        avgKcal: avgKcal,
        activeDays: activeDays,
        meals: meals,
        missing: missing,
        text: text,
    };
}

// 今天那一格（RPC 按日倒序，最后一个是今天——fillDays 已补齐连续日期）。
function todayOf(days) {
    const list = days || [];
    if (list.length === 0) {
        return { day: '', kcal: 0, protein: 0, carb: 0, fat: 0, meals: 0, estimated: 0 };
    }
    return list[list.length - 1];
}

module.exports = {
    GOALS,
    MACROS,
    ringPercent,
    ringStyle,
    macroRows,
    fillDays,
    barRows,
    summarize,
    todayOf,
};
