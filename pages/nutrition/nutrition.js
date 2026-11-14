// 营养统计（M12）：今日环形 + 三大营养素进度条 + 近 7 天趋势 + 一句话总结。
//
// 数据链：AI 配菜时模型在菜谱里给出 nutrition（server/prompts.js RECIPE 规则 8）
// → 存进 recipe_favorite.nutrition → 做完打卡时 SECURITY DEFINER 函数把这份
// nutrition 拷一份快照进 consumption_log.nutrition → 本页调 nutrition_daily 聚合。
//
// 页面不做任何营养计算：数字全部来自 RPC，这个文件只负责调用与拼装展示结构
// （真正的纯计算在 utils/nutrition.js，那份可以单测）。
const guard = require('../../utils/auth-guard');
const mealPlan = require('../../utils/meal-plan');
const nutrition = require('../../utils/nutrition');

const RANGE_DAYS = 7;

Page({
    data: {
        authState: 'checking',
        loading: true,
        error: '',
        goalKcal: nutrition.GOALS.kcal,
        today: { kcal: 0, protein: 0, carb: 0, fat: 0, meals: 0, estimated: 0 },
        ringStyle: '',
        ringPercent: 0,
        macros: [],
        bars: [],
        summary: null,
    },

    onShow() {
        this.load();
    },

    onPullDownRefresh() {
        this.load(true);
    },

    async load(fromPull) {
        const context = await guard.check(this);
        if (!context) {
            if (fromPull) wx.stopPullDownRefresh();
            return;
        }
        mealPlan.setScope(context.space.id, context.meName);

        const result = await mealPlan.nutritionDaily(RANGE_DAYS);
        if (fromPull) wx.stopPullDownRefresh();
        if (result.error) {
            this.setData({
                loading: false,
                authState: 'ready',
                error: guard.errorText(result.error),
            });
            return;
        }

        // RPC 只返回有记录的日子；fillDays 补齐成连续 7 天，趋势图才不会断柱。
        const days = nutrition.fillDays(result.days, RANGE_DAYS, new Date());
        const today = nutrition.todayOf(days);
        this.setData({
            loading: false,
            authState: 'ready',
            error: '',
            today: today,
            ringStyle: nutrition.ringStyle(today.kcal, nutrition.GOALS.kcal),
            ringPercent: nutrition.ringPercent(today.kcal, nutrition.GOALS.kcal),
            macros: nutrition.macroRows(today),
            bars: nutrition.barRows(days, nutrition.GOALS.kcal),
            summary: nutrition.summarize(days),
        });
    },

    onGoConsumption() {
        wx.navigateTo({ url: '/pages/consumption/consumption' });
    },
});
