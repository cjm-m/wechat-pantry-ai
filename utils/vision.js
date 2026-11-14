// 拍照识别食材：把照片压一压再交给能看图的模型，换回结构化食材列表。
// 识别结果只是「草稿」——调用方必须让用户逐项确认、可以改，入库前不写任何数据。

const llm = require('./llm');
const cooking = require('./cooking');
const modelPref = require('./model-pref');
const { CATEGORY_KEYS } = require('./format');

// 图片体积上限：自建通道与云函数通道都按原图字节数拦；内置通道是按 base64 长度拦（约 2.4MB 原图）。
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;
const MAX_BASE64 = 3200000;
const MAX_ITEMS = 12;
const UNIT_HINTS = ['个', '袋', '盒', '瓶', '斤', '把', '根', '块', '片', '份', '颗', '包', '罐'];

const SYSTEM_PROMPT = [
    '你是冰箱食材识别助手。你只做一件事：认出照片里有哪些食材。',
    '你只输出一个 JSON 对象，不输出任何其他内容。',
    '结构固定为：',
    '{"items":[{"name":"食物名称","category":"类别","quantity":"数量","unit":"单位","storage":"冷藏"}]}',
    '规则：',
    '1. 不要输出 markdown 代码块、解释或前后缀文字。',
    '2. 只做识别。不要输出保质期、保质天数、生产日期、购买日期、开封日期等任何时间信息——那是另一个环节的工作。',
    '3. name 用日常叫法，不超过 10 个字，例如「鸡胸肉」「娃娃菜」。',
    '4. category 只能是下面之一：蔬菜、肉蛋、水产、豆制品、乳制品、主食、调料、水果、其他。',
    '5. quantity 是数字或「半」，unit 从 个/袋/盒/瓶/斤/把/根/块/片/份/颗/包/罐 里选一个。',
    '6. storage 只能是「冷藏」或「冷冻」，作为存放建议：生鲜肉禽、水产、速冻食品、短期吃不完需要分装冷冻的填「冷冻」；蔬菜、水果、蛋奶、豆制品、调料、熟食填「冷藏」。',
    '7. 看不清、或者不确定是不是食物的，不要输出。',
    '8. 最多 12 样，重复的合并成一条。',
].join('\n');

function appError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

// 识图模型选取：用户在设置-模型页选的优先（须在识图目录里），
// 不在目录里（服务端下架 / 改名）就回退目录第一个；服务端还会二次校验。
// 复用 cooking.listModels() 的会话级缓存：scan 页一次拍多张串行识别，
// 不会每张都重新拉一遍 /llm/models。
async function pickVisionModel() {
    const listed = await cooking.listModels();
    // 透传底层原因：域名没加白名单、证书不对、401，处置方式完全不同，吞掉码等于让人盲猜。
    if (listed.error) {
        throw appError(listed.error.code || 'NO_MODEL', listed.error.message || '拿不到模型列表，稍后再试');
    }
    if (listed.models.length === 0) {
        throw appError('NO_MODEL', '当前没有可用的模型');
    }
    const vision = listed.models.filter((item) => item.supportsImages === true);
    if (vision.length === 0) {
        throw appError('NO_VISION', '当前没有能看图的模型，手动添加一下吧');
    }
    return modelPref.resolve(vision, modelPref.get('vision'));
}

// 相册里可能是 png，compressImage 只吃 jpg，失败就退回原图而不是中断流程。
function compress(src) {
    return new Promise((resolve) => {
        wx.compressImage({
            src: src,
            quality: 55,
            success: (res) => resolve(res.tempFilePath || src),
            fail: () => resolve(src),
        });
    });
}

function readBase64(filePath) {
    return new Promise((resolve, reject) => {
        wx.getFileSystemManager().readFile({
            filePath: filePath,
            encoding: 'base64',
            success: (res) => resolve(res.data || ''),
            fail: () => reject(appError('READ_FAILED', '读不到这张图片，换一张试试')),
        });
    });
}

function toText(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    return '';
}

function normalizeItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = toText(raw.name || raw.title || raw.food).trim();
    if (name === '') return null;

    const category = CATEGORY_KEYS.indexOf(toText(raw.category).trim()) >= 0
        ? toText(raw.category).trim()
        : '其他';

    let unit = toText(raw.unit).trim();
    if (UNIT_HINTS.indexOf(unit) < 0) unit = unit === '' ? '份' : unit.slice(0, 2);

    const storage = toText(raw.storage).trim() === '冷冻' ? '冷冻' : '冷藏';

    // 只做基础识别：保质期一律留空，交给后面专门的环节。
    return {
        name: name.slice(0, 20),
        category: category,
        quantity: toText(raw.quantity).trim().slice(0, 8) || '1',
        unit: unit,
        storage: storage,
    };
}

function parseItems(rawText) {
    let text = toText(rawText).trim();
    if (text === '') return [];
    text = text.replace(/^\uFEFF/, '').replace(/[\u200b\u200c\u200d]/g, '');
    text = text.replace(/^```(?:json|JSON)?\s*/, '').replace(/```\s*$/, '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) text = text.slice(start, end + 1);
    text = text.replace(/[\u201c\u201d\u201e]/g, '"').replace(/[\u2018\u2019]/g, "'");
    text = text.replace(/,\s*([}\]])/g, '$1');

    let parsed = null;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        return [];
    }

    let list = null;
    if (Array.isArray(parsed)) list = parsed;
    else if (parsed && Array.isArray(parsed.items)) list = parsed.items;
    else if (parsed && Array.isArray(parsed.foods)) list = parsed.foods;
    else if (parsed && Array.isArray(parsed.data)) list = parsed.data;
    if (!list) return [];

    const seen = {};
    const items = [];
    list.forEach((raw) => {
        const item = normalizeItem(raw);
        if (!item) return;
        const key = item.name + '|' + item.unit;
        if (seen[key]) return;
        seen[key] = true;
        items.push(item);
    });
    return items.slice(0, MAX_ITEMS);
}

// 取原图字节数。statSync 在个别基础库/临时路径上会失败，拿不到就不拦，
// 由云函数那边的 4MB 上限兜底——宁可多传一次，也不要因为读不到大小直接卡住识别。
function safeSize(filePath) {
    try {
        const stat = wx.getFileSystemManager().statSync(filePath);
        return stat && stat.size ? stat.size : 0;
    } catch (error) {
        return 0;
    }
}

// 照片必须走云存储：callFunction 的 data 建议上限只有 100KB，base64 传不进去。
// 上传目录带时间戳+随机串，云函数读完立刻删，正常链路不会在云存储里留东西。
function uploadTemp(filePath) {
    return new Promise((resolve, reject) => {
        if (!wx.cloud || typeof wx.cloud.uploadFile !== 'function') {
            reject(appError('NO_CLOUD', '还没开通微信云开发，暂时传不了照片'));
            return;
        }
        const ext = /\.png$/i.test(filePath) ? 'png' : 'jpg';
        const cloudPath = 'tmp/vision/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
        wx.cloud.uploadFile({
            cloudPath: cloudPath,
            filePath: filePath,
            success: (res) => {
                const fileID = res && res.fileID ? res.fileID : '';
                if (fileID === '') reject(appError('UPLOAD_FAILED', '照片上传失败，检查网络后重试'));
                else resolve(fileID);
            },
            fail: () => reject(appError('UPLOAD_FAILED', '照片上传失败，检查网络后重试')),
        });
    });
}

async function recognize(imagePath, onProgress) {
    if (!imagePath) throw appError('NO_IMAGE', '先拍一张或选一张照片');

    const model = await pickVisionModel();
    const compressed = await compress(imagePath);

    let params = null;

    if (llm.isServer()) {
        // 自建通道没有 callFunction 的 100KB 限制，直接把压缩后的图片 base64 放进请求体，
        // 省掉上传云存储、下载、删除三步，链路更短也不留垃圾文件。
        const size = safeSize(compressed);
        if (size > MAX_UPLOAD_BYTES) throw appError('TOO_LARGE', '图片太大了，换一张或裁一下');
        const base64 = await readBase64(compressed);
        if (base64.length === 0) throw appError('READ_FAILED', '读不到这张图片，换一张试试');
        params = {
            task: 'vision',
            model: model,
            temperature: 0.2,
            input: {
                image: base64,
                mime: /\.png$/i.test(compressed) ? 'image/png' : 'image/jpeg',
            },
        };
    } else if (llm.isNewApi()) {
        // 云函数通道：callFunction 的 data 建议上限只有 100KB，照片必须走云存储中转。
        llm.ensureCloud();
        const size = safeSize(compressed);
        if (size > MAX_UPLOAD_BYTES) throw appError('TOO_LARGE', '图片太大了，换一张或裁一下');
        const fileID = await uploadTemp(compressed);
        params = {
            task: 'vision',
            model: model,
            temperature: 0.2,
            input: { fileID: fileID },
        };
    } else {
        const base64 = await readBase64(compressed);
        if (base64.length === 0) throw appError('READ_FAILED', '读不到这张图片，换一张试试');
        if (base64.length > MAX_BASE64) throw appError('TOO_LARGE', '图片太大了，换一张或裁一下');
        params = {
            model: model,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: '请识别这张照片里的食材，按约定输出 JSON。' },
                        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + base64 } },
                    ],
                },
            ],
            stream: true,
            temperature: 0.2,
            response_format: { type: 'json_object' },
        };
    }

    let text = '';
    let finishReason = '';
    const stream = llm.chat.completions.create(params);
    for await (const chunk of stream) {
        const choice = chunk && chunk.choices ? chunk.choices[0] : null;
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta;
        if (delta && delta.content) {
            text += delta.content;
            if (typeof onProgress === 'function') onProgress(text.length);
        }
    }

    const items = parseItems(text);
    if (items.length === 0) {
        return { items: [], raw: text, finishReason: finishReason };
    }
    return { items: items, raw: text, finishReason: finishReason };
}

function friendly(error) {
    const code = (error && error.code) || (error && error.error && error.error.code) || '';
    if (code === 'NO_VISION' || code === 'NO_MODEL' || code === 'TOO_LARGE' || code === 'READ_FAILED' || code === 'NO_IMAGE') {
        return (error && error.message) || '识别失败';
    }
    if (code === 'UPLOAD_FAILED' || code === 'IMAGE_DOWNLOAD_FAILED' || code === 'NO_CLOUD') {
        return (error && error.message) || '照片没传上去，检查网络后重试';
    }
    return cooking.friendlyMessage(error);
}

module.exports = {
    recognize,
    parseItems,
    friendly,
    SYSTEM_PROMPT,
};
