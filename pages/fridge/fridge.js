// 冰箱：按「冷藏区 / 冷冻区」两个板块展示，板块内再按类别分组。
// 支持一键让 AI 给「没有保质期」的食材补日期——已有保质期的一律不动。
const guard = require('../../utils/auth-guard');
const ingredientsApi = require('../../utils/ingredients');
const recipesApi = require('../../utils/recipes');
const selection = require('../../utils/selection');
const shelf = require('../../utils/shelf');
const swipeBus = require('../../utils/swipe-bus');
const { ownerText, categoryIcon } = require('../../utils/format');

Page({
    data: {
        authState: 'checking',
        spaceName: '',
        areas: [],
        total: 0,
        selectedCount: 0,
        missingCount: 0,
        filling: false,
        loading: true,
        error: '',
        myId: '',
        // 正在删除的那一条：删除期间禁用它自己的按钮，避免重复提交。
        deletingId: '',
        // 左滑露出的按钮组：顺序即从左到右，「编辑」排在「删除」左侧。
        rowActions: [
            { key: 'edit', text: '编辑', tone: 'quiet' },
            { key: 'delete', text: '删除', tone: 'danger' },
        ],
    },

    onShow() {
        // 只重置「草稿」：切 tab 回来、冷启动回来都清空上次的勾选，避免残留。
        // 已提交给配菜页的那份不受影响，从配菜页返回不会把它的食材抹掉。
        // 从本页的子页面（新增 / 编辑 / 拍照）返回属于同一次连续操作，保留勾选。
        const keep = this.keepSelection === true;
        this.keepSelection = false;
        if (!keep) selection.clearDraft();
        this.load();
    },

    onUnload() {
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = null;
        }
    },

    onPullDownRefresh() {
        this.load(true);
    },

    // 页面滚动：滑开的行要跟着复位。用与展开时刻的滚动距离做比较，
    // 避免横向滑动时那 1~2px 的连带滚动把用户正在拖的行关掉。
    onPageScroll(event) {
        this.lastScrollTop = event.scrollTop;
        if (!this.rowOpen) return;
        if (Math.abs(event.scrollTop - (this.rowScrollTop || 0)) < 8) return;
        this.closeOpenRows();
    },

    async load(fromPull) {
        const context = await guard.check(this);
        if (!context) {
            if (fromPull) wx.stopPullDownRefresh();
            return;
        }

        ingredientsApi.setScope(context.space.id, context.meId, context.meName);
        recipesApi.setScope(context.space.id, context.meName);
        this.setData({
            spaceName: context.space.name || '我们的小家',
            myId: context.meId,
        });

        if (!this.unsubscribe) {
            this.unsubscribe = selection.subscribeDraft(() => this.render());
        }

        const result = await ingredientsApi.list();
        if (fromPull) wx.stopPullDownRefresh();
        if (result.error) {
            this.setData({ loading: false, error: guard.errorText(result.error) });
            return;
        }
        this.items = result.items;
        selection.reconcileDraft(this.items);
        this.setData({ loading: false, error: '' });
        this.render();
    },

    render() {
        const myId = this.data.myId;
        const ids = selection.getDraft();
        const items = this.items || [];

        const areas = ingredientsApi.groupByArea(items).map((area) => ({
            key: area.key,
            icon: area.key === '冷冻' ? '❄️' : '🧊',
            count: area.count,
            groups: area.groups.map((group) => ({
                key: group.key,
                icon: categoryIcon(group.key),
                items: group.items.map((item) => ({
                    id: item.id,
                    name: item.name,
                    amount: item.amount,
                    note: item.note,
                    expire: item.expire,
                    hasExpire: !!item.expireAt,
                    checked: ids.indexOf(item.id) >= 0,
                    ownerLabel: ownerText(item.ownerId, myId),
                })),
            })),
        }));

        let missing = 0;
        items.forEach((item) => {
            if (!item.expireAt) missing += 1;
        });

        this.setData({
            areas: areas,
            total: items.length,
            selectedCount: ids.length,
            missingCount: missing,
        });
    },

    // 只把「没有保质期」的食材交给 AI，已有保质期的不会出现在请求里。
    onFillExpire() {
        if (this.data.filling) return;
        const missing = (this.items || []).filter((item) => !item.expireAt);
        if (missing.length === 0) {
            wx.showToast({ title: '都有保质期了', icon: 'none' });
            return;
        }

        wx.showModal({
            title: '让 AI 补保质期',
            content: '给 ' + missing.length + ' 样没有保质期的食材，按它所在的冷藏/冷冻区估一个日期。已有保质期的不动。',
            confirmText: '开始',
            success: async (res) => {
                if (!res.confirm) return;
                this.setData({ filling: true });
                try {
                    const result = await shelf.suggest(
                        missing.map((item) => ({
                            name: item.name,
                            category: item.category,
                            storage: item.storage,
                        }))
                    );

                    const byIndex = {};
                    result.suggestions.forEach((item) => {
                        byIndex[item.idx] = item;
                    });

                    let saved = 0;
                    for (let i = 0; i < missing.length; i += 1) {
                        const suggestion = byIndex[i];
                        if (!suggestion) continue;
                        const written = await ingredientsApi.setExpireAt(missing[i].id, suggestion.expireAt);
                        if (!written.error) saved += 1;
                    }

                    this.setData({ filling: false });
                    if (saved === 0) {
                        wx.showModal({
                            title: '没补上',
                            content: '模型没有给出可用的保质期，稍后再试一次。',
                            showCancel: false,
                        });
                        return;
                    }
                    wx.showToast({ title: '补上 ' + saved + ' 样', icon: 'success' });
                    this.load();
                } catch (error) {
                    this.setData({ filling: false });
                    wx.showModal({
                        title: '没补成',
                        content: shelf.friendly(error),
                        showCancel: false,
                    });
                }
            },
        });
    },

    // 整行点击 = 勾选/取消勾选；左侧圆点用 catchtap 单独处理，避免一次点击触发两遍。
    onToggle(event) {
        // 横滑刚结束时系统可能补发一次 tap，用一个很短的锁挡掉，避免滑动误改勾选。
        if (this.tapLockedUntil && Date.now() < this.tapLockedUntil) return;
        // 圆点用的是 catchtap，不会冒泡到页面根节点，这里补一次复位。
        if (this.rowOpen) this.closeOpenRows();
        selection.toggleDraft(event.currentTarget.dataset.id);
    },

    onRowSwipe() {
        this.tapLockedUntil = Date.now() + 300;
    },

    // 记住当前是否有行处于展开状态，供「点其它区域 / 页面滚动」时复位。
    onRowOpen() {
        this.rowOpen = true;
        this.rowScrollTop = this.lastScrollTop || 0;
    },

    onRowClose() {
        this.rowOpen = false;
    },

    onPageTap() {
        if (!this.rowOpen) return;
        this.closeOpenRows();
    },

    // 逐个收起：组件内部已保证同时只有一行展开，这里不关心是谁打开的。
    closeOpenRows() {
        swipeBus.closeAll();
        this.rowOpen = false;
    },

    openEditor(id) {
        if (!id) return;
        // 标记这次离开是本页发起的，返回时不清空勾选。
        this.keepSelection = true;
        wx.navigateTo({ url: '/pages/ingredient-edit/ingredient-edit?id=' + id });
    },

    // 左滑按钮组：编辑入口已从「点击整行」迁移到这里，删除仍走二次确认。
    onActionItem(event) {
        const id = String(event.currentTarget.dataset.id || '');
        const key = event.detail && event.detail.key;
        if (id === '') return;
        if (key === 'edit') {
            this.openEditor(id);
            return;
        }
        if (key === 'delete') {
            this.confirmDelete(id);
        }
    },

    // 删除前二次确认；confirmColor 与编辑页删除保持一致的语义色。
    confirmDelete(id) {
        if (this.data.deletingId) return;
        const item = this.findItem(id);
        if (!item) return;

        wx.showModal({
            title: '删掉「' + item.name + '」？',
            content: '删掉之后两个人的冰箱里都不再显示它。',
            confirmText: '删掉',
            confirmColor: '#C0392B',
            success: (res) => {
                if (!res.confirm) return;
                this.removeItem(id);
            },
        });
    },

    findItem(id) {
        let found = null;
        (this.items || []).forEach((item) => {
            if (String(item.id) === String(id)) found = item;
        });
        return found;
    },

    // 先本地移除让列表立刻收缩，落库失败再按原位置插回去，界面与数据始终一致。
    async removeItem(id) {
        if (this.data.deletingId) return;
        const index = (this.items || []).findIndex((item) => String(item.id) === String(id));
        if (index < 0) return;
        const item = this.items[index];

        this.setData({ deletingId: id });
        const rest = this.items.slice();
        rest.splice(index, 1);
        this.items = rest;
        selection.removeDraft(id);
        this.render();

        const result = await ingredientsApi.remove(id);
        this.setData({ deletingId: '' });

        if (result.error) {
            const restored = (this.items || []).slice();
            restored.splice(index, 0, item);
            this.items = restored;
            this.render();
            wx.showModal({
                title: '没删掉',
                content: guard.errorText(result.error),
                showCancel: false,
            });
            return;
        }
        wx.showToast({ title: '删掉了 ' + item.name, icon: 'none' });
    },

    onAdd() {
        this.keepSelection = true;
        wx.navigateTo({ url: '/pages/ingredient-edit/ingredient-edit' });
    },

    onGoScan() {
        this.keepSelection = true;
        wx.navigateTo({ url: '/pages/scan/scan' });
    },

    onGoCook() {
        // 只有点这里才把草稿提交给配菜页；没勾选就不提交，配菜页已有的食材不受影响。
        selection.commitDraft();
        wx.switchTab({ url: '/pages/cook/cook' });
    },

    onRetry() {
        this.setData({ loading: true, error: '' });
        this.load();
    },
});
