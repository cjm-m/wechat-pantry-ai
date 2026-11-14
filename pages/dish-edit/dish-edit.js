// 新建点菜：一个表单页。从收藏或配菜结果进来时带 ?recipeId=&title=，菜名预填。
const guard = require('../../utils/auth-guard');
const dishesApi = require('../../utils/dishes');
const recipesApi = require('../../utils/recipes');
const format = require('../../utils/format');

const SLOTS = dishesApi.SLOTS;

// 默认餐次跟着当前时间走，比固定「晚餐」少改一次。
function defaultSlotIndex() {
    const hour = new Date().getHours();
    if (hour < 10) return 0;
    if (hour < 15) return 1;
    return 2;
}

Page({
    data: {
        authState: 'checking',
        submitting: false,
        error: '',
        title: '',
        note: '',
        today: '',
        mealDate: '',
        dateLabel: '',
        slotIndex: 2,
        slotLabels: SLOTS.map((item) => item.label),
        recipeId: '',
        recipeTitle: '',
    },

    onLoad(query) {
        const today = format.todayStr();
        let title = '';
        if (query && query.title) {
            try {
                title = decodeURIComponent(query.title);
            } catch (error) {
                title = '';
            }
        }
        const recipeId = query && query.recipeId ? String(query.recipeId) : '';
        const slotIndex = defaultSlotIndex();

        this.setData({
            today: today,
            mealDate: today,
            dateLabel: format.dayLabel(today),
            title: title,
            recipeId: recipeId,
            recipeTitle: recipeId ? title : '',
            slotIndex: slotIndex,
        });
        this.checkLogin();
    },

    async checkLogin() {
        const context = await guard.check(this);
        if (!context) return;
        this.context = context;
    },

    onTitleInput(event) {
        this.setData({ title: event.detail.value });
    },

    onNoteInput(event) {
        this.setData({ note: event.detail.value });
    },

    onDateChange(event) {
        const value = event.detail.value;
        this.setData({ mealDate: value, dateLabel: format.dayLabel(value) });
    },

    onSlotChange(event) {
        this.setData({ slotIndex: Number(event.detail.value) || 0 });
    },

    onPickRecipe() {
        if (this.picking) return;
        this.picking = true;
        wx.showLoading({ title: '读收藏…', mask: true });
        this.pickRecipe().then(() => {
            this.picking = false;
            wx.hideLoading();
        });
    },

    async pickRecipe() {
        const context = this.context || (await guard.check(this));
        if (!context) return;
        recipesApi.setScope(context.space.id, context.meName);

        const result = await recipesApi.list();
        const items = (result.items || []).slice(0, 6);
        if (result.error || items.length === 0) {
            wx.showToast({ title: '收藏里还没有菜谱', icon: 'none' });
            return;
        }
        wx.showActionSheet({
            itemList: items.map((item) => String(item.title || '未命名').slice(0, 18)),
            success: (res) => {
                const picked = items[res.tapIndex];
                if (!picked) return;
                const current = String(this.data.title || '').trim();
                this.setData({
                    recipeId: String(picked.id),
                    recipeTitle: picked.title,
                    title: current === '' ? picked.title : current,
                });
            },
            fail: () => {},
        });
    },

    async onSubmit() {
        if (this.data.submitting) return;
        const title = String(this.data.title || '').trim();
        if (title === '') {
            wx.showToast({ title: '先写想吃什么', icon: 'none' });
            return;
        }

        this.setData({ submitting: true, error: '' });
        const result = await dishesApi.create({
            title: title,
            mealDate: this.data.mealDate,
            mealSlot: SLOTS[this.data.slotIndex] ? SLOTS[this.data.slotIndex].key : 'dinner',
            note: this.data.note,
            recipeId: this.data.recipeId,
        });
        if (result.error) {
            this.setData({ submitting: false, error: guard.errorText(result.error) });
            wx.showToast({ title: guard.errorText(result.error), icon: 'none' });
            return;
        }
        this.setData({ submitting: false });

        if (result.item) {
            // 用 redirectTo 把表单页从栈里换掉：从配菜页进来时上层是 tab，
            // navigateBack 会回到配菜页而不是刚点的那道菜。
            wx.redirectTo({ url: '/pages/dish-detail/dish-detail?id=' + result.item.id });
            return;
        }
        wx.navigateBack();
    },
});
