// 订阅消息的接收设置：openid 落库、开关、提醒时间。
//
// 这一层只服务订阅消息——站内消息永远可用，不需要任何设置。
//
// openid 从会话里解析（session.user.id = "wx:" + openid），只在微信登录时存在。
// 邮箱验证码登录的账号拿不到 openid，也就收不到微信提醒，页面上必须说清楚，
// 而不是给一个"打开开关但永远不生效"的假开关。

const { cloud } = require('./cloud');
const { openidOf } = require('./subscribe');

const TABLE = 'notify_setting';
const COLUMNS = 'id,user_id,space_id,wx_openid,enabled,remind_at,last_sent_on';

const DEFAULT_REMIND_AT = '09:00';

let scopeUserId = '';

function setScope(userId) {
    scopeUserId = userId || '';
}

function nowIso() {
    return new Date().toISOString();
}

function dbError(error, fallback) {
    if (error && typeof error === 'object' && error.message) return error;
    return { message: fallback || '操作失败，请重试' };
}

// remind_at 是 PG 的 time，服务端可能回 "09:00:00"，picker 只认前 5 位。
function mapRow(row) {
    const time = String(row.remind_at || DEFAULT_REMIND_AT);
    return {
        id: String(row.id),
        spaceId: Number(row.space_id) || 0,
        openid: row.wx_openid || '',
        enabled: row.enabled !== false,
        remindAt: time.slice(0, 5),
        lastSentOn: row.last_sent_on ? String(row.last_sent_on).slice(0, 10) : '',
    };
}

async function readMine(userId) {
    const result = await cloud.database
        .from(TABLE)
        .select(COLUMNS)
        .eq('user_id', userId)
        .maybeSingle();
    if (!result || result.error) {
        return { row: null, error: dbError(result && result.error, '读取提醒设置失败') };
    }
    return { row: result.data ? mapRow(result.data) : null, error: null };
}

// 登录后把 openid 绑到设置行上。旧的 openid 变了（换微信号/重装）要跟着更新，
// 否则下发时会因为 openid 不属于当前小程序而被微信拒掉。
async function ensureBind(context) {
    if (!context || !context.session || !context.space || !context.meId) {
        return { ok: false, reason: 'no-context' };
    }
    const openid = openidOf(context.session);
    if (!openid) return { ok: false, reason: 'no-openid' };

    const spaceId = Number(context.space.id) || 0;
    try {
        const current = await readMine(context.meId);
        if (current.error) return { ok: false, reason: 'error', error: current.error };

        if (current.row) {
            if (current.row.openid === openid && current.row.spaceId === spaceId) {
                return { ok: true, bound: true, created: false };
            }
            const result = await cloud.database
                .from(TABLE)
                .update({ wx_openid: openid, space_id: spaceId, updated_at: nowIso() })
                .eq('user_id', context.meId)
                .select(COLUMNS);
            if (result && result.error) {
                return { ok: false, reason: 'error', error: dbError(result.error) };
            }
            return { ok: true, bound: true, created: false };
        }

        const result = await cloud.database
            .from(TABLE)
            .insert({
                user_id: context.meId,
                space_id: spaceId,
                wx_openid: openid,
                enabled: true,
                remind_at: DEFAULT_REMIND_AT,
            })
            .select(COLUMNS);
        if (result && result.error) {
            return { ok: false, reason: 'error', error: dbError(result.error, '绑定提醒失败') };
        }
        return { ok: true, bound: true, created: true };
    } catch (error) {
        return { ok: false, reason: 'error', error: dbError(error, '绑定提醒失败') };
    }
}

// 页面读取：先补绑定（微信登录时），再读设置。没有 openid 时就只有"收不到"这个结论。
async function load(context) {
    if (!context || !context.meId) {
        return { setting: null, canReceive: false, error: { message: '还没登录' } };
    }

    const openid = openidOf(context.session);
    if (openid) await ensureBind(context);

    const result = await readMine(context.meId);
    return {
        setting: result.row,
        canReceive: openid !== '',
        openid: openid,
        error: result.error,
    };
}

async function save(patch) {
    if (!scopeUserId) return { error: { message: '还没登录' } };

    const row = { updated_at: nowIso() };
    if (patch.enabled !== undefined) row.enabled = patch.enabled === true;
    if (patch.remindAt !== undefined) row.remind_at = String(patch.remindAt).slice(0, 5);

    if (Object.keys(row).length === 1) {
        return { error: { message: '没有要保存的改动' } };
    }

    try {
        const result = await cloud.database
            .from(TABLE)
            .update(row)
            .eq('user_id', scopeUserId)
            .select(COLUMNS);
        if (!result || result.error) {
            return { error: dbError(result && result.error, '保存提醒设置失败') };
        }
        const rows = Array.isArray(result.data) ? result.data : [];
        return { setting: rows.length > 0 ? mapRow(rows[0]) : null, error: null };
    } catch (error) {
        return { error: dbError(error, '保存提醒设置失败') };
    }
}

module.exports = {
    DEFAULT_REMIND_AT,
    setScope,
    ensureBind,
    load,
    save,
};
