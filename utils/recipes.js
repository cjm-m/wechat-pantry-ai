// 收藏菜谱数据层。ingredients / steps 存 JSONB 数组，读取时统一成数组，前端不用再判空。

const { cloud } = require('./cloud');
const { createTableAccess } = require('./workbuddy-data-access');

const COLUMNS = [
    'id',
    'space_id',
    'owner_id',
    'owner_name',
    'title',
    'summary',
    'ingredients',
    'steps',
    'nutrition',
    'created_at',
];

let scopeSpaceId = 0;
let scopeMyName = '';

function asArray(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            return [];
        }
    }
    return [];
}

function mapUsed(used) {
    return asArray(used).map((item) => {
        if (typeof item === 'string') {
            return { name: item, amount: '', fromFridge: true };
        }
        return {
            name: item.name || '',
            amount: item.amount || '',
            fromFridge: item.fromFridge !== false,
        };
    });
}

// 步骤归一：写入端（cooking.normalizeSteps）保证是字符串数组，但读取端不能假设——
// 列注释（schema-rebuild.sql）明确写了「steps 为字符串或 {text} 对象数组」，
// 历史数据与手工导入都可能带对象。WXML 里 {{step}} 对对象会渲染 '[object Object]'。
function normalizeStepList(steps) {
    return asArray(steps)
        .map((item) => {
            if (item && typeof item === 'object') {
                const text = item.text || item.desc || item.description || item.content || item.detail;
                return text === null || text === undefined ? '' : String(text).trim();
            }
            return item === null || item === undefined ? '' : String(item).trim();
        })
        .filter((text) => text !== '');
}

// 营养只接受对象形态；数值合法性交给写入端（cooking.normalizeNutrition）把关，
// 这里只保证读出来不是字符串、不是数组，避免页面 setData 到奇怪的结构。
function normalizeNutritionValue(raw) {
    let value = raw;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        } catch (error) {
            return null;
        }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value;
}

function mapRow(row) {
    return {
        id: String(row.id),
        title: row.title || '',
        summary: row.summary || '',
        used: mapUsed(row.ingredients),
        steps: normalizeStepList(row.steps),
        nutrition: normalizeNutritionValue(row.nutrition),
        ownerId: row.owner_id || '',
        ownerName: row.owner_name || '',
        createdAt: row.created_at || '',
    };
}

const access = createTableAccess(cloud, {
    table: 'recipe_favorite',
    columns: COLUMNS,
    orderBy: { column: 'created_at', ascending: false },
    toRow(payload) {
        const row = {};
        if (payload.space_id !== undefined) row.space_id = payload.space_id;
        if (payload.title !== undefined) row.title = String(payload.title).trim();
        if (payload.summary !== undefined) row.summary = payload.summary;
        if (payload.ingredients !== undefined) row.ingredients = payload.ingredients;
        if (payload.steps !== undefined) row.steps = payload.steps;
        if (payload.nutrition !== undefined) row.nutrition = payload.nutrition;
        if (payload.owner_name !== undefined) row.owner_name = payload.owner_name;
        return row;
    },
    fromRow: mapRow,
});

function setScope(spaceId, myName) {
    scopeSpaceId = Number(spaceId) || 0;
    scopeMyName = myName || '';
}

async function list() {
    const result = await access.list();
    return { items: result.data || [], error: result.error };
}

async function get(id) {
    try {
        const result = await cloud.database
            .from('recipe_favorite')
            .select(COLUMNS.join(','))
            .eq('id', id)
            .maybeSingle();
        if (!result || result.error) {
            return { item: null, error: result ? result.error : { message: '读取失败' } };
        }
        return { item: result.data ? mapRow(result.data) : null, error: null };
    } catch (error) {
        return { item: null, error: { message: (error && error.message) || '读取失败' } };
    }
}

async function save(dish) {
    const payload = {
        space_id: scopeSpaceId,
        title: dish.title,
        summary: dish.summary || '',
        ingredients: Array.isArray(dish.used) ? dish.used : [],
        steps: Array.isArray(dish.steps) ? dish.steps : [],
        owner_name: scopeMyName || null,
    };
    // nutrition 只在真有值时带上。没有估算时把这一列整个省掉，而不是显式写 null：
    // PostgREST 会按 payload 里出现的列名生成 SQL，列不存在直接 400（PGRST204）。
    // 省掉这一列，旧库上新客户端至少能继续收藏（只是没有营养）。
    if (dish.nutrition) payload.nutrition = dish.nutrition;

    const result = await access.create(payload);
    return { item: result.data, error: result.error };
}

async function remove(id) {
    const result = await access.remove(id);
    return { removed: result.data, error: result.error };
}

module.exports = {
    setScope,
    list,
    get,
    save,
    remove,
    normalizeStepList,
};
