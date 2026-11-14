// 冷启动分流：登录页 / 绑定页 / 主界面，只在这里决定一次。
const { redirectOnce } = require('../../utils/auth-guard');

Page({
    data: {
        state: 'loading',
        errorText: '',
    },

    onLoad() {
        this.boot();
    },

    async boot() {
        getApp().resetAuth();
        let context;
        try {
            context = await getApp().ensureContext();
        } catch (error) {
            this.setData({ state: 'error', errorText: '网络好像不太顺，重试一下' });
            return;
        }
        if (context.error && !context.session) {
            this.setData({ state: 'error', errorText: context.error.message || '网络好像不太顺，重试一下' });
            return;
        }
        if (!context.session) {
            redirectOnce('/pages/login/login');
            return;
        }
        if (!context.space) {
            redirectOnce('/pages/space/space');
            return;
        }
        wx.switchTab({ url: '/pages/home/home' });
    },

    onRetry() {
        this.setData({ state: 'loading', errorText: '' });
        this.boot();
    },
});
