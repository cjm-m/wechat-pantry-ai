// 站内消息：唯一保证送达的提醒通道。
//
// 为什么需要它兜底：订阅消息是一次性额度，用户拒收、额度用完、或者用邮箱验证码登录
// （这种账号没有 openid），下发都会失败。失败的那条必须落到这里，否则用户永远不知道
// 自己错过了什么。同时，高频的业务事件（TA 加了食材、收藏了菜谱）根本消耗不起额度，
// 也走这里。
//
// 写入一律幂等：靠 dedupe_key 保证「同一件事」只出现一条。否则用户每切一次 tab
// 就把首页刷新一遍，消息列表会被同一条提醒刷满。
//
// 读取不按 space_id 过滤：这里只关心「发给我的」，user_id 是唯一的检索维度。

const { cloud } = require('./cloud');
const { relativeTime, todayStr } = require('./format');

const TABLE = 'notice';

const COLUMNS = [
    'id',
    'space_id',
    'user_id',
    'type',
    'title',
    'body',
    'payload',
    'dedupe_key',
    'read_at',
    'created_at',
];

// 类型只影响展示（图标 + 分类标签），不参与任何逻辑判断。
// 新增来源时只在这里加一行，消息页不用改。
const TYPES = {
    expire: { icon: '⏰', label: '临期提醒' },
    shopping: { icon: '🛒', label: '采购提醒' },
    partner: { icon: '💛', label: 'TA 的动态' },
    dish: { icon: '🥢', label: '点菜' },
    system: { icon: '🔔', label: '系统消息' },
};

const DEFAULT_TYPE = 'system';

// 默认提前 2 天提醒：和冰箱页「快到期」的判定口径保持一致，用户不会看到两套标准。
const LEAD_DAYS = 2;

// 过期超过 3 天的食材不再提醒：它们堆在冰箱里，提醒也没有行动价值，
// 只会让消息列表变成一份长期抱怨。
const STALE_DAYS = -3;

const MAX_BODY_ITEMS = 3;

let scopeSpaceId = 0;
let scopeMeId = '';

// 同一天只同步一次临期。放在模块变量里而不是 storage：
// 一次前台会话内不需要重复查库，下次冷启动再算一遍成本也很低。
let lastSyncedDay = '';

function setScope(spaceId, meId) {
    const nextSpace = Number(spaceId) || 0;
    const nextMe = meId || '';
    // 只有换人/换家才清掉当天的同步标记。
    // 每次进页面都会调 setScope，无条件重置会让「一天一条」的防抖彻底失效。
    if (nextSpace !== scopeSpaceId || nextMe !== scopeMeId) lastSyncedDay = '';
    scopeSpaceId = nextSpace;
    scopeMeId = nextMe;
}

function clip(value, max) {
    return String(value === null || value === undefined ? '' : value)
        .replace(/[\r\n\t]+/g, ' ')
        .trim()
        .slice(0, max);
}

function nowIso() {
    return new Date().toISOString();
}

function typeOf(value) {
    return TYPES[value] ? value : DEFAULT_TYPE;
}

function mapRow(row) {
    const type = typeOf(row.type);
    const payload = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
        ? row.payload
        : {};
    return {
        id: String(row.id),
        type: type,
        icon: TYPES[type].icon,
        label: TYPES[type].label,
        title: row.title || '',
        body: row.body || '',
        page: typeof payload.page === 'string' ? payload.page : '',
        unread: !row.read_at,
        readAt: row.read_at || '',
        createdAt: row.created_at || '',
        timeText: relativeTime(row.created_at),
    };
}

function asRows(data) {
    return Array.isArray(data) ? data : [];
}

function dbError(error, fallback) {
    if (error && typeof error === 'object' && error.message) return error;
    return { message: fallback || '操作失败，请重试' };
}

// 列表：默认 50 条。两个人的家一天最多几条消息，再多也没人往下翻。
async function list(options) {
    const limit = Math.min(Math.max(Number(options && options.limit) || 50, 1), 100);
    try {
        let query = cloud.database.from(TABLE).select(COLUMNS.join(','));
        if (scopeMeId) query = query.eq('user_id', scopeMeId);
        const result = await query.order('created_at', { ascending: false }).limit(limit);
        if (!result || result.error) {
            return { items: [], error: dbError(result && result.error, '消息加载失败') };
        }
        return { items: asRows(result.data).map(mapRow), error: null };
    } catch (error) {
        return { items: [], error: dbError(error, '消息加载失败') };
    }
}

// 未读数：优先用 head + count 让服务端只回数字。
// 万一服务端没回 count，退回一次「只取 id」的普通查询——红点消失比多一次请求糟糕得多。
async function unreadCount() {
    try {
        let query = cloud.database
            .from(TABLE)
            .select('id', { count: 'exact', head: true })
            .is('read_at', null);
        if (scopeMeId) query = query.eq('user_id', scopeMeId);
        const result = await query;
        if (!result || result.error) {
            return { count: 0, error: dbError(result && result.error, '未读数读取失败') };
        }
        const exact = Number(result.count);
        if (Number.isFinite(exact) && exact >= 0) return { count: exact, error: null };
        return await countFallback();
    } catch (error) {
        return { count: 0, error: dbError(error, '未读数读取失败') };
    }
}

async function countFallback() {
    try {
        let query = cloud.database.from(TABLE).select('id').is('read_at', null);
        if (scopeMeId) query = query.eq('user_id', scopeMeId);
        const result = await query.limit(100);
        if (!result || result.error) {
            return { count: 0, error: dbError(result && result.error, '未读数读取失败') };
        }
        return { count: asRows(result.data).length, error: null };
    } catch (error) {
        return { count: 0, error: dbError(error, '未读数读取失败') };
    }
}

async function markRead(id) {
    if (!id) return { error: { message: '缺少消息 id' } };
    try {
        const result = await cloud.database
            .from(TABLE)
            .update({ read_at: nowIso() })
            .eq('id', id)
            .select('id');
        if (!result || result.error) {
            return { error: dbError(result && result.error, '标记已读失败') };
        }
        return { error: null };
    } catch (error) {
        return { error: dbError(error, '标记已读失败') };
    }
}

async function markAllRead() {
    try {
        let query = cloud.database.from(TABLE).update({ read_at: nowIso() }).is('read_at', null);
        if (scopeMeId) query = query.eq('user_id', scopeMeId);
        const result = await query.select('id');
        if (!result || result.error) {
            return { error: dbError(result && result.error, '标记已读失败') };
        }
        return { error: null };
    } catch (error) {
        return { error: dbError(error, '标记已读失败') };
    }
}

async function findByDedupe(userId, dedupeKey) {
    let query = cloud.database.from(TABLE).select('id').eq('dedupe_key', dedupeKey);
    if (userId) query = query.eq('user_id', userId);
    const result = await query.limit(1);
    if (!result || result.error) {
        return { found: null, error: dbError(result && result.error, '消息查重失败') };
    }
    const rows = asRows(result.data);
    return { found: rows.length > 0 ? rows[0] : null, error: null };
}

// 写一条站内消息。targetUserId 留空表示发给自己。
// 重复写入不算错误——幂等是设计的一部分，调用方不需要预先判断。
async function push(notice, targetUserId) {
    const userId = targetUserId || scopeMeId;
    const row = notice || {};

    if (!userId) return { created: false, duplicated: false, error: { message: '还没登录，无法写入消息' } };
    if (!scopeSpaceId) return { created: false, duplicated: false, error: { message: '还没有小家，无法写入消息' } };

    const dedupeKey = clip(row.dedupeKey, 120);
    const title = clip(row.title, 60);
    if (dedupeKey === '') return { created: false, duplicated: false, error: { message: '缺少消息去重键' } };
    if (title === '') return { created: false, duplicated: false, error: { message: '缺少消息标题' } };

    const exists = await findByDedupe(userId, dedupeKey);
    if (exists.error) return { created: false, duplicated: false, error: exists.error };
    if (exists.found) return { created: false, duplicated: true, error: null };

    const payload = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
        ? row.payload
        : {};

    try {
        const result = await cloud.database
            .from(TABLE)
            .insert({
                space_id: scopeSpaceId,
                user_id: userId,
                type: typeOf(row.type),
                title: title,
                body: clip(row.body, 200),
                payload: payload,
                dedupe_key: dedupeKey,
            })
            .select('id');

        if (!result || result.error) {
            const error = result && result.error;
            // 并发写入时唯一索引会挡下第二条，这属于正常结果，不要弹给用户看。
            // 服务端把 Postgres 的 23505 包成了 DATABASE_23505，所以按「包含」判断。
            const code = String((error && error.code) || '');
            const message = String((error && error.message) || '');
            if (code.indexOf('23505') >= 0 || /duplicate key/i.test(message)) {
                return { created: false, duplicated: true, error: null };
            }
            return { created: false, duplicated: false, error: dbError(error, '消息保存失败') };
        }
        const rows = asRows(result.data);
        return { created: true, duplicated: false, id: rows.length > 0 ? rows[0].id : '', error: null };
    } catch (error) {
        return { created: false, duplicated: false, error: dbError(error, '消息保存失败') };
    }
}

// 临期汇总：一天一条，而不是一样食材一条。
// 站在用户视角，「今天有 3 样要吃掉」是一件事；拆成 3 条只是噪音。
function expireItems(items) {
    return (items || []).filter((item) => {
        if (!item || !item.expire) return false;
        const days = Number(item.expire.days);
        if (!Number.isFinite(days)) return false;
        return days <= LEAD_DAYS && days >= STALE_DAYS;
    });
}

function expireBody(targets) {
    const shown = targets.slice(0, MAX_BODY_ITEMS).map((item) => {
        const text = item.expire && item.expire.text ? item.expire.text : '快到期了';
        return item.name + ' ' + text;
    });
    let body = shown.join('；');
    if (targets.length > MAX_BODY_ITEMS) {
        body += ' 等 ' + targets.length + ' 样';
    }
    return body;
}

// 传入当前食材列表（调用方已经拿到了，不要为此再查一次库），
// 计算出临期项并落一条消息。返回 { created, skipped, count, error }。
async function syncExpiring(items) {
    const dayKey = todayStr();
    if (lastSyncedDay === dayKey) {
        return { created: false, skipped: true, count: 0, error: null };
    }

    const targets = expireItems(items);
    if (targets.length === 0) {
        lastSyncedDay = dayKey;
        return { created: false, skipped: true, count: 0, error: null };
    }

    const result = await push({
        type: 'expire',
        title: targets.length === 1 ? '1 样食材快要到期了' : targets.length + ' 样食材快要到期了',
        body: expireBody(targets),
        // 一天一条：日期进幂等键。用户当天已读之后不会被反复重新置为未读。
        dedupeKey: 'expire:' + dayKey,
        payload: {
            page: '/pages/fridge/fridge',
            ids: targets.slice(0, 20).map((item) => Number(item.id)).filter((id) => Number.isFinite(id)),
        },
    }, scopeMeId);

    // 写入失败（网络/权限）不阻塞首页：消息是附加信息，不该让工作台变红。
    if (!result.error) lastSyncedDay = dayKey;
    return { created: result.created, skipped: result.duplicated, count: targets.length, error: result.error };
}

function summaryOf(items) {
    const rows = items || [];
    let unread = 0;
    rows.forEach((item) => {
        if (item.unread) unread += 1;
    });
    return { total: rows.length, unread: unread };
}

module.exports = {
    TYPES,
    LEAD_DAYS,
    setScope,
    list,
    unreadCount,
    markRead,
    markAllRead,
    push,
    syncExpiring,
    summaryOf,
};
