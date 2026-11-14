// 本地配置加载器：把「随仓库公开的默认值」和「只在本机存在的真实值」合并成一份。
//
// 为什么不直接在每个文件里写 require('./local-config')：
//   仓库里没有 local-config.js（被 .gitignore 忽略），直接 require 会抛错；
//   有的开发者会写 try/catch，有的不会，容易出现「同一次构建里三处配置不一致」。
//   统一收在这里，只有一处 try/catch，其它模块 require('./config') 即可。
//
// 层级：
//   utils/local-config.example.js  已提交，全是占位符（fork 者看这个）
//   utils/local-config.js          本地私有，已 gitignore（自己填真实值）
//   本文件                         合并两者，本地值优先

const EXAMPLE = require('./local-config.example');

let local = {};
try {
    local = require('./local-config');
} catch (error) {
    // 没有本地配置是正常情况（新 clone 的人、CI、云端构建）
    local = {};
}

// 只做一层浅合并：本文件暴露的都是扁平字段，嵌套的 SUBSCRIBE_TEMPLATES 单独合。
const merged = Object.assign({}, EXAMPLE, local);

if (local.SUBSCRIBE_TEMPLATES || EXAMPLE.SUBSCRIBE_TEMPLATES) {
    merged.SUBSCRIBE_TEMPLATES = Object.assign(
        {},
        EXAMPLE.SUBSCRIBE_TEMPLATES || {},
        local.SUBSCRIBE_TEMPLATES || {}
    );
}

// 是否还是占位符 —— 页面据此给出「请先配置本地服务地址」的提示，
// 而不是让用户对着 request:fail 猜。
merged.isPlaceholder = function isPlaceholder() {
    return !merged.CLOUD_ENDPOINT
        || merged.CLOUD_ENDPOINT.indexOf('your-domain') >= 0
        || merged.CLOUD_ENDPOINT.indexOf('example.com') >= 0;
};

module.exports = merged;
