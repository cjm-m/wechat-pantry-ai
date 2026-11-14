// 冰箱页的「草稿勾选」与配菜页的「已提交食材」是两份独立状态：
//   draft     —— 只在冰箱页内勾选，进入冰箱页就清空（上一次的选择不该残留）；
//   committed —— 只有点「去配菜」时才由 draft 整体覆盖写入，配菜页只认这一份。
//
// 分成两份之后：在冰箱里试选不会提前串到配菜页；从配菜页返回冰箱也不会把配菜页的食材抹掉。
// 两份都只放内存、不落盘：勾选是一次性的临场状态，写进 Storage 会在下次启动被读回来。

const { CATEGORY_KEYS } = require('./format');

// 旧版本用过的键，仅用于在启动时清理残留。
const LEGACY_STORAGE_KEY = 'couple_cook_selection';

let loaded = false;

function normalize(id) {
    if (id === null || id === undefined) return '';
    return String(id);
}

// 一份 id 集合。两份状态共用同一套规则，避免两边行为漂移。
function createBucket() {
    let ids = [];
    let listeners = [];

    function emit() {
        const snapshot = ids.slice();
        listeners.forEach((fn) => {
            try {
                fn(snapshot);
            } catch (error) {
                // 单个订阅者异常不影响其他页面。
            }
        });
    }

    function getIds() {
        return ids.slice();
    }

    function has(id) {
        return ids.indexOf(normalize(id)) >= 0;
    }

    // 内容没变就不广播，省掉一次无意义的渲染。
    function replace(next) {
        const changed = next.length !== ids.length || next.some((id, index) => id !== ids[index]);
        ids = next;
        if (changed) emit();
        return ids.slice();
    }

    function toggle(id) {
        const key = normalize(id);
        if (key === '') return ids.slice();
        const index = ids.indexOf(key);
        if (index >= 0) {
            ids.splice(index, 1);
        } else {
            ids.push(key);
        }
        emit();
        return ids.slice();
    }

    function remove(id) {
        const key = normalize(id);
        const index = ids.indexOf(key);
        if (index < 0) return ids.slice();
        ids.splice(index, 1);
        emit();
        return ids.slice();
    }

    function clear() {
        if (ids.length === 0) return;
        ids = [];
        emit();
    }

    function setAll(list) {
        return replace((list || []).map(normalize).filter((id) => id !== ''));
    }

    // 用最新食材列表校正：已删除的丢弃，顺序按类别重排（chips 不会因勾选先后跳动）。
    function reconcile(items) {
        const valid = {};
        const order = {};
        (items || []).forEach((item) => {
            const key = normalize(item.id);
            if (key === '') return;
            valid[key] = true;
            const index = CATEGORY_KEYS.indexOf(item.category);
            order[key] = index < 0 ? CATEGORY_KEYS.length : index;
        });
        const next = ids.filter((id) => valid[id] === true);
        next.sort((a, b) => (order[a] - order[b]));
        return replace(next);
    }

    function subscribe(fn) {
        if (typeof fn !== 'function') return function noop() {};
        listeners.push(fn);
        return function unsubscribe() {
            listeners = listeners.filter((item) => item !== fn);
        };
    }

    return { getIds, has, toggle, remove, clear, setAll, reconcile, subscribe };
}

const draft = createBucket();
const committed = createBucket();

// app.js 启动时调用一次：丢弃历史版本落盘的勾选记录，本次会话从空白开始。
function init() {
    if (loaded) return;
    loaded = true;
    try {
        wx.removeStorageSync(LEGACY_STORAGE_KEY);
    } catch (error) {
        // 清理失败不影响本次会话。
    }
}

// 点「去配菜」时调用：草稿整体覆盖已提交。
// 草稿为空时不覆盖——否则误点一下就会把配菜页已经排好的食材清空。
function commitDraft() {
    const ids = draft.getIds();
    if (ids.length === 0) return false;
    committed.setAll(ids);
    return true;
}

// 退出登录：两份都清掉。
function reset() {
    draft.clear();
    committed.clear();
}

module.exports = {
    init,
    reset,
    commitDraft,

    // 草稿（冰箱页）
    getDraft: draft.getIds,
    hasDraft: draft.has,
    toggleDraft: draft.toggle,
    removeDraft: draft.remove,
    clearDraft: draft.clear,
    reconcileDraft: draft.reconcile,
    subscribeDraft: draft.subscribe,

    // 已提交（配菜页）
    getCommitted: committed.getIds,
    hasCommitted: committed.has,
    removeCommitted: committed.remove,
    clearCommitted: committed.clear,
    setAllCommitted: committed.setAll,
    reconcileCommitted: committed.reconcile,
    subscribeCommitted: committed.subscribe,
};
