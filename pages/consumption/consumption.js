// 消耗记录（M4）：只读列表，看「这个月做过什么、动了哪些食材」。
//
// consumption_log 是 RPC-only 表，客户端直读 42501，所以必须走
// consumption_list（SECURITY DEFINER）。它返回的是原始行，
// 这里负责按展示需要拆成「菜名 + 动了几样 + 具体哪几样」。
const guard = require('../../utils/auth-guard');
const mealPlan = require('../../utils/meal-plan');
const { relativeTime } = require('../../utils/format');

Page({
    data: {
        authState: 'checking',
        loading: true,
        error: '',
        items: [],
        totalRemoved: 0,
        stats: [],
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

        const result = await mealPlan.listConsumption(100);
        if (fromPull) wx.stopPullDownRefresh();
        if (result.error) {
            this.setData({ loading: false, error: guard.errorText(result.error) });
            return;
        }

        let totalRemoved = 0;
        const items = result.items.map((row) => {
            totalRemoved += row.removedCount;
            return {
                id: row.id,
                title: row.dishTitle || (row.fromPlan ? '（菜品已删除）' : '点菜'),
                timeText: relativeTime(row.createdAt),
                sourceText: row.fromPlan ? '周计划' : '点菜',
                namesText: row.removedNames.join('、'),
                count: row.removedCount,
            };
        });

        this.setData({
            loading: false,
            error: '',
            items: items,
            totalRemoved: totalRemoved,
        });
    },

    // M12：营养统计入口。放在这里而不是只放「我的」，是因为用户看完
    // 「做过哪些菜」的自然下一问就是「这些菜一共吃了多少」。
    onGoNutrition() {
        wx.navigateTo({ url: '/pages/nutrition/nutrition' });
    },
});
