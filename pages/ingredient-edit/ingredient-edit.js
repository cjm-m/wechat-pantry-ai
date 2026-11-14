// 新增 / 编辑食材，同一个页面用 ?id= 区分。删除放在编辑页里，避免列表误触。
const guard = require('../../utils/auth-guard');
const ingredientsApi = require('../../utils/ingredients');
const shopping = require('../../utils/shopping');
const { CATEGORY_KEYS, UNITS, todayStr } = require('../../utils/format');

Page({
    data: {
        authState: 'checking',
        loading: false,
        recordId: '',
        pageTitle: '添加食材',
        name: '',
        categoryIndex: 0,
        category: CATEGORY_KEYS[0],
        categories: CATEGORY_KEYS,
        quantity: '',
        unit: '',
        units: UNITS,
        note: '',
        storage: '冷藏',
        expireAt: '',
        today: todayStr(),
        saving: false,
        deleting: false,
        error: '',
    },

    onLoad(query) {
        const id = query && query.id ? String(query.id) : '';
        this.setData({
            recordId: id,
            pageTitle: id ? '编辑食材' : '添加食材',
        });
        wx.setNavigationBarTitle({ title: id ? '编辑食材' : '添加食材' });
        this.init(id);
    },

    async init(id) {
        const context = await guard.check(this);
        if (!context) return;
        this.spaceId = context.space.id;
        this.meName = context.meName;
        ingredientsApi.setScope(context.space.id, context.meId, context.meName);
        shopping.setScope(context.space.id, context.meName);
        if (!id) {
            this.setData({ authState: 'ready' });
            return;
        }
        this.setData({ loading: true });
        const result = await ingredientsApi.get(id);
        if (result.error || !result.item) {
            this.setData({
                loading: false,
                authState: 'ready',
                error: result.error ? guard.errorText(result.error) : '这条食材已经不在了',
            });
            return;
        }
        const item = result.item;
        const index = CATEGORY_KEYS.indexOf(item.category);
        this.setData({
            loading: false,
            authState: 'ready',
            name: item.name,
            category: item.category,
            categoryIndex: index < 0 ? CATEGORY_KEYS.length - 1 : index,
            quantity: item.quantity,
            unit: item.unit,
            note: item.note,
            storage: item.storage,
            expireAt: item.expireAt,
        });
    },

    onNameInput(event) {
        this.setData({ name: event.detail.value, error: '' });
    },

    onCategoryChange(event) {
        const index = Number(event.detail.value) || 0;
        this.setData({
            categoryIndex: index,
            category: this.data.categories[index],
        });
    },

    onQuantityInput(event) {
        this.setData({ quantity: event.detail.value });
    },

    onUnitInput(event) {
        this.setData({ unit: event.detail.value });
    },

    onPickUnit(event) {
        this.setData({ unit: event.currentTarget.dataset.unit });
    },

    onNoteInput(event) {
        this.setData({ note: event.detail.value });
    },

    onExpireChange(event) {
        this.setData({ expireAt: event.detail.value });
    },

    onStoragePick(event) {
        this.setData({ storage: event.currentTarget.dataset.storage });
    },

    onExpireClear() {
        this.setData({ expireAt: '' });
    },

    // 联动的另一半：把冰箱里这样东西加进购物车，提醒自己去补货。
    async onAddToCart() {
        const name = String(this.data.name || '').trim();
        if (name === '') {
            this.setData({ error: '先填食材名字' });
            return;
        }
        const qty = Number(String(this.data.quantity || '').trim());
        const result = await shopping.add({
            name: name,
            quantity: isFinite(qty) && qty > 0 ? qty : 1,
            unit: String(this.data.unit || '').trim(),
            price: 0,
        });
        if (result.error) {
            this.setData({ error: guard.errorText(result.error) });
            return;
        }
        wx.showToast({ title: '已加入购物车', icon: 'none' });
    },

    async onSave() {
        if (this.data.saving) return;
        const name = String(this.data.name || '').trim();
        if (name === '') {
            this.setData({ error: '先填食材名字' });
            return;
        }
        this.setData({ saving: true, error: '' });

        const payload = {
            name: name,
            category: this.data.category,
            quantity: String(this.data.quantity || '').trim(),
            unit: String(this.data.unit || '').trim(),
            note: String(this.data.note || '').trim(),
            storage: this.data.storage,
            expireAt: this.data.expireAt || null,
        };
        const result = this.data.recordId
            ? await ingredientsApi.update(this.data.recordId, payload)
            : await ingredientsApi.create(payload);

        if (result.error) {
            this.setData({ saving: false, error: guard.errorText(result.error) });
            return;
        }
        this.setData({ saving: false });
        wx.navigateBack();
    },

    onDelete() {
        if (this.data.deleting) return;
        wx.showModal({
            title: '删掉这样食材？',
            content: '删掉之后两个人的冰箱里都不再显示它。',
            confirmText: '删掉',
            confirmColor: '#C0392B',
            success: async (res) => {
                if (!res.confirm) return;
                this.setData({ deleting: true });
                const result = await ingredientsApi.remove(this.data.recordId);
                if (result.error) {
                    this.setData({ deleting: false, error: guard.errorText(result.error) });
                    return;
                }
                this.setData({ deleting: false });
                wx.navigateBack();
            },
        });
    },
});
