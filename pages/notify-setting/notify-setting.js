// 提醒设置：只控制订阅消息（微信推送）。
//
// 站内消息不受这里影响——它永远可用。所以页面上必须把两者的区别写清楚，
// 不能让人以为关掉开关就一条提醒都收不到了。

const guard = require('../../utils/auth-guard');
const settings = require('../../utils/notify-settings');
const subscribe = require('../../utils/subscribe');

Page({
    data: {
        authState: 'checking',
        loading: true,
        enabled: true,
        remindAt: '09:00',
        canReceive: false,
        hasTemplate: false,
        saving: false,
        requesting: false,
        needSetting: false,
        error: '',
    },

    onShow() {
        this.load();
    },

    async load() {
        const context = await guard.check(this);
        if (!context) return;

        settings.setScope(context.meId);
        const result = await settings.load(context);
        const setting = result.setting;

        this.setData({
            loading: false,
            enabled: setting ? setting.enabled : true,
            remindAt: setting ? setting.remindAt : settings.DEFAULT_REMIND_AT,
            canReceive: result.canReceive,
            hasTemplate: subscribe.configuredBatches() > 0,
            error: result.error ? guard.errorText(result.error) : '',
        });
    },

    // 先改 UI 再发请求；失败要回滚，否则开关会停在用户以为已经生效的位置。
    async onToggle(event) {
        const enabled = event.detail.value === true;
        const previous = !enabled;
        this.setData({ enabled: enabled });

        const result = await settings.save({ enabled: enabled });
        if (result.error) {
            this.setData({ enabled: previous });
            wx.showToast({ title: guard.errorText(result.error), icon: 'none' });
        }
    },

    async onPickTime(event) {
        const remindAt = String(event.detail.value || settings.DEFAULT_REMIND_AT).slice(0, 5);
        const previous = this.data.remindAt;
        this.setData({ remindAt: remindAt });

        const result = await settings.save({ remindAt: remindAt });
        if (result.error) {
            this.setData({ remindAt: previous });
            wx.showToast({ title: guard.errorText(result.error), icon: 'none' });
        }
    },

    // requestSubscribeMessage 必须由点击手势触发。
    // 这里刻意不在 await 之后调用，否则手势已经失效，微信会直接拒。
    onEnableWechat() {
        if (this.data.requesting) return;
        this.setData({ requesting: true, needSetting: false });

        // 一次请求多个模板：用户勾一次就能同时攒下临期和点菜的额度。
        // request() 内部会过滤掉还没配 id 的模板，所以多写不会弹空窗。
        const pending = subscribe.request(['expire', 'dish']);

        pending.then((result) => {
            this.setData({ requesting: false });

            if (result.error) {
                const needSetting = result.error.code === 20004;
                this.setData({ needSetting: needSetting });
                // 20001 只看 toast 分不出是哪个模板。整批失败后 subscribe 会逐个探测，
                // 坏掉的那几个在 details 里，真机「调试」面板里一眼能看到具体 ID。
                if (result.details && result.details.length > 0) {
                    console.warn('[subscribe] 以下模板 ID 请求失败，请到公众平台核对：', result.details);
                }
                wx.showToast({ title: result.error.message, icon: 'none' });
                return;
            }
            if (result.accepted.length > 0) {
                // 两个模板一起请求，微信可能只弹其中一个（另一个已授权会被静默返回），
                // 所以文案按实际拿到几个说，不写死「一条」。
                wx.showToast({ title: '已攒到 ' + result.accepted.length + ' 个模板的额度', icon: 'none' });
                return;
            }
            wx.showToast({ title: '这次没授权，随时可以再开', icon: 'none' });
        });
    },

    onOpenSetting() {
        wx.openSetting({});
    },
});
