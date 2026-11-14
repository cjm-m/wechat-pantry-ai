// 收藏详情：食材表 + 做法，可以在这里取消收藏。
const guard = require('../../utils/auth-guard');
const recipesApi = require('../../utils/recipes');
const { relativeTime, ownerText } = require('../../utils/format');

Page({
    data: {
        authState: 'checking',
        loading: true,
        error: '',
        item: null,
        removing: false,
    },

    onLoad(query) {
        this.recordId = query && query.id ? String(query.id) : '';
        this.load();
    },

    async load() {
        const context = await guard.check(this);
        if (!context) return;
        recipesApi.setScope(context.space.id, context.meName);

        if (!this.recordId) {
            this.setData({ loading: false, authState: 'ready', error: '没有找到这道菜' });
            return;
        }
        const result = await recipesApi.get(this.recordId);
        if (result.error || !result.item) {
            this.setData({
                loading: false,
                authState: 'ready',
                error: result.error ? guard.errorText(result.error) : '这道菜可能已经被取消了收藏',
            });
            return;
        }
        const item = result.item;
        this.setData({
            loading: false,
            authState: 'ready',
            item: {
                id: item.id,
                title: item.title,
                summary: item.summary,
                steps: item.steps,
                nutrition: item.nutrition || null,
                used: item.used.map((unit) => ({
                    name: unit.name,
                    amount: unit.amount,
                    fromFridge: unit.fromFridge,
                })),
                timeText: relativeTime(item.createdAt),
                ownerLabel: ownerText(item.ownerId, context.meId),
            },
        });
    },

    // M11：进全屏烹饪模式。整份菜谱不通过 URL 传（有长度限制，steps 可能十几条），
    // 只传 id，cook-mode 页自己用同一个 recipesApi.get 拉一遍。
    onStartCooking() {
        const item = this.data.item;
        if (!item) return;
        wx.navigateTo({ url: '/pages/cook-mode/cook-mode?recipeId=' + item.id });
    },

    // 点菜入口：带上菜名和菜谱 id，配菜页那头能直接算缺料。
    onWantThis() {
        const item = this.data.item;
        if (!item) return;
        wx.navigateTo({
            url: '/pages/dish-edit/dish-edit?recipeId=' + item.id
                + '&title=' + encodeURIComponent(item.title),
        });
    },

    onRemove() {
        if (this.data.removing) return;
        wx.showModal({
            title: '取消收藏？',
            content: '两个人的收藏列表里都会移除这道菜。',
            confirmText: '取消收藏',
            confirmColor: '#C0392B',
            success: async (res) => {
                if (!res.confirm) return;
                this.setData({ removing: true });
                const result = await recipesApi.remove(this.recordId);
                if (result.error) {
                    this.setData({ removing: false });
                    wx.showToast({ title: guard.errorText(result.error), icon: 'none' });
                    return;
                }
                this.setData({ removing: false });
                wx.navigateBack();
            },
        });
    },
});
