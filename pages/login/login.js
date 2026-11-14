// 登录：微信一键登录为主，邮箱验证码作兜底。
// 两种方式拿到的是两个独立身份，平台不提供合并能力，所以页面上必须提示「两人用同一种方式登录」。
const { cloud } = require('../../utils/cloud');
const { friendlyAuthError } = require('../../utils/auth-error');

// 真机上没有 devtools 时，这条日志是唯一的现场证据：只记状态与错误码，不记 code 本身。
function logLoginFailure(error) {
    const detail = error && typeof error === 'object' ? error : { message: String(error || '') };
    console.error('[login] 微信登录失败', JSON.stringify({
        status: Number(detail.status || 0),
        code: String(detail.code || ''),
        message: String(detail.message || '').slice(0, 300),
    }));
}

Page({
    data: {
        wechatLoading: false,
        error: '',
        showEmail: false,
    },

    onShow() {
        this.redirectIfSignedIn();
    },

    async redirectIfSignedIn() {
        try {
            const result = await cloud.auth.getSession();
            if (result && !result.error && result.data) {
                this.goNext();
            }
        } catch (error) {
            // 读不到会话就留在登录页。
        }
    },

    async goNext() {
        getApp().resetAuth();
        let context = null;
        try {
            context = await getApp().ensureContext();
        } catch (error) {
            context = null;
        }
        if (context && context.space) {
            wx.switchTab({ url: '/pages/home/home' });
            return;
        }
        wx.reLaunch({ url: '/pages/space/space' });
    },

    onWechatLogin() {
        if (this.data.wechatLoading) return;
        this.setData({ wechatLoading: true, error: '' });
        wx.login({
            success: async (res) => {
                const code = res && res.code ? String(res.code) : '';
                // 空 code 会被 SDK 拦成 "signInWithWechat requires code"，一样看不懂；
                // 这里先本地兜住，并说清是「没拿到凭证」而不是「服务端拒绝」。
                if (!code) {
                    console.error('[login] wx.login 未返回 code');
                    this.setData({
                        wechatLoading: false,
                        error: '没拿到微信登录凭证（code 为空），请退出小程序重新进入后再试。',
                        showEmail: true,
                    });
                    return;
                }
                try {
                    const appid = wx.getAccountInfoSync().miniProgram.appId;
                    const result = await cloud.auth.signInWithWechat(code, appid);
                    if (!result || result.error) {
                        logLoginFailure(result && result.error);
                        this.setData({
                            wechatLoading: false,
                            error: friendlyAuthError(result && result.error, '微信登录没有成功，试试下面的邮箱登录'),
                            showEmail: true,
                        });
                        return;
                    }
                    this.setData({ wechatLoading: false });
                    this.goNext();
                } catch (error) {
                    logLoginFailure(error);
                    this.setData({
                        wechatLoading: false,
                        error: friendlyAuthError(error, '微信登录没有成功，试试下面的邮箱登录'),
                        showEmail: true,
                    });
                }
            },
            fail: (error) => {
                console.error('[login] wx.login fail', (error && error.errMsg) || '');
                this.setData({
                    wechatLoading: false,
                    error: '当前环境用不了微信登录，先用邮箱验证码进来',
                    showEmail: true,
                });
            },
        });
    },

    onToggleEmail() {
        this.setData({ showEmail: !this.data.showEmail, error: '' });
    },

    onSignedIn() {
        this.setData({ error: '' });
        this.goNext();
    },
});
