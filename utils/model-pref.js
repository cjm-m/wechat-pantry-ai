// 模型偏好：识图、文本各一个本机 storage key。
// 定位沿用 couple_cook_model 的初衷——两人各用各的偏好，不需要共享，也不跟账号走
// （notify_setting 是云端跟随账号的另一种策略，刻意不同）。
//
// 解析规则统一为「偏好在目录中才采用，否则目录第一个」：
// 服务端 /llm/models 返回的目录是信任根，偏好只是目录上的一个指针；
// 服务端下架 / 改名后旧偏好自动失效，不会把请求打到不存在的模型上。

const TEXT_KEY = 'couple_cook_model';     // 既有 key 原样保留，老用户的菜谱模型偏好不丢
const VISION_KEY = 'couple_vision_model'; // 新增：识图模型偏好
const MAX_ID = 64;                        // 模型 id 长度上限，防脏数据把 storage 撑爆

function readKey(key) {
    try {
        const saved = wx.getStorageSync(key);
        if (typeof saved !== 'string') return '';
        return saved.trim().slice(0, MAX_ID);
    } catch (error) {
        // 读不到（隐私模式等）按没有偏好处理，走默认
        return '';
    }
}

// 返回是否真正落盘：false 时调用方应提示「没能记住」，
// 与 listModels「失败时把真实原因带出去」的风格保持一致。
function writeKey(key, id) {
    try {
        wx.setStorageSync(key, id || '');
        return true;
    } catch (error) {
        // 存不上就只用本次会话的选择
        return false;
    }
}

// kind: 'text' | 'vision'
function get(kind) {
    return readKey(kind === 'vision' ? VISION_KEY : TEXT_KEY);
}

function set(kind, id) {
    const clean = String(id || '').trim().slice(0, MAX_ID);
    return writeKey(kind === 'vision' ? VISION_KEY : TEXT_KEY, clean);
}

// 从目录里解析最终模型：偏好在目录中才采用，否则目录第一个；目录为空返回 ''，
// 由调用方抛 NO_MODEL / NO_VISION。识图调用方传过滤 supportsImages 之后的列表，
// 文本调用方传全量列表。
function resolve(models, preferredId) {
    const list = Array.isArray(models) ? models : [];
    if (list.length === 0) return '';
    const wanted = String(preferredId || '').trim();
    if (wanted !== '') {
        for (let i = 0; i < list.length; i += 1) {
            if (list[i] && list[i].id === wanted) return wanted;
        }
    }
    return list[0].id;
}

module.exports = {
    get,
    set,
    resolve,
    TEXT_KEY,
    VISION_KEY,
};
