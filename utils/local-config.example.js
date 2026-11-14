// 本地私有配置模板。
//
// 用法：复制本文件为同目录下的 local-config.js，填入你自己的真实值。
//
//   cp utils/local-config.example.js utils/local-config.js
//
// local-config.js 已被 .gitignore 忽略，不会被提交到仓库。
// 缺失时，各处会退回 local-config.js 里的占位默认值，页面能启动但连不上服务。
//
// 为什么要把真实值抽出来：这个仓库的代码、文档、部署脚本全部开源，
// 域名、AppID、publishableKey 一旦写死在源码里就会随仓库公开。

module.exports = {
    // ── 云服务（业务数据面）────────────────────────────────────────────────
    // 自建后端对外入口。必须与小程序后台「request 合法域名」里那一条逐字一致：
    // 不带端口、不带尾部斜杠、必须是 HTTPS。
    CLOUD_ENDPOINT: 'https://your-domain.example.com',
    // 服务端 CLOUD_PUBLISHABLE_KEY 环境变量的同值。会被小程序包带上，
    // 不是机密，但也不该公开（公开等于把你的 RPC 端点送给扫描器）。
    CLOUD_PUBLISHABLE_KEY: 'wbpk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',

    // ── AI 通道 ───────────────────────────────────────────────────────────
    // 与 CLOUD_ENDPOINT 通常是同一个域名（同一个网关进程同时提供两套路径）。
    LLM_SERVER_BASE: 'https://your-domain.example.com',

    // ── 订阅消息模板 ──────────────────────────────────────────────────────
    // 微信公众平台 → 功能 → 订阅消息 里选用模板后拿到的 Template ID。
    // 留空则该类提醒不会弹窗、也不会下发，不影响其他功能。
    // 模板字段契约见 utils/subscribe.js 与 server/reminder-cron.js 的注释。
    SUBSCRIBE_TEMPLATES: {
        expire: '',
        dish: '',
    },
};
