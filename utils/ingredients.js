// 食材数据层：一张表的增删改查，复用平台的数据访问资产。
// 归属字段 space_id / owner_id 由调用方与本模块补齐，owner_id 永远不由客户端发送。
// 读取不需要按 space_id 过滤：RLS 已经限定成「只属于当前用户所在的小家」。

const { cloud } = require('./cloud');
const { createTableAccess } = require('./workbuddy-data-access');
const { amountText, categoryIndex, expireInfo } = require('./format');

const COLUMNS = [
    'id',
    'space_id',
    'owner_id',
    'owner_name',
    'name',
    'category',
    'quantity',
    'unit',
    'note',
    'storage',
    'expire_at',
    'created_at',
    'updated_at',
];

let scopeSpaceId = 0;
let scopeMyId = '';
let scopeMyName = '';

function mapRow(row) {
    const expireAt = row.expire_at ? String(row.expire_at).slice(0, 10) : '';
    return {
        id: String(row.id),
        name: row.name || '',
        category: row.category || '其他',
        quantity: row.quantity || '',
        unit: row.unit || '',
        note: row.note || '',
        storage: row.storage === '冷冻' ? '冷冻' : '冷藏',
        expireAt: expireAt,
        expire: expireInfo(expireAt),
        ownerId: row.owner_id || '',
        ownerName: row.owner_name || '',
        amount: amountText(row.quantity, row.unit),
        createdAt: row.created_at || '',
    };
}

const access = createTableAccess(cloud, {
    table: 'ingredient',
    columns: COLUMNS,
    orderBy: { column: 'created_at', ascending: false },
    toRow(payload) {
        const row = {};
        if (payload.space_id !== undefined) row.space_id = payload.space_id;
        if (payload.name !== undefined) row.name = String(payload.name).trim();
        if (payload.category !== undefined) row.category = payload.category;
        if (payload.quantity !== undefined) row.quantity = payload.quantity;
        if (payload.unit !== undefined) row.unit = payload.unit;
        if (payload.note !== undefined) row.note = payload.note;
        if (payload.storage !== undefined) row.storage = payload.storage === '冷冻' ? '冷冻' : '冷藏';
        if (payload.expire_at !== undefined) row.expire_at = payload.expire_at || null;
        if (payload.owner_name !== undefined) row.owner_name = payload.owner_name;
        return row;
    },
    fromRow: mapRow,
});

function setScope(spaceId, myId, myName) {
    scopeSpaceId = Number(spaceId) || 0;
    scopeMyId = myId || '';
    scopeMyName = myName || '';
}

function getMyId() {
    return scopeMyId;
}

// 按类别分组，空组不展示；组内保持数据库返回的时间倒序。
function group(items) {
    const buckets = {};
    (items || []).forEach((item) => {
        if (!buckets[item.category]) buckets[item.category] = [];
        buckets[item.category].push(item);
    });
    const groups = [];
    Object.keys(buckets).forEach((key) => {
        groups.push({ key: key, items: buckets[key] });
    });
    groups.sort((a, b) => categoryIndex(a.key) - categoryIndex(b.key));
    return groups;
}

const STORAGE_AREAS = ['冷藏', '冷冻'];

// 先按存放区域分板块，板块内再按类别分组。
function groupByArea(items) {
    return STORAGE_AREAS.map((area) => {
        const scoped = (items || []).filter((item) => item.storage === area);
        return {
            key: area,
            count: scoped.length,
            groups: group(scoped),
        };
    });
}

async function list() {
    const result = await access.list();
    return { items: result.data || [], error: result.error };
}

async function get(id) {
    try {
        const result = await cloud.database
            .from('ingredient')
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

async function create(payload) {
    const result = await access.create({
        space_id: scopeSpaceId,
        name: payload.name,
        category: payload.category,
        quantity: payload.quantity || '',
        unit: payload.unit || '',
        note: payload.note || '',
        storage: payload.storage === '冷冻' ? '冷冻' : '冷藏',
        expire_at: payload.expireAt || null,
        owner_name: scopeMyName || null,
    });
    return { item: result.data, error: result.error };
}

// 批量入库：识别结果和购物车结算都走这里，一条 INSERT 写多行。
async function createMany(rows) {
    const payload = (rows || []).map((item) => ({
        space_id: scopeSpaceId,
        name: String(item.name || '').trim(),
        category: item.category || '其他',
        quantity: item.quantity === undefined || item.quantity === null ? '' : String(item.quantity),
        unit: item.unit || '',
        note: item.note || '',
        storage: item.storage === '冷冻' ? '冷冻' : '冷藏',
        expire_at: item.expireAt || null,
        owner_name: scopeMyName || null,
    })).filter((item) => item.name !== '');

    if (payload.length === 0) {
        return { count: 0, error: { message: '没有可添加的食材' } };
    }
    try {
        const result = await cloud.database.from('ingredient').insert(payload).select('id');
        if (!result || result.error) {
            return { count: 0, error: result ? result.error : { message: '保存失败' } };
        }
        const saved = Array.isArray(result.data) ? result.data : [];
        return { count: saved.length, error: null };
    } catch (error) {
        return { count: 0, error: { message: (error && error.message) || '保存失败' } };
    }
}

// 编辑不写 owner_name：谁加的这件事不该被后来编辑的人改掉。
async function update(id, patch) {
    const row = {
        name: patch.name,
        category: patch.category,
        quantity: patch.quantity || '',
        unit: patch.unit || '',
        note: patch.note || '',
        expire_at: patch.expireAt || null,
    };
    // 只有调用方明确给了存放位置才写，避免别的模块改个数量就把冷冻挪回冷藏。
    if (patch.storage !== undefined) {
        row.storage = patch.storage === '冷冻' ? '冷冻' : '冷藏';
    }
    const result = await access.update(id, row);
    return { item: result.data, error: result.error };
}

// 只改保质期：AI 补保质期时用，避免顺手把其他字段一起重写。
async function setExpireAt(id, date) {
    const result = await access.update(id, { expire_at: date || null });
    return { item: result.data, error: result.error };
}

async function remove(id) {
    const result = await access.remove(id);
    return { removed: result.data, error: result.error };
}

module.exports = {
    setScope,
    getMyId,
    group,
    groupByArea,
    STORAGE_AREAS,
    list,
    get,
    create,
    createMany,
    update,
    setExpireAt,
    remove,
};
