// 唯一的云服务客户端实例。
// endpoint / publishableKey 来自应用开通云服务时的 publicConfig，只能照抄，不要手改成别的域名。
//
// 这里刻意用 try/catch 包住初始化和 SDK 加载：
// 一旦依赖缺失（例如 miniprogram_npm 没有构建），整个 app.js 会在这里抛错，
// 表现为所有页面白屏、连启动页的图标都渲染不出来，非常难查。
// 兜底成 stub 之后，页面会显示「云服务没加载成功 + 原因」，可诊断。

// 数据面默认走「自建后端」（server/cloud-gateway.js），协议与 WorkBuddy SDK 逐位兼容
// （路径 /.cloud/database/rest/*、头 x-wb-webapp-access-key、JWT 里 sub = "wx:<openid>"），
// 所以换后端只需要改 endpoint + publishableKey 两个值。
//
// 这两个值不再硬编码在这里，而是从 utils/local-config.js 读取（已 gitignore）：
//   cp utils/local-config.example.js utils/local-config.js  然后填自己的域名与 key
// 这样开源出去的仓库里不会带任何真实域名或 key。
const config = require('./config');

const publicConfig = {
    endpoint: config.CLOUD_ENDPOINT,
    publishableKey: config.CLOUD_PUBLISHABLE_KEY,
};

let initError = '';

function errorEnvelope(message) {
    return { data: null, error: { message: message } };
}

// 可链式调用、可 await 的空查询对象，只用于初始化失败时兜底。
function stubQuery(message) {
    const query = {
        select: function () { return query; },
        eq: function () { return query; },
        order: function () { return query; },
        limit: function () { return query; },
        insert: function () { return query; },
        update: function () { return query; },
        delete: function () { return query; },
        single: function () { return Promise.resolve(errorEnvelope(message)); },
        maybeSingle: function () { return Promise.resolve(errorEnvelope(message)); },
        then: function (resolve) { return Promise.resolve(errorEnvelope(message)).then(resolve); },
    };
    return query;
}

function buildStub(message) {
    return {
        auth: {
            getSession: function () { return Promise.resolve(errorEnvelope(message)); },
            sendOtp: function () { return Promise.resolve(errorEnvelope(message)); },
            verifyOtp: function () { return Promise.resolve(errorEnvelope(message)); },
            signInWithWechat: function () { return Promise.resolve(errorEnvelope(message)); },
            signOut: function () { return Promise.resolve(errorEnvelope(message)); },
            onAuthStateChange: function () {},
        },
        database: {
            from: function () { return stubQuery(message); },
            rpc: function () { return Promise.resolve(errorEnvelope(message)); },
        },
        llm: {
            models: {
                list: function () { return Promise.reject(new Error(message)); },
            },
            chat: {
                completions: {
                    create: function () { throw new Error(message); },
                },
            },
        },
    };
}

let cloud = null;

try {
    const { createMiniProgramWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk/miniprogram');
    const { createDiagnosticWx } = require('./workbuddy-cloud-diagnostics');
    cloud = createMiniProgramWorkBuddyCloud({
        endpoint: publicConfig.endpoint,
        publishableKey: publicConfig.publishableKey,
        wx: createDiagnosticWx(wx),
    });
} catch (error) {
    initError = (error && error.message) || '云服务初始化失败';
    try {
        console.error('[我们的小家] 云服务初始化失败：' + initError);
    } catch (logError) {
        // 忽略日志异常
    }
    cloud = buildStub('云服务没有加载成功（' + initError + '），请重新编译后再试');
}

module.exports = { cloud, publicConfig, initError };
