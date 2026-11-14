// 云服务 auth 错误 → 用户能看懂的一句话。
//
// 后端是自建网关（server/cloud-gateway.js），错误语义如下：
// 分类规则：
//   · 网关统一回 { ok:false, code, message }，code 是机器可读的那一层；
//   · 401 + code 42501 是「行级权限拒绝」，绝不能再当「登录失效」处理
//     （否则会把正常的越权/未入家误报成掉登录，并把用户踢回登录页）；
//   · 邮箱验证码登录已不支持（网关对该组端点回 501）。
//
// 入参是 SDK 的 error（{ kind, message, status, code, cause }），也兼容裸字符串。

function requestIdOf(error) {
    const cause = error && error.cause;
    if (cause && typeof cause === 'object' && typeof cause.requestId === 'string') {
        return cause.requestId;
    }
    if (error && typeof error.requestId === 'string') {
        return error.requestId;
    }
    return '';
}

function tail(error) {
    const requestId = requestIdOf(error);
    // 完整 UUID 太长挤满一行，末 8 位足够唯一。
    return requestId ? '（错误号 ' + requestId.slice(-8) + '）' : '';
}

function friendlyAuthError(rawError, fallback) {
    const error = typeof rawError === 'string' ? { message: rawError } : (rawError || {});
    const message = String(error.message || '');
    const status = Number(error.status || 0);
    const code = String(error.code || '');
    const text = code + ' ' + message;

    // status 0 / 没有响应：域名未放行、断网、超时。
    if (/domain list|request:fail|before a response was received|timeout/i.test(message)) {
        return '连不上服务器（域名没放行或网络不通）。检查后台 request 合法域名里是否加了 utils/local-config.js 里的 CLOUD_ENDPOINT。' + tail(error);
    }
    // 客户端 key 与服务端不一致：部署时最容易漏的一步。
    if (/INVALID_PUBLISHABLE_KEY/i.test(text)) {
        return '客户端和服务器对不上号（publishableKey 不一致），需要更新小程序里的 utils/cloud.js。' + tail(error);
    }
    // 行级权限拒绝：不是登录问题，别把人踢回登录页。
    if (code === '42501' || /permission denied|row-level security/i.test(text)) {
        return '这条数据没有权限访问（你可能还没加入这个小家）。' + tail(error);
    }
    // 501：邮箱验证码登录在自建后端未实现。
    if (status === 501 || /NOT_IMPLEMENTED/i.test(text)) {
        return '暂不支持邮箱验证码登录，请用微信一键登录。';
    }
    // 微信 code 缺失。
    if (/缺少 code/.test(message) || /requires code/i.test(message)) {
        return '没拿到微信登录凭证，退出小程序重新进入后再点一次。';
    }
    // 微信侧换取 openid 失败（appid/secret 配错、code 已被用过）。
    if (/WX_UPSTREAM_FAILED|code2session/i.test(text)) {
        return '微信登录失败（登录凭证可能已过期），退出小程序重新进入后再试。' + tail(error);
    }
    if (status === 401 || /UNAUTHORIZED|invalid_grant|invalid_client/i.test(text)) {
        return '登录已过期，重新进一次小程序就好。' + tail(error);
    }
    if (status === 429 || /RATE_LIMITED|resource_exhausted/i.test(text)) {
        return '操作太频繁了，等一会儿再试。' + tail(error);
    }
    if (status === 400 || /BAD_REQUEST|invalid_request/i.test(text)) {
        return '请求参数不对，重试一次；仍然失败请联系开发者。' + tail(error);
    }
    if (/abort|cancel/i.test(message)) {
        return '已取消';
    }
    return fallback || message || '操作没有成功，请重试';
}

module.exports = { friendlyAuthError, requestIdOf };