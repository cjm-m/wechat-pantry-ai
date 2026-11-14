// 首页工作台：只做「入口 + 概览」，具体功能都在各自页面里，方便后续加点菜、日期提醒等模块。
const guard = require('../../utils/auth-guard');
const ingredientsApi = require('../../utils/ingredients');
const recipesApi = require('../../utils/recipes');
const shopping = require('../../utils/shopping');
const dishesApi = require('../../utils/dishes');
const notify = require('../../utils/notify');

function greetingText() {
    const hour = new Date().getHours();
    if (hour < 5) return '夜深了';
    if (hour < 11) return '早上好';
    if (hour < 14) return '中午好';
    if (hour < 18) return '下午好';
    return '晚上好';
}

Page({
    data: {
        authState: 'checking',
        greeting: '你好',
        spaceName: '我们的小家',
        stockCount: 0,
        expiringCount: 0,
        cartCount: 0,
        cartTotal: '0.00',
        dishPending: 0,
        unreadCount: 0,
        loading: true,
        error: '',
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

        ingredientsApi.setScope(context.space.id, context.meId, context.meName);
        recipesApi.setScope(context.space.id, context.meName);
        shopping.setScope(context.space.id, context.meName);
        dishesApi.setScope(context.space.id, context.meId, context.meName);
        notify.setScope(context.space.id, context.meId);

        this.setData({
            greeting: greetingText(),
            spaceName: context.space.name || '我们的小家',
        });

        // 三个模块互不依赖，并行发；任何一个失败只影响自己那块数字。
        const results = await Promise.all([
            ingredientsApi.list(),
            shopping.list(),
            dishesApi.list(),
        ]);
        const stockResult = results[0];
        const cartResult = results[1];
        const dishResult = results[2];
        if (fromPull) wx.stopPullDownRefresh();

        const items = stockResult.items || [];
        let expiring = 0;
        items.forEach((item) => {
            if (item.expire && (item.expire.level === 'danger' || item.expire.level === 'warn')) {
                expiring += 1;
            }
        });
        const summary = shopping.summarize(cartResult.items || []);
        const dishSummary = dishesApi.summarize(dishResult.items || []);

        // 先落临期消息再读未读数，顺序不能反：否则今天的第一条提醒要等下次进页面才看得到。
        // 临期同步一天只跑一次，之后的 tab 切换只有一次计数请求。
        await notify.syncExpiring(items);
        const unread = await notify.unreadCount();

        this.setData({
            loading: false,
            error: stockResult.error ? guard.errorText(stockResult.error) : '',
            stockCount: items.length,
            expiringCount: expiring,
            cartCount: (cartResult.items || []).length,
            cartTotal: summary.text,
            dishPending: dishSummary.pendingForMe,
            unreadCount: unread.count || 0,
        });
    },

    onGoFridge() {
        wx.switchTab({ url: '/pages/fridge/fridge' });
    },

    onGoCook() {
        wx.switchTab({ url: '/pages/cook/cook' });
    },

    onGoCart() {
        wx.switchTab({ url: '/pages/cart/cart' });
    },

    onGoFavorites() {
        wx.navigateTo({ url: '/pages/favorites/favorites' });
    },

    onGoNotice() {
        wx.navigateTo({ url: '/pages/notice/notice' });
    },

    onGoDishes() {
        wx.navigateTo({ url: '/pages/dishes/dishes' });
    },

    onGoMealPlan() {
        wx.navigateTo({ url: '/pages/meal-plan/meal-plan' });
    },

    onGoConsumption() {
        wx.navigateTo({ url: '/pages/consumption/consumption' });
    },

    onGoAgent() {
        wx.navigateTo({ url: '/pages/agent/agent' });
    },
});
