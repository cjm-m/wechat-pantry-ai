// 购物车（采购清单）—— 两人共享，存在 shopping_item 表里。
//
// 客户端不直接读写这张表：表对 authenticated 没有授任何权限，所有操作都走
// cart_list / cart_add / cart_update / cart_remove / cart_clear 五个 SECURITY DEFINER 函数，
// 函数内部用 auth.uid() 校验调用者是不是这个小家的成员。
// 好处是客户端拿不到越权入口，也不需要给表开表级权限。

const { cloud } = require('./cloud');
const { cents } = require('./format');

let scopeSpaceId = 0;
let scopeMyName = '';

function setScope(spaceId, myName) {
    scopeSpaceId = Number(spaceId) || 0;
    scopeMyName = myName || '';
}

function normalizeItem(raw) {
    const quantity = Number(raw.quantity);
    return {
        id: String(raw.id),
        name: String(raw.name || '').trim(),
        quantity: isFinite(quantity) && quantity > 0 ? quantity : 1,
        unit: raw.unit || '',
        price: Number(raw.price) || 0,
        ownerId: raw.owner_id || raw.ownerId || '',
    };
}

function errorOf(error, fallback) {
    const message = error && (error.message || (error.error && error.error.message));
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

// 合计用「分」做整数累加，避免 0.1 + 0.2 这类浮点误差。
function summarize(items) {
    let totalCents = 0;
    let count = 0;
    (items || []).forEach((item) => {
        totalCents += cents(item.price) * (Number(item.quantity) || 0);
        count += Number(item.quantity) || 0;
    });
    return {
        cents: totalCents,
        text: (totalCents / 100).toFixed(2),
        count: Math.round(count * 100) / 100,
    };
}

async function list() {
    const result = await callRpc('cart_list', {}, '读取购物车失败');
    if (result.error) return { items: [], error: result.error };
    const rows = Array.isArray(result.data) ? result.data : [];
    return { items: rows.map(normalizeItem), error: null };
}

async function add(payload) {
    const name = String(payload.name || '').trim();
    if (name === '') return { item: null, error: { message: '先填要买什么' } };
    const quantity = Number(payload.quantity);
    const price = Number(payload.price);
    const result = await callRpc('cart_add', {
        p_name: name,
        p_quantity: isFinite(quantity) && quantity > 0 ? quantity : 1,
        p_unit: String(payload.unit || '').trim() || null,
        p_price: isFinite(price) && price > 0 ? price : 0,
    }, '加入购物车失败');
    if (result.error) return { item: null, error: result.error };
    const rows = Array.isArray(result.data) ? result.data : [];
    return { item: rows.length > 0 ? normalizeItem(rows[0]) : null, error: null };
}

// p_quantity / p_price 传 null 表示这一项不改。
async function update(id, patch) {
    const params = { p_id: Number(id) || id };
    if (patch.quantity !== undefined) params.p_quantity = Number(patch.quantity) || 1;
    if (patch.price !== undefined) params.p_price = Number(patch.price) || 0;
    if (patch.name !== undefined) {
        // 改名走「删掉重建」没有意义，这里只支持数量与单价，名称在购物车里不可改。
        delete params.p_name;
    }
    const result = await callRpc('cart_update', params, '修改失败');
    if (result.error) return { error: result.error };
    if (result.data !== true) return { error: { message: '这条商品已经不在了' } };
    return { error: null };
}

async function remove(id) {
    const result = await callRpc('cart_remove', { p_id: Number(id) || id }, '删除失败');
    if (result.error) return { error: result.error };
    if (result.data !== true) return { error: { message: '这条商品已经不在了' } };
    return { error: null };
}

async function clear() {
    const result = await callRpc('cart_clear', {}, '清空失败');
    if (result.error) return { error: result.error };
    return { error: null };
}

module.exports = {
    setScope,
    list,
    add,
    update,
    remove,
    clear,
    summarize,
};
