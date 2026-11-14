// 购物车（独立 tab）：商品展示、数量增减、删除、单价、合计、结算入库。
// 数据存在云端，两人共享；客户端的增删改全部走服务端函数（见 utils/shopping.js）。
const guard = require('../../utils/auth-guard');
const ingredientsApi = require('../../utils/ingredients');
const shopping = require('../../utils/shopping');
const { money } = require('../../utils/format');

Page({
    data: {
        authState: 'checking',
        cart: [],
        cartTotal: '0.00',
        cartBusy: false,
        error: '',
        draftName: '',
        draftPrice: '',
    },

    onShow() {
        this.load();
    },

    onPullDownRefresh() {
        this.load(true);
    },

    async load(fromPull) {
        const context = await guard.check(this);
        if (!context) {
            if (fromPull) wx.stopPullDownRefresh();
            return;
        }
        ingredientsApi.setScope(context.space.id, context.meId, context.meName);
        shopping.setScope(context.space.id, context.meName);

        const result = await shopping.list();
        if (fromPull) wx.stopPullDownRefresh();
        if (result.error) {
            this.setData({ error: guard.errorText(result.error) });
            this.applyCart([]);
            return;
        }
        this.setData({ error: '' });
        this.applyCart(result.items || []);
    },

    applyCart(items) {
        const summary = shopping.summarize(items);
        const cart = items.map((item) => ({
            id: item.id,
            name: item.name,
            quantity: item.quantity,
            quantityText: String(item.quantity),
            priceText: item.price ? item.price.toFixed(2) : '',
            unit: item.unit,
            subtotal: money(item.price * item.quantity),
        }));
        this.setData({ cart: cart, cartTotal: summary.text });
    },

    onDraftNameInput(event) {
        this.setData({ draftName: event.detail.value });
    },

    onDraftPriceInput(event) {
        this.setData({ draftPrice: event.detail.value });
    },

    async onAdd() {
        const name = String(this.data.draftName || '').trim();
        if (name === '') {
            wx.showToast({ title: '填一下要买什么', icon: 'none' });
            return;
        }
        const price = Number(this.data.draftPrice) || 0;
        const result = await shopping.add({ name: name, quantity: 1, unit: '', price: price });
        if (result.error) {
            wx.showToast({ title: result.error.message || '加入失败', icon: 'none' });
            return;
        }
        this.setData({ draftName: '', draftPrice: '' });
        this.load();
    },

    async onStep(event) {
        const id = event.currentTarget.dataset.id;
        const delta = Number(event.currentTarget.dataset.delta) || 0;
        let row = null;
        (this.data.cart || []).forEach((item) => {
            if (item.id === id) row = item;
        });
        if (!row) return;
        const next = Math.max(1, Number(row.quantity) + delta);
        if (next === Number(row.quantity)) return;
        const result = await shopping.update(id, { quantity: next });
        if (result.error) {
            wx.showToast({ title: result.error.message || '改不了', icon: 'none' });
            return;
        }
        this.load();
    },

    // 单价边打字边写库会浪费请求，改成失焦时提交。
    onPriceInput(event) {
        const index = Number(event.currentTarget.dataset.index);
        const cart = this.data.cart.slice();
        if (!cart[index]) return;
        cart[index] = Object.assign({}, cart[index], { priceText: event.detail.value });
        this.setData({ cart: cart });
    },

    async onPriceBlur(event) {
        const index = Number(event.currentTarget.dataset.index);
        const row = (this.data.cart || [])[index];
        if (!row) return;
        const price = Number(row.priceText) || 0;
        const result = await shopping.update(row.id, { price: price });
        if (result.error) return;
        this.load();
    },

    async onRemove(event) {
        const result = await shopping.remove(event.currentTarget.dataset.id);
        if (result.error) {
            wx.showToast({ title: result.error.message || '删不掉', icon: 'none' });
            return;
        }
        this.load();
    },

    onClear() {
        if (this.data.cart.length === 0) return;
        wx.showModal({
            title: '清空购物车？',
            content: '里面的 ' + this.data.cart.length + ' 样东西会被删掉。',
            confirmText: '清空',
            confirmColor: '#C0392B',
            success: async (res) => {
                if (!res.confirm) return;
                await shopping.clear();
                this.load();
            },
        });
    },

    // 与冰箱联动：买回来了就批量写进冰箱，然后清空购物车。
    onCheckout() {
        if (this.data.cartBusy || this.data.cart.length === 0) return;
        wx.showModal({
            title: '买回来了？',
            content: '把购物车里的 ' + this.data.cart.length + ' 样加进冰箱，然后清空购物车。',
            confirmText: '加进冰箱',
            success: async (res) => {
                if (!res.confirm) return;
                this.setData({ cartBusy: true });
                const rows = this.data.cart.map((item) => ({
                    name: item.name,
                    quantity: String(item.quantity),
                    unit: item.unit,
                    category: '其他',
                }));
                const created = await ingredientsApi.createMany(rows);
                if (created.error) {
                    this.setData({ cartBusy: false });
                    wx.showToast({ title: guard.errorText(created.error), icon: 'none' });
                    return;
                }
                await shopping.clear();
                this.setData({ cartBusy: false });
                wx.showToast({ title: '加进来 ' + created.count + ' 样', icon: 'success' });
                this.load();
            },
        });
    },

    onGoFridge() {
        wx.switchTab({ url: '/pages/fridge/fridge' });
    },
});
