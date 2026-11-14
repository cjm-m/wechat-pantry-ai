// 收藏：两个人收藏的菜谱都在这里，按收藏时间倒序。
const guard = require('../../utils/auth-guard');
const recipesApi = require('../../utils/recipes');
const { relativeTime, ownerText } = require('../../utils/format');

Page({
    data: {
        authState: 'checking',
        loading: true,
        error: '',
        items: [],
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
        recipesApi.setScope(context.space.id, context.meName);

        const result = await recipesApi.list();
        if (fromPull) wx.stopPullDownRefresh();
        if (result.error) {
            this.setData({ loading: false, error: guard.errorText(result.error) });
            return;
        }
        const items = (result.items || []).map((item) => ({
            id: item.id,
            title: item.title,
            summary: item.summary,
            timeText: relativeTime(item.createdAt),
            ownerLabel: ownerText(item.ownerId, context.meId),
            stepCount: item.steps.length,
        }));
        this.setData({ loading: false, error: '', items: items });
    },

    onOpen(event) {
        wx.navigateTo({
            url: '/pages/recipe-detail/recipe-detail?id=' + event.currentTarget.dataset.id,
        });
    },

    onGoCook() {
        wx.switchTab({ url: '/pages/cook/cook' });
    },
});
