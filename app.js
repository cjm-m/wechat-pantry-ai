const { cloud } = require('./utils/cloud');
const { loadContext } = require('./utils/context');
const notifySettings = require('./utils/notify-settings');
const selection = require('./utils/selection');

// 会话上下文在前台的复用窗口：回到前台不足这么久就不重算。
// 为什么要有：会话/成员/小家这三行数据在小程序生命周期内几乎不变，
// 但 onShow 每次回前台都会触发，重算一次 = 1 次 getSession + 2 次查表。
// 30 秒足以挡掉「切出去看一眼微信再回来」这类高频抖动，
// 又不会让「换了账号/刚加入小家」这类真实变化等太久；
// 各页面自己的列表数据仍然每次 onShow 重拉，两个人共享的东西不会变陈旧。
const CONTEXT_REUSE_MS = 30000;

App({
    globalData: {
        appName: '我们的小家',
    },

    contextPromise: null,

    // 上一次成功算出上下文的时刻（ms）；0 表示还没有。
    contextAt: 0,

    onLaunch() {
        selection.init();
        try {
            cloud.auth.onAuthStateChange((event) => {
                const name = event && (event.event || event.type);
                if (name === 'SIGNED_OUT') {
                    this.resetAuth();
                }
            });
        } catch (error) {
            // 订阅失败不影响使用：每次进页面仍会重新校验登录态。
        }
    },

    onShow() {
        // 回到前台超过复用窗口才重算；窗口内保留缓存，省掉一轮无意义的请求。
        if (Date.now() - this.contextAt > CONTEXT_REUSE_MS) {
            this.resetAuth();
        }
    },

    // 登录态 + 小家信息，带一个 Promise 缓存；多个 tab 同时进入只发一轮请求。
    ensureContext() {
        if (!this.contextPromise) {
            this.contextPromise = loadContext().then((context) => {
                this.contextAt = Date.now();
                // 绑定 openid 是副作用：不 await、不抛出，失败不能影响登录态。
                // 放在这里而不是各页面，是因为 context 一次前台会话只算一遍。
                notifySettings.ensureBind(context);
                return context;
            });
        }
        return this.contextPromise;
    },

    resetAuth() {
        this.contextPromise = null;
        this.contextAt = 0;
    },
});
