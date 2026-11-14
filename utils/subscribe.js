// 订阅消息：唯一能「用户离开小程序之后还收到」的通道，也是本项目里唯一需要额外基础设施的功能。
//
// 微信把这条通道刻意做成一次性额度：用户点一次「允许」，我们才获得一条下发额度，
// 发完就没了。所以这个模块只负责小程序侧的两件事——
//   1. 在用户的点击手势里攒额度（必须挂在 tap 上，onShow 里自动调会被微信拒绝）；
//   2. 统一从会话里解出 openid，供下发端使用。
//
// 下发端不在小程序包里：subscribeMessage.send 需要 appid + secret 换 access_token，
// 必须在服务端执行。实现见 server/reminder-cron.js（跑在自己的服务器上，由 cron 拉起）。
// 在拿到模板 ID 之前调用 request() 会直接返回「未配置」，不会弹窗，也不会误导用户。

// 模板 ID 从 utils/local-config.js 读取（已 gitignore），仓库里不带真实模板 ID。
// 三个模板对应三类低频、高价值的提醒。
// 其余事件（TA 加食材、收藏菜谱）一律走站内消息，不要占额度。
const config = require('./config');

const TEMPLATES = {
    expire: {
        // 「保质期到期提醒」。
        // 字段：thing1 物品名称 / number5 剩余天数 / date2 到期日期 / thing4 存放位置 / thing8 温馨提醒。
        // 提交后字段和顺序不能再改，换模板要同时改 server/reminder-cron.js 的 buildExpireData。
        id: (config.SUBSCRIBE_TEMPLATES || {}).expire || '',
        label: '食材临期提醒',
        desc: '每天告诉你哪些食材快过期了',
    },
    // 下面几个是槽位。空 id 不会参与 request()，也不会弹窗，放着没有副作用。
    dish: {
        // 「家庭点餐下单完成通知」。
        // 字段：thing5 菜品名称 / thing8 餐食类型 / thing4 下单用户 / thing7 备注。
        id: (config.SUBSCRIBE_TEMPLATES || {}).dish || '',
        label: '点菜提醒',
        desc: 'TA 点了菜或接下你点的菜',
    },
    shopping: {
        id: '',
        label: '采购清单提醒',
        desc: 'TA 想让你顺路买菜时通知你',
    },
    partner: {
        id: '',
        label: '家人动态',
        desc: 'TA 加了食材、收藏了菜谱',
    },
};

const MAX_TMPL_IDS = 3;

function keysOf(input) {
    if (Array.isArray(input) && input.length > 0) return input;
    return Object.keys(TEMPLATES);
}

function readyIds(keys) {
    return keysOf(keys)
        .map((key) => (TEMPLATES[key] ? TEMPLATES[key].id : ''))
        .filter((id) => typeof id === 'string' && id !== '')
        .slice(0, MAX_TMPL_IDS);
}

function configuredBatches() {
    return readyIds([]).length;
}

function unsupported(message) {
    return { accepted: [], rejected: [], error: { message: message }, details: [] };
}

// 错误码 → 用户读得懂的话。toast 只放得下两行，所以这里刻意写短；
// 「到底哪个模板坏了」这种细节放 details，由页面打进 console。
const ERROR_TEXT = {
    10005: '模板 ID 配置有误，请检查公众平台',
    20001: '模板不可用，请到公众平台核对',
    20004: '你在设置里关掉了订阅消息，去「设置」里打开后才能收到提醒',
};

function describe(error) {
    const code = Number(error && error.errCode);
    const message = ERROR_TEXT[code] || (error && error.errMsg) || '订阅请求没有成功';
    return { code: code, message: message };
}

function labelOf(tmplId) {
    const keys = Object.keys(TEMPLATES);
    for (let i = 0; i < keys.length; i++) {
        if (TEMPLATES[keys[i]].id === tmplId) return TEMPLATES[keys[i]].label;
    }
    return tmplId;
}

function requestOnce(tmplIds) {
    return new Promise((resolve) => {
        wx.requestSubscribeMessage({
            tmplIds: tmplIds,
            success(res) {
                const accepted = [];
                const rejected = [];
                tmplIds.forEach((id) => {
                    const value = res && res[id];
                    if (value === 'accept') accepted.push(id);
                    else rejected.push(id);
                });
                resolve({ accepted: accepted, rejected: rejected, error: null, details: [] });
            },
            fail(error) {
                resolve({ accepted: [], rejected: [], error: describe(error), details: [] });
            },
        });
    });
}

// 20001 是「整批」失败：微信只要发现一个模板 ID 查不到，就把这一次调用整个拒掉。
// 于是本来好用的模板也被连累——设置页一个额度都攒不到，还会把英文原文弹给用户。
// 这里逐个再请求一次，把坏的那个单独拎出来，好的照常攒额度。
// 串行而不是并发：并发会连开多个授权浮层，微信只认一次点击手势。
async function requestEach(tmplIds, batchError) {
    const accepted = [];
    const rejected = [];
    const bad = [];
    let firstError = null;

    for (let i = 0; i < tmplIds.length; i++) {
        const id = tmplIds[i];
        const one = await requestOnce([id]);
        if (one.error) {
            bad.push({ id: id, label: labelOf(id), code: one.error.code, message: one.error.message });
            if (!firstError) firstError = one.error;
        } else if (one.accepted.length > 0) {
            accepted.push(id);
        } else {
            rejected.push(id);
        }
    }

    let error = null;
    if (bad.length > 0) {
        // 点名报出来：页面 toast 说人话，details 留给 console 做证据。
        const names = bad.map((item) => '「' + item.label + '」').join('');
        error = {
            code: firstError ? firstError.code : batchError.code,
            message: names + '模板不可用，请到公众平台核对',
        };
    }
    // bad 为空但 accepted/rejected 已经覆盖全部模板，说明整批报错只是微信的批量校验，
    // 按逐个请求的结果处理（error 保持 null），不要把能用的额度一起判死。

    return { accepted: accepted, rejected: rejected, error: error, details: bad };
}

// 必须在 bindtap 的处理函数里同步调用（不能 await 之后再调，手势会失效）。
// 返回值里 accepted / rejected 是可以回写到「额度账本」的原始结果；
// 账本本身留在下发端，客户端记账没有意义——额度是微信侧维护的。
function request(input) {
    const tmplIds = readyIds(input);

    if (tmplIds.length === 0) {
        return Promise.resolve(unsupported('订阅消息模板还没有配置，暂时收不到微信提醒'));
    }
    if (!wx || typeof wx.requestSubscribeMessage !== 'function') {
        return Promise.resolve(unsupported('当前微信版本不支持订阅消息，请升级微信后再试'));
    }

    return requestOnce(tmplIds).then((batch) => {
        if (!batch.error) return batch;
        // 只有一个模板时无处分摊，直接把它自己的错误报出去。
        if (batch.error.code !== 20001 || tmplIds.length < 2) return batch;
        return requestEach(tmplIds, batch.error);
    });
}

// 微信登录的会话里 user.id 就是 "wx:" + 本小程序 openid（SDK 的约定）。
// 下发端必须拿到 openid，所以统一在这里解析，别让业务页面各自剥前缀。
function openidOf(session) {
    const user = session && session.user;
    const id = user && user.id;
    const text = typeof id === 'string' ? id : '';
    if (text.indexOf('wx:') !== 0) return '';
    return text.slice(3);
}

// 邮箱验证码登录的账号没有 openid，收不到订阅消息，只能依赖站内消息。
// 设置页要用这个函数决定是否提示「换微信登录才能收到提醒」。
function canReceive(session) {
    return openidOf(session) !== '';
}

// ---------- 还剩什么 ----------
//
// 1. 【待办·只能你做】公众平台「功能 → 订阅消息」选用模板，把 template_id 填回 TEMPLATES.expire.id。
//    模板库按小程序类目给，如果找不到「食材临期」，选最接近的「到期提醒 / 日程提醒」，
//    然后把模板详情里的字段名（thing1 / time2 …）告诉我，server/reminder-cron.js 的
//    TEMPLATE_FIELDS 要按它逐字对齐，否则微信返回 47003。
// 2. 【已完成】下发器：server/reminder-cron.js —— stable_token 换 token、逐条 send、
//    43101（拒收/无额度）记为当日已处理避免每小时白跑。
// 3. 【已完成】取数入口：reminder_due(p_token)，SECURITY DEFINER + 令牌 sha256 校验。
// 4. 额度不需要客户端记账：额度在微信侧维护，发不出去会回 43101；
//    用户没收到的那条由客户端打开小程序时生成站内消息补上，不需要服务端写库。
// 5. 【坑】20001「No template data return, verify the template id exist」是**整批**失败：
//    tmplIds 里只要有一个查不到，整次调用全部作废。所以一个模板 ID 写错，会把另一个
//    本来能用的模板一起打死（设置页一个额度都攒不到）。request() 已加逐个探测兜底，
//    坏的会在 details 里点名，页面打 [subscribe] 日志——排查时先看那行日志定位是哪个。
//    20001 的常见成因：ID 抄错一个字符、模板被删除后重选（ID 会变）、后台看得到但
//    小程序类目已变更导致模板失效。后台「生效中」不等于客户端能用。

module.exports = {
    TEMPLATES,
    MAX_TMPL_IDS,
    request,
    openidOf,
    canReceive,
    configuredBatches,
};
