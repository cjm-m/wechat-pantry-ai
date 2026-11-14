// 周膳食计划（N9 四表闭环）的客户端数据层。
//
// 三张表（meal_plan / meal_plan_item / consumption_log）都是 RPC-only：
// 对 anon/authenticated 零表级权限，读写全部走 plan_* 这组 SECURITY DEFINER 函数。
// 状态机的每一条校验都在 SQL 里，客户端只发「动作」，绝不直接改 status。
//
// 幂等键由服务端按 cook:<item_id> / dish:<id> 生成，客户端不传 —— 带时间戳或
// 随机数的键会让唯一约束失效，网络超时重试就会扣两次库存（设计 §7.3）。
//
// 与 utils/dishes.js 的关系：两套状态机刻意独立（设计 §5.3）。
// dish_request 是「我想吃你做的」，meal_plan_item 是「这格吃什么」，互不改写。

const { cloud } = require('./cloud');

// 一个格子只能放一道菜，餐次只有三个：与 meal_plan_item.meal_slot 的 CHECK 一致。
const SLOTS = [
    { key: 'breakfast', label: '早餐' },
    { key: 'lunch', label: '午餐' },
    { key: 'dinner', label: '晚餐' },
];

const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

let scopeSpaceId = 0;
let scopeMeName = '';

function setScope(spaceId, meName) {
    scopeSpaceId = Number(spaceId) || 0;
    scopeMeName = meName || '';
}

function errorOf(error, fallback) {
    const message = error && (error.message || (error.error && error.error.message));
    // 函数建好但 PostgREST 的 schema cache 还没刷新时，报错和「函数不存在」一模一样。
    if (message && /PGRST202|Could not find the function|schema cache/i.test(message)) {
        return { message: '周计划功能还没部署好，稍后再试' };
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

function firstRow(data) {
    if (Array.isArray(data)) return data.length > 0 ? data[0] : null;
    return data && typeof data === 'object' ? data : null;
}

function textOf(value) {
    return value === null || value === undefined ? '' : String(value);
}

function toNumber(value, fallback) {
    const n = Number(value);
    return isFinite(n) ? n : fallback;
}

// ── 日期工具（全部用本地时间，不做时区转换）────────────────────────────────
// 服务端只校验「是不是周一」，归一到周一是客户端和服务端各自算一遍：
// 服务端算一次是为了防客户端传错，客户端算一次是为了给界面显示正确的周区间。

function pad2(n) {
    return n < 10 ? '0' + n : String(n);
}

function ymd(date) {
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
}

// 把任意 Date 归一到所在周的周一（周一为一周第一天，与 SQL 的 plan_to_monday 同口径）。
function toMonday(date) {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    // getDay(): 0=周日, 1=周一 ... 6=周六。
    const offset = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - offset);
    return d;
}

function addDays(date, days) {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    d.setDate(d.getDate() + days);
    return d;
}

function weekLabel(monday) {
    const sunday = addDays(monday, 6);
    return (monday.getMonth() + 1) + '/' + monday.getDate()
        + ' - ' + (sunday.getMonth() + 1) + '/' + sunday.getDate();
}

// ── 行映射 ────────────────────────────────────────────────────────────────
function mapItem(row) {
    const used = Array.isArray(row && row.used) ? row.used : [];
    return {
        id: textOf(row.id),
        planId: textOf(row.plan_id),
        dayOffset: toNumber(row.day_offset, 0),
        slot: row.meal_slot || '',
        slotLabel: slotLabel(row.meal_slot),
        title: row.dish_title || '',
        used: used.map((item) => ({
            name: textOf(item && item.name).trim(),
            amount: textOf(item && item.amount),
            fromFridge: !(item && (item.from_fridge === false || item.fromFridge === false)),
        })).filter((item) => item.name !== ''),
        servings: toNumber(row.servings, 2),
        status: row.status || 'planned',
        recipeId: textOf(row.recipe_id),
        cookedAt: row.cooked_at || '',
        canCook: (row.status || 'planned') === 'planned',
        canRemove: (row.status || 'planned') === 'planned',
    };
}

function mapPlan(row) {
    const shortage = Array.isArray(row && row.shortage) ? row.shortage : [];
    return {
        id: textOf(row.id),
        weekStart: row.week_start ? textOf(row.week_start).slice(0, 10) : '',
        status: row.status || 'drafted',
        shortage: shortage.map((item) => ({
            name: textOf(item && item.name),
            amount: textOf(item && item.amount),
            level: item && item.level === 'have' ? 'have' : (item && item.level === 'maybe' ? 'maybe' : 'miss'),
        })).filter((item) => item.name !== ''),
        shortageAt: row.shortage_at || '',
        confirmedAt: row.confirmed_at || '',
        createdAt: row.created_at || '',
    };
}

function slotLabel(key) {
    for (let i = 0; i < SLOTS.length; i += 1) {
        if (SLOTS[i].key === key) return SLOTS[i].label;
    }
    return '';
}

// 缺料按档位分三组：miss 要买、maybe 拿不准、have 不用买。
// 界面只展示 miss + maybe，have 只用来算「冰箱里有多少样够了」。
function groupShortage(shortage) {
    const miss = [];
    const maybe = [];
    const have = [];
    (shortage || []).forEach((item) => {
        if (item.level === 'miss') miss.push(item);
        else if (item.level === 'maybe') maybe.push(item);
        else have.push(item);
    });
    return { miss: miss, maybe: maybe, have: have };
}

// 把扁平 items 组织成 7 天 × 3 餐的二维表，供界面直接渲染。
function buildGrid(items, monday) {
    const days = [];
    for (let d = 0; d < 7; d += 1) {
        const date = addDays(monday, d);
        days.push({
            offset: d,
            label: WEEKDAY_LABELS[d],
            date: ymd(date),
            dateText: (date.getMonth() + 1) + '/' + date.getDate(),
            isToday: ymd(date) === ymd(new Date()),
            meals: SLOTS.map((slot) => ({
                slot: slot.key,
                slotLabel: slot.label,
                item: null,
            })),
        });
    }
    (items || []).forEach((item) => {
        const day = days[item.dayOffset];
        if (!day) return;
        for (let i = 0; i < day.meals.length; i += 1) {
            if (day.meals[i].slot === item.slot) {
                day.meals[i].item = item;
                return;
            }
        }
    });
    return days;
}

// 把 days 转成「一行一餐、一列一天」的矩阵，WXML 里可以直接两层 wx:for 渲染。
// 为什么不直接在 WXML 里 days[slotIndex] 索引：小程序模板不支持在 wx:for
// 里按外层索引去访问另一层数组，写法能过编译但渲染结果不可靠。
function buildRows(days) {
    return SLOTS.map((slot, slotIndex) => ({
        slot: slot.key,
        slotLabel: slot.label,
        cells: (days || []).map((day) => ({
            dayOffset: day.offset,
            slot: slot.key,
            item: day.meals[slotIndex] ? day.meals[slotIndex].item : null,
        })),
    }));
}

// ── 9 个 RPC 的封装 ───────────────────────────────────────────────────────

// 拿回本周（或任意一天所在的周）的计划；没有就建一份 drafted。
// p_day 传本地日期字符串（YYYY-MM-DD），不传 Date 对象 —— 后者会被 JSON 序列化成 UTC。
async function ensureWeek(anyDay) {
    const day = anyDay || ymd(new Date());
    const result = await callRpc('plan_ensure_week', { p_day: day }, '读取本周菜单失败');
    if (result.error) return { plan: null, error: result.error };
    const row = firstRow(result.data);
    return { plan: row ? mapPlan(row) : null, error: null };
}

// 一次拿全：{plan, items[]}。items 已排序（按 day_offset, meal_slot）。
async function get(planId) {
    const result = await callRpc('plan_get', { p_plan_id: Number(planId) || planId }, '读取菜单失败');
    if (result.error) return { plan: null, items: [], error: result.error };
    const payload = result.data && typeof result.data === 'object' ? result.data : {};
    const planRow = payload.plan || null;
    if (!planRow) return { plan: null, items: [], error: { message: '这份计划已经不在了' } };
    const rows = Array.isArray(payload.items) ? payload.items : [];
    return { plan: mapPlan(planRow), items: rows.map(mapItem), error: null };
}

// 往格子里放一道菜。同一个格子已存在则覆盖（仅限还没做的）。
async function addItem(payload) {
    const title = String((payload && payload.title) || '').trim();
    if (title === '') return { item: null, error: { message: '先写菜名' } };

    const params = {
        p_plan_id: Number(payload.planId) || payload.planId,
        p_day_offset: toNumber(payload.dayOffset, 0),
        p_slot: payload.slot,
    };
    params.p_title = title.slice(0, 40);

    // used 只发 {name, amount, from_fridge} 三个键，与 dish_request.ingredients 同形状。
    const used = (payload.used || [])
        .map((unit) => ({
            name: String((unit && unit.name) || '').trim().slice(0, 24),
            amount: String((unit && unit.amount) || '').trim().slice(0, 20),
            from_fridge: !(unit && unit.fromFridge === false),
        }))
        .filter((unit) => unit.name !== '');
    if (used.length > 0) params.p_used = used;

    const recipeId = Number(payload.recipeId);
    if (isFinite(recipeId) && recipeId > 0) params.p_recipe_id = recipeId;

    const result = await callRpc('plan_add_item', params, '排菜失败');
    if (result.error) return { item: null, error: result.error };
    const row = firstRow(result.data);
    return { item: row ? mapItem(row) : null, error: null };
}

async function removeItem(itemId) {
    const result = await callRpc('plan_remove_item', { p_item_id: Number(itemId) || itemId }, '删除失败');
    if (result.error) return { removed: false, error: result.error };
    if (result.data !== true) return { removed: false, error: { message: '这道菜已经不在了' } };
    return { removed: true, error: null };
}

async function confirm(planId) {
    const result = await callRpc('plan_confirm', { p_plan_id: Number(planId) || planId }, '确认失败');
    if (result.error) return { plan: null, error: result.error };
    const row = firstRow(result.data);
    return { plan: row ? mapPlan(row) : null, error: null };
}

// 库存变了以后手动刷新缺料快照（不改计划状态）。
async function refreshShortage(planId) {
    const result = await callRpc('plan_shortage', { p_plan_id: Number(planId) || planId }, '刷新缺料失败');
    if (result.error) return { plan: null, error: result.error };
    const row = firstRow(result.data);
    return { plan: row ? mapPlan(row) : null, error: null };
}

async function cancel(planId) {
    const result = await callRpc('plan_cancel', { p_plan_id: Number(planId) || planId }, '作废失败');
    if (result.error) return { plan: null, error: result.error };
    const row = firstRow(result.data);
    return { plan: row ? mapPlan(row) : null, error: null };
}

// 做完一道菜。consume = [{ingredientId, action:'removed'|'kept'}]，默认全 removed。
// 幂等键由服务端生成（cook:<item_id>），这里不传 —— 客户端传键会让重试变成新键。
async function cookItem(payload) {
    const itemId = Number(payload && payload.itemId) || (payload && payload.itemId);
    if (!itemId) return { result: null, error: { message: '这道菜已经不在了' } };

    const consume = (payload.consume || [])
        .map((unit) => {
            const id = Number(unit && unit.ingredientId);
            if (!isFinite(id) || id <= 0) return null;
            return {
                ingredient_id: id,
                action: unit && unit.action === 'kept' ? 'kept' : 'removed',
            };
        })
        .filter((unit) => unit !== null);

    const result = await callRpc('plan_cook_item', {
        p_item_id: itemId,
        p_consume: consume,
    }, '标记失败');
    if (result.error) return { result: null, error: result.error };
    return { result: result.data || null, error: null };
}

// 点菜做完之后记消耗（设计 §8.3：独立于 dish_finish，避免 DROP 线上 RPC）。
async function dishConsume(dishId, consume) {
    const id = Number(dishId) || dishId;
    if (!id) return { result: null, error: { message: '这道菜已经不在了' } };

    const list = (consume || [])
        .map((unit) => {
            const cid = Number(unit && unit.ingredientId);
            if (!isFinite(cid) || cid <= 0) return null;
            return {
                ingredient_id: cid,
                action: unit && unit.action === 'kept' ? 'kept' : 'removed',
            };
        })
        .filter((unit) => unit !== null);

    const result = await callRpc('dish_consume', {
        p_dish_id: id,
        p_consume: list,
    }, '记录消耗失败');
    if (result.error) return { result: null, error: result.error };
    return { result: result.data || null, error: null };
}

// 「这周还有几道没做」—— 首页入口角标用。拿的是本周计划，不新建。
async function pendingCount() {
    const ensured = await ensureWeek(ymd(new Date()));
    if (ensured.error || !ensured.plan) return { count: 0, error: ensured.error };
    const detail = await get(ensured.plan.id);
    if (detail.error) return { count: 0, error: detail.error };
    const pending = detail.items.filter((item) => item.status === 'planned').length;
    return { count: pending, error: null };
}

// 消耗记录（M4）。consumption_log 是 RPC-only 表，客户端直读 42501，
// 必须走 consumption_list 这个 SECURITY DEFINER 函数。
// 返回的 items 形如 [{ingredient_id, name, action}]。
async function listConsumption(limit) {
    const result = await callRpc('consumption_list', {
        p_limit: Number(limit) > 0 ? Math.floor(Number(limit)) : 50,
    }, '读取消耗记录失败');
    if (result.error) return { items: [], error: result.error };

    const rows = Array.isArray(result.data) ? result.data : [];
    return {
        items: rows.map((row) => {
            const items = Array.isArray(row.items) ? row.items : [];
            const removed = items.filter((unit) => unit && unit.action === 'removed');
            return {
                id: textOf(row.id),
                dishTitle: row.dish_title || '',
                reason: row.reason || 'cooked',
                createdAt: row.created_at || '',
                fromPlan: !!row.plan_item_id,
                nutrition: row.nutrition && typeof row.nutrition === 'object' ? row.nutrition : null,
                removedCount: removed.length,
                removedNames: removed.map((unit) => textOf(unit.name)).filter((name) => name !== ''),
            };
        }),
        error: null,
    };
}

// 每日营养聚合（M12）。返回 [{day, kcal, protein, carb, fat, meals, estimated}]，按日倒序。
// 全部数值只统计「当时有营养估算」的记录；meals 是当天总餐数，estimated 是其中带估算的。
async function nutritionDaily(days) {
    const result = await callRpc('nutrition_daily', {
        p_days: Number(days) > 0 ? Math.floor(Number(days)) : 7,
    }, '读取营养统计失败');
    if (result.error) return { days: [], error: result.error };
    const rows = Array.isArray(result.data) ? result.data : [];
    return {
        days: rows.map((row) => ({
            day: textOf(row.day).slice(0, 10),
            kcal: Number(row.kcal) || 0,
            protein: Number(row.protein) || 0,
            carb: Number(row.carb) || 0,
            fat: Number(row.fat) || 0,
            meals: Number(row.meals) || 0,
            estimated: Number(row.estimated) || 0,
        })),
        error: null,
    };
}

module.exports = {
    SLOTS,
    WEEKDAY_LABELS,
    setScope,
    // 日期工具（页面直接用，不要再写一份）
    ymd,
    toMonday,
    addDays,
    weekLabel,
    slotLabel,
    // 视图组装
    groupShortage,
    buildGrid,
    buildRows,
    mapPlan,
    mapItem,
    // RPC
    ensureWeek,
    get,
    addItem,
    removeItem,
    confirm,
    refreshShortage,
    cancel,
    cookItem,
    dishConsume,
    pendingCount,
    listConsumption,
    nutritionDaily,
};
