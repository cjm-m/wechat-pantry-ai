// 绑定小家：建一个，或者用邀请码加入 TA 的。
// 已在本小家里的人进来会直接被送回冰箱，不会重复建。
const { createSpace, joinSpace } = require('../../utils/context');

Page({
    data: {
        ready: false,
        meLabel: '',
        name: '',
        code: '',
        creating: false,
        joining: false,
        error: '',
    },

    onLoad() {
        this.check();
    },

    async check() {
        getApp().resetAuth();
        let context = null;
        try {
            context = await getApp().ensureContext();
        } catch (error) {
            context = null;
        }
        if (!context || !context.session) {
            wx.reLaunch({ url: '/pages/login/login' });
            return;
        }
        // 读小家信息失败（401 / 网络抖动）不能直接展示「建家/加入」表单 ——
        // 用户会以为自己的家没了。回启动页重试。
        if (context.error) {
            wx.reLaunch({ url: '/pages/index/index' });
            return;
        }
        if (context.space) {
            wx.switchTab({ url: '/pages/home/home' });
            return;
        }
        this.setData({ ready: true, meLabel: context.meName || '已登录' });
    },

    onNameInput(event) {
        this.setData({ name: event.detail.value, error: '' });
    },

    onCodeInput(event) {
        const raw = String(event.detail.value || '');
        const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
        this.setData({ code: clean, error: '' });
    },

    async onCreate() {
        if (this.data.creating) return;
        this.setData({ creating: true, error: '' });
        const result = await createSpace(this.data.name);
        this.setData({ creating: false });
        if (result.error) {
            this.setData({ error: result.error.message || '创建失败，请重试' });
            return;
        }
        this.finish();
    },

    async onJoin() {
        if (this.data.joining) return;
        const code = this.data.code;
        if (code.length !== 6) {
            this.setData({ error: '邀请码是 6 位字母或数字' });
            return;
        }
        this.setData({ joining: true, error: '' });
        const result = await joinSpace(code);
        this.setData({ joining: false });
        if (result.error) {
            this.setData({ error: result.error.message || '加入失败，请重试' });
            return;
        }
        this.finish();
    },

    finish() {
        getApp().resetAuth();
        wx.switchTab({ url: '/pages/home/home' });
    },
});
