// 模型通道配置。整条链路的开关只在这里，改一处即可切换底层服务来源。
//
// ── PROVIDER ───────────────────────────────────────────────────────────────
// 'server'   默认。小程序 → 你自己的服务器（server/llm-proxy.js）→ NewAPI。
//            零平台费用、无冷启动、支持 SSE 流式（逐字进度）、密钥不进小程序包。
//            前置条件：域名已备案并加入 request 合法域名 + HTTPS。
// 'newapi'   微信云函数转发（上一版方案，保留作备用）。云函数不支持流式，且需云开发套餐。
// 'platform' 内置免密钥通道（最后兜底）。无自建依赖，但会回到"等内置通道超时"的老问题。
//
// 三者输出同一种 SSE / chunk 结构，业务模块与页面无需改动。

const config = require('./config');

module.exports = {
    PROVIDER: 'server',

    // ── 自建通道 ────────────────────────────────────────────────────────────
    // 值来自 utils/local-config.js（已 gitignore），不要在这里写死真实域名。
    // 必须与小程序后台「request 合法域名」里那一条逐字一致：不带端口、不带尾部斜杠。
    SERVER_BASE: config.LLM_SERVER_BASE,
    LOGIN_PATH: '/llm/login',
    CHAT_PATH: '/llm/chat',
    MODELS_PATH: '/llm/models',
    // M5 Agent：多轮工具调用的端点。服务端最多 5 轮、总预算 50s，
    // 客户端这边留 58s，让服务端的收口消息先回来。
    AGENT_PATH: '/llm/agent',

    // ── 云函数通道（PROVIDER='newapi' 时使用）────────────────────────────────
    CLOUD_FUNCTION_NAME: 'cook',
    CLOUD_ENV: '',

    // 客户端等待上限（毫秒）。wx.request 的硬上限是 60000，传更大值会被静默截断，
    // 所以这里留 2s 余量，让服务器的错误信息先回来，而不是客户端先报 request:fail timeout。
    CLIENT_TIMEOUT_MS: 58000,

    // 两次生成之间的最小间隔（毫秒），防止手抖连点把额度刷掉。
    COOLDOWN_MS: 3000,
};
