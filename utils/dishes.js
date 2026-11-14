// 点菜：双人小家里「我想吃你做的」的请求单。
//
// 表 dish_request 对 anon / authenticated 没有任何表级权限（RLS 开启且不建 policy），
// 读写全部收敛到 dish_* 这组 SECURITY DEFINER 函数里。状态机的每一条校验都在 SQL 里：
// 客户端只发「动作」，绝不直接改 status —— 两个人同时点「我来做」时也不会双认领。

const { cloud } = require('./cloud');
const { relativeTime, dayLabel } = require('./format');

const SLOTS = [
    { key: 'breakfast', label: '早餐' },
    { key: 'lunch', label: '午餐' },
    { key: 'dinner', label: '晚餐' },
    { key: 'any', label: '都行' },
];

const STATUS_TONE = {
    wanted: 'warn',
    accepted: 'soft',
    done: 'ok',
    cancelled: 'quiet',
};

// 只靠 meId 判断「我点的 / TA 点的」，写库时的归属由函数取 auth.uid()，客户端传什么都不算。
let scopeMeId = '';

function setScope(spaceId, meId, meName) {
    scopeMeId = meId || '';
}

function slotLabel(key) {
    for (let i = 0; i < SLOTS.length; i += 1) {
        if (SLOTS[i].key === key) return SLOTS[i].label;
    }
    return '';
}

function errorOf(error, fallback) {
    const message = error && (error.message || (error.error && error.error.message));
    // 函数建好但 PostgREST 的 schema cache 还没刷新时，报错和「函数不存在」一模一样。
    if (message && /PGRST202|Could not find the function|schema cache/i.test(message)) {
        return { message: '点菜功能还没部署好，稍后再试' };
    }
    return { message: message || fallback };
}

async function callRpc(name, params, fallback) {
    try {
        const result = await cloud.database.rpc(name, params || {});
        if (!result || result.error) {
            return { data: null, error: errorOf(result ? result.error : null, fallback) };
        }
        return { data: result.data, error: null };
    } catch (error) {
        return { data: null, error: errorOf(error, fallback) };
    }
}

// 函数统一 returns setof dish_request，取第一行；delete 返回 boolean。
function firstRow(data) {
    if (Array.isArray(data)) return data.length > 0 ? data[0] : null;
    return data && typeof data === 'object' ? data : null;
}

// 通知对方。dish_request 对客户端没有任何权限，所以「找接收人 + 写站内消息 + 入推送队列」
// 全部收在 dish_notify 一个 SECURITY DEFINER 函数里，客户端只报告「谁发生了什么」。
//
// 刻意不 await：提醒是附加动作，失败不该让点菜/接单本身报错。
function notifyPartner(id, kind) {
    if (!id) return;
    callRpc('dish_notify', { p_id: Number(id) || id, p_kind: kind }, '提醒对方失败')
        .then((result) => {
            if (result.error) {
                console.warn('[dish] 提醒对方失败：' + result.error.message);
            }
        });
}

function textOf(value) {
    return value === null || value === undefined ? '' : String(value);
}

// 食材快照统一成 {name, amount, fromFridge}：
// 库里存的是 snake_case（from_fridge），页面用的是 camelCase，映射只在这里做一次。
function mapSnapshot(raw) {
    let list = [];
    if (Array.isArray(raw)) list = raw;
    else if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            list = Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            list = [];
        }
    }

    return list
        .map((item) => {
            if (typeof item === 'string') {
                return { name: item.trim(), amount: '', fromFridge: true };
            }
            if (!item || typeof item !== 'object') return null;
            const name = textOf(item.name).trim();
            if (name === '') return null;
            return {
                name: name,
                amount: textOf(item.amount),
                fromFridge: !(item.from_fridge === false || item.fromFridge === false),
            };
        })
        .filter((item) => item !== null);
}

function mapRow(row) {
    const meId = scopeMeId;
    const status = row && STATUS_TONE[row.status] ? row.status : 'wanted';
    const isMine = meId !== '' && textOf(row.requester_id) === meId;
    const iAmCook = meId !== '' && textOf(row.cook_id) === meId;

    const mealDate = row.meal_date ? textOf(row.meal_date).slice(0, 10) : '';
    const slot = row.meal_slot || '';
    const slotText = slotLabel(slot);
    const day = dayLabel(mealDate);

    // 文案按「我是谁」决定视角：同一个 accepted，点菜人看到「TA 接下了」，做饭的人看到「我接下了」。
    let statusText = '';
    if (status === 'wanted') statusText = isMine ? '等 TA 接单' : '待你接单';
    else if (status === 'accepted') statusText = iAmCook ? '我接下了' : 'TA 接下了';
    else if (status === 'done') statusText = iAmCook ? '我做好了' : 'TA 做好了';
    else statusText = '已取消';

    return {
        id: textOf(row.id),
        title: row.title || '',
        note: row.note || '',
        status: status,
        statusText: statusText,
        statusTone: STATUS_TONE[status],
        isMine: isMine,
        iAmCook: iAmCook,
        requesterLabel: isMine ? '我' : 'TA',
        cookLabel: textOf(row.cook_id) === '' ? '' : (iAmCook ? '我' : 'TA'),
        mealDate: mealDate,
        slot: slot,
        slotLabel: slotText,
        mealLabel: day && slotText ? day + ' · ' + slotText : (day || slotText),
        recipeId: textOf(row.recipe_id),
        // 食材快照：有它就不用再查收藏/模型，缺料永远算得出来
        used: mapSnapshot(row.ingredients),
        recipeSource: row.ingredients_source || '',
        recipeAt: row.ingredients_at || '',
        timeText: relativeTime(row.created_at),
        doneRecently: !!row.done_at
            && Date.now() - new Date(row.done_at).getTime() < 2 * 24 * 3600 * 1000,
        canClaim: !isMine && status === 'wanted',
        canFinish: iAmCook && status === 'accepted',
        canRelease: iAmCook && status === 'accepted',
        canCancel: isMine && (status === 'wanted' || status === 'accepted'),
        canDelete: status === 'done' || (status === 'cancelled' && isMine),
    };
}

function isOpen(item) {
    return item.status === 'wanted' || item.status === 'accepted';
}

// 按人分区：进行中的和两天内做好的留下，其余折叠进「最近结束」。
function group(items) {
    const mine = [];
    const theirs = [];
    const closed = [];

    (items || []).forEach((item) => {
        const keep = isOpen(item) || (item.status === 'done' && item.doneRecently);
        if (!keep) {
            closed.push(item);
            return;
        }
        if (item.isMine) mine.push(item);
        else theirs.push(item);
    });

    return { mine: mine, theirs: theirs, closed: closed.slice(0, 5) };
}

function summarize(items) {
    let pendingForMe = 0;
    let mineAccepted = 0;
    let mineDone = 0;
    let openCount = 0;

    (items || []).forEach((item) => {
        if (isOpen(item)) openCount += 1;
        if (!item.isMine && item.status === 'wanted') pendingForMe += 1;
        if (item.isMine && item.status === 'accepted') mineAccepted += 1;
        if (item.isMine && item.status === 'done') mineDone += 1;
    });

    return {
        pendingForMe: pendingForMe,
        mineAccepted: mineAccepted,
        mineDone: mineDone,
        openCount: openCount,
    };
}

async function list() {
    const result = await callRpc('dish_list', {}, '读取点菜失败');
    if (result.error) return { items: [], error: result.error };
    const rows = Array.isArray(result.data) ? result.data : [];
    return { items: rows.map(mapRow), error: null };
}

// 空值一律不发这个键：date 传 '' 会被 Postgres 判成 22007，传太早的 null 又会盖掉函数默认值。
async function create(payload) {
    const title = String((payload && payload.title) || '').trim();
    if (title === '') return { item: null, error: { message: '先写菜名' } };

    const params = { p_title: title.slice(0, 40) };
    if (payload.mealDate) params.p_meal_date = String(payload.mealDate).slice(0, 10);
    if (payload.mealSlot) params.p_meal_slot = payload.mealSlot;
    const note = String(payload.note || '').trim();
    if (note !== '') params.p_note = note.slice(0, 100);
    const recipeId = Number(payload.recipeId);
    if (isFinite(recipeId) && recipeId > 0) params.p_recipe_id = recipeId;

    const result = await callRpc('dish_create', params, '点菜失败');
    if (result.error) return { item: null, error: result.error };
    const row = firstRow(result.data);
    if (row) notifyPartner(row.id, 'new');
    return { item: row ? mapRow(row) : null, error: null };
}

// 单条读取：详情页用它，避免从 dish_list（SQL 里 LIMIT 100）里前端 find 导致第 101 条读不到。
async function get(id) {
    const result = await callRpc('dish_get', { p_id: Number(id) || id }, '读取这道菜失败');
    if (result.error) return { item: null, error: result.error };
    const row = firstRow(result.data);
    if (!row) return { item: null, error: { message: '这道菜已经不在了' } };
    return { item: mapRow(row), error: null };
}

// 同一小家里同名菜的历史快照，用来避免同一道菜反复调模型。
async function lookupByTitle(titleKeyValue) {
    const key = String(titleKeyValue || '');
    if (key === '') return { item: null, error: null };
    const result = await callRpc('dish_lookup_ingredients', { p_title_key: key }, '查历史食材失败');
    if (result.error) return { item: null, error: result.error };
    const row = firstRow(result.data);
    return { item: row ? mapRow(row) : null, error: null };
}

// 写食材快照。服务端「首写胜出」，只有点菜人能带 force 覆盖，所以这里不需要先读再写。
async function saveIngredients(id, payload) {
    const used = (payload.used || [])
        .map((unit) => ({
            name: String((unit && unit.name) || '').trim().slice(0, 24),
            amount: String((unit && unit.amount) || '').trim().slice(0, 20),
            from_fridge: !(unit && unit.fromFridge === false),
        }))
        .filter((unit) => unit.name !== '');

    if (used.length === 0) return { item: null, error: { message: '没有可保存的食材' } };

    const params = {
        p_id: Number(id) || id,
        p_title_key: String(payload.titleKey || '').slice(0, 48),
        p_ingredients: used,
        p_source: payload.source === 'favorite' ? 'favorite' : 'model',
    };
    const recipeId = Number(payload.recipeId);
    if (isFinite(recipeId) && recipeId > 0) params.p_recipe_id = recipeId;
    if (payload.model) params.p_model = String(payload.model).slice(0, 60);
    if (payload.force === true) params.p_force = true;

    const result = await callRpc('dish_set_ingredients', params, '保存食材失败');
    if (result.error) return { item: null, error: result.error };
    const row = firstRow(result.data);
    return { item: row ? mapRow(row) : null, error: null };
}

async function act(fn, id, fallback) {
    const result = await callRpc(fn, { p_id: Number(id) || id }, fallback);
    if (result.error) return { item: null, error: result.error };
    const row = firstRow(result.data);
    return { item: row ? mapRow(row) : null, error: null };
}

async function claim(id) {
    const result = await act('dish_claim', id, '接单失败');
    if (!result.error && result.item) notifyPartner(result.item.id, 'accepted');
    return result;
}

function finish(id) {
    return act('dish_finish', id, '标记失败');
}

function cancel(id) {
    return act('dish_cancel', id, '取消失败');
}

function release(id) {
    return act('dish_release', id, '放回失败');
}

async function remove(id) {
    const result = await callRpc('dish_delete', { p_id: Number(id) || id }, '删除失败');
    if (result.error) return { removed: false, error: result.error };
    return { removed: result.data === true, error: null };
}

module.exports = {
    SLOTS,
    setScope,
    slotLabel,
    mapRow,
    group,
    summarize,
    list,
    create,
    get,
    lookupByTitle,
    saveIngredients,
    claim,
    finish,
    cancel,
    release,
    remove,
};
