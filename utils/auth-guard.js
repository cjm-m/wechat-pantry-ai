// tab 页共用的登录守卫：三种状态分流 + 跳转去重。
// tab 页不能用 navigateTo，出主界面统一 reLaunch，回主界面统一 switchTab。

let lastRedirectAt = 0;
let lastRedirectUrl = '';

function redirectOnce(url) {
    const now = Date.now();
    if (url === lastRedirectUrl && now - lastRedirectAt < 1500) return;
    lastRedirectAt = now;
    lastRedirectUrl = url;
    wx.reLaunch({ url: url });
}

// 返回上下文；返回 null 表示已经发生跳转，页面不要继续 setData。
// 走 app 层的 Promise 缓存：同一前台会话内切 tab 不会重复查库，省资源点。
async function check(page) {
    const first = page.__contextReady !== true;
    if (first) page.setData({ authState: 'checking' });

    let context;
    try {
        context = await getApp().ensureContext();
    } catch (error) {
        context = { session: null, space: null, error: { message: '网络异常，请重试' } };
    }
    // 读不到会话又带着错误 = 网络/服务异常。交给启动页统一展示「连不上服务器 + 重试」，
    // 避免每个页面各写一套错误界面，也避免停在半渲染的白屏上。
    if (context.error && !context.session) {
        page.setData({ authState: 'signed-out' });
        redirectOnce('/pages/index/index');
        return null;
    }
    // 读到了会话、但读小家信息时报错（典型是 401 / 网络抖动）= 读失败，不是「没加入」。
    // 这种情况以前会掉进下面的 !space 分支，把已绑定的人送去绑定页 ——
    // 实际观测到的复现就是这么来的（服务器日志里那次 401）。
    // 统一去启动页重试：那里有「重试」按钮，且不会让人以为要重新建家。
    if (context.error && context.session) {
        page.setData({ authState: 'signed-out' });
        redirectOnce('/pages/index/index');
        return null;
    }
    if (!context.session) {
        page.setData({ authState: 'signed-out' });
        redirectOnce('/pages/login/login');
        return null;
    }
    if (!context.space) {
        // 到这里才是真的「登录正常、也确实没有小家」。
        page.setData({ authState: 'signed-out' });
        redirectOnce('/pages/space/space');
        return null;
    }

    page.__contextReady = true;
    page.setData({ authState: 'ready' });
    return context;
}

function errorText(error) {
    if (!error) return '操作失败，请重试';
    return error.message || '操作失败，请重试';
}

module.exports = {
    redirectOnce,
    check,
    errorText,
};
