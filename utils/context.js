// 登录态 + 小家上下文：一次查询拿到 { session, meId, member, space, error }。
// 上层（app.js）负责缓存；这里只负责取真实数据，不做缓存也不做跳转。

const { cloud } = require('./cloud');

function userIdOf(session) {
    if (!session || typeof session !== 'object') return '';
    const user = session.user;
    if (!user || typeof user !== 'object') return '';
    return user.id || user.userId || user.user_id || '';
}

function nameOf(session) {
    if (!session || !session.user) return '';
    const user = session.user;
    return user.name || user.nickname || user.email || '';
}

async function readSession() {
    try {
        const result = await cloud.auth.getSession();
        if (!result || result.error) {
            return { session: null, error: result ? result.error : null };
        }
        return { session: result.data || null, error: null };
    } catch (error) {
        return { session: null, error: { message: (error && error.message) || '无法读取登录状态' } };
    }
}

// 找不到成员行就是「还没绑定小家」，属于正常状态，不是错误。
async function readMember(userId) {
    let query = cloud.database
        .from('couple_member')
        .select('space_id, user_id, display_name, joined_at');
    if (userId) query = query.eq('user_id', userId);
    const result = await query.limit(1);
    if (!result || result.error) {
        return { member: null, error: result ? result.error : null };
    }
    const rows = Array.isArray(result.data) ? result.data : [];
    return { member: rows.length > 0 ? rows[0] : null, error: null };
}

// 强制刷新一次会话。
// SDK 的 sessions.peek() 在「refresh 正在进行」或「refresh 刚失败、处于 60s 冷却」
// 这两种情况下返回 null，此时请求不带 Authorization，PostgREST 会以 anon 身份执行：
// RLS 把行全部过滤掉，返回 **200 []**（不是 401）。
// 若把这种「查不到」当成「没加入小家」，用户就会被踢回绑定页。
async function forceRefreshSession() {
    try {
        if (!cloud.auth || typeof cloud.auth.refreshSession !== 'function') return false;
        const result = await cloud.auth.refreshSession();
        return !!(result && !result.error && result.data);
    } catch (error) {
        return false;
    }
}

async function readSpace(spaceId) {
    const result = await cloud.database
        .from('couple_space')
        .select('id, name, invite_code, created_by, created_at')
        .eq('id', spaceId)
        .maybeSingle();
    if (!result || result.error) {
        return { space: null, error: result ? result.error : null };
    }
    return { space: result.data || null, error: null };
}

// retried 用于防止刷新后仍然拿不到 user.id 时无限递归。
async function loadContext(retried) {
    const sessionResult = await readSession();
    if (!sessionResult.session) {
        return { session: null, meId: '', meName: '', member: null, space: null, error: sessionResult.error };
    }
    const session = sessionResult.session;
    const meId = userIdOf(session);

    // 会话里没有 user.id 说明 SDK 给的是一个残包（refresh 窗口期的中间态）。
    // 这种情况要当成「登录态异常」往上抛，让 auth-guard 走登录页；
    // 不能当成「没加入小家」，否则会把已绑定的人踢回绑定页。
    // 先尝试强制刷新一次，刷回来就是正常流程。
    if (meId === '') {
        if (!retried && await forceRefreshSession()) {
            return loadContext(true);
        }
        return {
            session,
            meId: '',
            meName: '',
            member: null,
            space: null,
            error: { message: '登录状态不完整，请重新进入小程序' },
        };
    }

    let memberResult = await readMember(meId);
    if (memberResult.error) {
        // 查询报错（典型是 401：access_token 过期或被拒）不能当成「没加入」。
        // 强制刷一次会话再查；刷完能查到就走正常流程。
        if (!retried && await forceRefreshSession()) {
            return loadContext(true);
        }
        return { session, meId, meName: nameOf(session), member: null, space: null, error: memberResult.error };
    }

    // 查到 0 行有两种可能：真的没加入，或者这次请求没带上身份（RLS 过滤成空）。
    // 后者 PostgREST 返回的是 200 []，和「没加入」长得一模一样。
    // 所以空结果先强制刷一次会话再查一次，两次都空才认定没加入。
    if (!memberResult.member && !retried) {
        const refreshed = await forceRefreshSession();
        if (refreshed) {
            return loadContext(true);
        }
    }

    if (!memberResult.member) {
        return { session, meId, meName: nameOf(session), member: null, space: null, error: null };
    }

    const spaceResult = await readSpace(memberResult.member.space_id);
    if (spaceResult.error && !retried && await forceRefreshSession()) {
        return loadContext(true);
    }
    return {
        session,
        meId,
        meName: nameOf(session),
        member: memberResult.member,
        space: spaceResult.space,
        error: spaceResult.error,
    };
}

// 建小家 / 加入小家都走服务端函数：邀请码生成、2 人上限、一人一小家都在数据库里保证。
async function callSpaceRpc(fn, params) {
    try {
        const result = await cloud.database.rpc(fn, params);
        if (!result || result.error) {
            return { space: null, error: result ? result.error : { message: '操作失败，请重试' } };
        }
        const rows = Array.isArray(result.data) ? result.data : (result.data ? [result.data] : []);
        if (rows.length === 0) {
            return { space: null, error: { message: '操作没有生效，请重试' } };
        }
        return { space: rows[0], error: null };
    } catch (error) {
        return { space: null, error: { message: (error && error.message) || '操作失败，请重试' } };
    }
}

function createSpace(name) {
    return callSpaceRpc('create_space', { p_name: (name || '').trim() || null });
}

function joinSpace(code) {
    return callSpaceRpc('join_space', { p_code: (code || '').trim().toUpperCase() });
}

async function listMembers(spaceId) {
    const result = await cloud.database
        .from('couple_member')
        .select('user_id, display_name, joined_at')
        .eq('space_id', spaceId);
    if (!result || result.error) {
        return { members: [], error: result ? result.error : null };
    }
    return { members: Array.isArray(result.data) ? result.data : [], error: null };
}

async function signOut() {
    try {
        await cloud.auth.signOut();
        return { error: null };
    } catch (error) {
        return { error: { message: (error && error.message) || '退出失败' } };
    }
}

module.exports = {
    loadContext,
    createSpace,
    joinSpace,
    listMembers,
    signOut,
    userIdOf,
    nameOf,
};
