// 消息中心：所有提醒的最终落点。
//
// 订阅消息发不出去（额度用完、用户拒收、邮箱账号没有 openid）时，那条消息一定在这里；
// 高频的业务事件（TA 加了食材、收藏了菜谱）也只会在这里，不去占订阅额度。

const guard = require('../../utils/auth-guard');
const notify = require('../../utils/notify');

// tabBar 页面不能用 navigateTo，必须走 switchTab，否则点击消息会静默失败。
const TAB_PAGES = [
    '/pages/home/home',
    '/pages/fridge/fridge',
    '/pages/cook/cook',
    '/pages/cart/cart',
    '/pages/me/me',
];

function openPage(url) {
    if (!url) return;
    if (TAB_PAGES.indexOf(url) >= 0) {
        wx.switchTab({ url: url });
        return;
    }
    wx.navigateTo({
        url: url,
        fail: () => {
            wx.switchTab({ url: '/pages/home/home' });
        },
    });
}

Page({
    data: {
        authState: 'checking',
        items: [],
        unread: 0,
        loading: true,
        error: '',
        marking: false,
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

        notify.setScope(context.space.id, context.meId);

        const result = await notify.list({ limit: 50 });
        if (fromPull) wx.stopPullDownRefresh();

        const items = result.items || [];
        const summary = notify.summaryOf(items);
        this.setData({
            loading: false,
            items: items,
            unread: summary.unread,
            error: result.error ? guard.errorText(result.error) : '',
        });
    },

    // 先改本地状态再发请求：点一下的反馈必须是即时的，不能等网络往返。
    // 请求失败也不回滚——下次进页面会以服务端为准重新渲染。
    async onTapItem(event) {
        const index = Number(event.currentTarget.dataset.index);
        const item = this.data.items[index];
        if (!item) return;

        if (item.unread) {
            const patch = {};
            patch['items[' + index + '].unread'] = false;
            patch.unread = Math.max(this.data.unread - 1, 0);
            this.setData(patch);
            notify.markRead(item.id);
        }

        openPage(item.page);
    },

    async onMarkAll() {
        if (this.data.marking || this.data.unread === 0) return;
        this.setData({ marking: true });

        const result = await notify.markAllRead();
        this.setData({ marking: false });

        if (result.error) {
            wx.showToast({ title: guard.errorText(result.error), icon: 'none' });
            return;
        }

        const items = this.data.items.map((item) => {
            if (!item.unread) return item;
            return Object.assign({}, item, { unread: false });
        });
        this.setData({ items: items, unread: 0 });
    },
});
