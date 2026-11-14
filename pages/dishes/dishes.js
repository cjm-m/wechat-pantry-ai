// 点菜：我点的 / TA 点的分两栏。
// 动作全部走服务端函数，成功后一律重拉整张列表 —— 不做本地乐观更新，
// 否则对方在旁边接了单，我这边的按钮还会显示成「我来做」。
const guard = require('../../utils/auth-guard');
const dishesApi = require('../../utils/dishes');

Page({
    data: {
        authState: 'checking',
        error: '',
        mine: [],
        theirs: [],
        closed: [],
        pendingForMe: 0,
        busyId: '',
        showClosed: false,
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
        dishesApi.setScope(context.space.id, context.meId, context.meName);

        const result = await dishesApi.list();
        if (fromPull) wx.stopPullDownRefresh();
        if (result.error) {
            this.setData({ error: guard.errorText(result.error) });
            return;
        }
        const grouped = dishesApi.group(result.items);
        const summary = dishesApi.summarize(result.items);
        this.setData({
            error: '',
            mine: grouped.mine,
            theirs: grouped.theirs,
            closed: grouped.closed,
            pendingForMe: summary.pendingForMe,
        });
    },

    onOpen(event) {
        wx.navigateTo({ url: '/pages/dish-detail/dish-detail?id=' + event.currentTarget.dataset.id });
    },

    onGoCreate() {
        wx.navigateTo({ url: '/pages/dish-edit/dish-edit' });
    },

    onToggleClosed() {
        this.setData({ showClosed: !this.data.showClosed });
    },

    async onClaim(event) {
        const id = event.currentTarget.dataset.id;
        if (this.data.busyId) return;
        this.setData({ busyId: id });
        const result = await dishesApi.claim(id);
        this.setData({ busyId: '' });
        if (result.error) {
            wx.showToast({ title: guard.errorText(result.error), icon: 'none' });
            this.load();
            return;
        }
        wx.showToast({ title: '接下来了，好好做', icon: 'none' });
        this.load();
    },

    onCancel(event) {
        const id = event.currentTarget.dataset.id;
        wx.showModal({
            title: '取消这道菜？',
            content: 'TA 那边也会看到这道菜被取消了。',
            confirmText: '取消点菜',
            confirmColor: '#C0392B',
            success: async (res) => {
                if (!res.confirm) return;
                const result = await dishesApi.cancel(id);
                if (result.error) {
                    wx.showToast({ title: guard.errorText(result.error), icon: 'none' });
                    return;
                }
                this.load();
            },
        });
    },

    onDelete(event) {
        const id = event.currentTarget.dataset.id;
        wx.showModal({
            title: '删掉这条记录？',
            content: '删除后就看不到了，两个人都会消失。',
            confirmText: '删除',
            confirmColor: '#C0392B',
            success: async (res) => {
                if (!res.confirm) return;
                const result = await dishesApi.remove(id);
                if (result.error) {
                    wx.showToast({ title: guard.errorText(result.error), icon: 'none' });
                    return;
                }
                this.load();
            },
        });
    },
});
