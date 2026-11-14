// 这周吃什么（N9）。周视图 + 加菜弹层 + 缺料清单 + 做完打卡。
//
// 数据层：utils/meal-plan.js（9 个 RPC 的封装）。
//
// 三条纪律，与项目其它页面一致：
//   1. 不做本地乐观更新 —— 做完动作一律重拉，否则对方在旁边改了我这边还是旧的
//   2. 错误统一走 guard.errorText
//   3. 页面入口第一件事 guard.check

const guard = require('../../utils/auth-guard');
const mealPlan = require('../../utils/meal-plan');
const recommend = require('../../utils/meal-plan-recommend');
const recipesApi = require('../../utils/recipes');
const ingredientsApi = require('../../utils/ingredients');
const cooking = require('../../utils/cooking');
const dishRecipe = require('../../utils/dish-recipe');
const shopping = require('../../utils/shopping');
const pantry = require('../../utils/pantry-match');

const SLOT_LABELS = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐' };

Page({
    data: {
        authState: 'checking',
        loading: true,
        error: '',

        // 周导航
        weekOffset: 0,          // 0 = 本周，1 = 下周
        weekStart: '',          // YYYY-MM-DD
        weekLabel: '',

        plan: null,
        days: [],               // buildGrid 的 7×3 结构（逻辑用）
        gridRows: [],           // buildRows 的「一行一餐」矩阵（渲染用）
        itemCount: 0,
        cookedCount: 0,

        // 缺料
        shortageMiss: [],
        shortageMaybe: [],
        shortageHave: 0,
        shortageOpen: false,

        // 加菜弹层
        pickerOpen: false,
        pickerDay: 0,
        pickerSlot: '',
        pickerTab: 'favorite',  // favorite | ai | manual
        pickerTitle: '',
        favoriteList: [],
        aiDishes: [],
        aiBusy: false,
        aiError: '',
        manualTitle: '',
        manualBusy: false,
        manualError: '',
        saving: false,

        // 做完确认弹层
        cookOpen: false,
        cookItem: null,
        cookRows: [],           // [{ingredientId, name, action}]
        cooking: false,

        // 其它
        busyId: '',
        confirming: false,
    },

    onLoad(query) {
        // 支持从首页/其它页带 ?week=1 直接进下周
        const week = Number(query && query.week);
        this.setData({ weekOffset: isFinite(week) && week > 0 ? Math.floor(week) : 0 });
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
        recipesApi.setScope(context.space.id, context.meName);
        shopping.setScope(context.space.id, context.meName);
        mealPlan.setScope(context.space.id, context.meName);

        // 目标周的周一
        const monday = mealPlan.addDays(mealPlan.toMonday(new Date()), this.data.weekOffset * 7);
        const weekStart = mealPlan.ymd(monday);

        const ensured = await mealPlan.ensureWeek(weekStart);
        if (fromPull) wx.stopPullDownRefresh();
        if (ensured.error) {
            this.setData({ loading: false, error: guard.errorText(ensured.error) });
            return;
        }
        if (!ensured.plan) {
            this.setData({ loading: false, error: '没拿到这周的菜单' });
            return;
        }

        const detail = await mealPlan.get(ensured.plan.id);
        if (detail.error) {
            this.setData({ loading: false, error: guard.errorText(detail.error) });
            return;
        }

        this.applyPlan(detail.plan, detail.items, monday, weekStart);
    },

    applyPlan(plan, items, monday, weekStart) {
        const grouped = mealPlan.groupShortage(plan.shortage);
        const cooked = items.filter((item) => item.status === 'cooked').length;
        const grid = mealPlan.buildGrid(items, monday);

        this.setData({
            loading: false,
            error: '',
            plan: plan,
            weekStart: weekStart,
            weekLabel: mealPlan.weekLabel(monday),
            days: grid,
            gridRows: mealPlan.buildRows(grid),
            itemCount: items.length,
            cookedCount: cooked,
            shortageMiss: grouped.miss,
            shortageMaybe: grouped.maybe,
            shortageHave: grouped.have.length,
        });
    },

    // 重拉当前周（动作之后统一走这里，不做本地乐观更新）
    async reload() {
        if (!this.data.weekStart) return;
        const ensured = await mealPlan.ensureWeek(this.data.weekStart);
        if (ensured.error || !ensured.plan) {
            this.setData({ error: guard.errorText(ensured.error) });
            return;
        }
        const detail = await mealPlan.get(ensured.plan.id);
        if (detail.error) {
            this.setData({ error: guard.errorText(detail.error) });
            return;
        }
        const monday = mealPlan.toMonday(new Date(this.data.weekStart + 'T00:00:00'));
        this.applyPlan(detail.plan, detail.items, monday, this.data.weekStart);
    },

    // ── 周切换 ────────────────────────────────────────────────────────────
    onPrevWeek() {
        if (this.data.weekOffset <= 0) return;
        this.setData({ weekOffset: this.data.weekOffset - 1, loading: true }, () => this.load());
    },

    onNextWeek() {
        if (this.data.weekOffset >= 3) return;  // 最多往后看三周，再远没意义
        this.setData({ weekOffset: this.data.weekOffset + 1, loading: true }, () => this.load());
    },

    onThisWeek() {
        if (this.data.weekOffset === 0) return;
        this.setData({ weekOffset: 0, loading: true }, () => this.load());
    },

    // ── 打开加菜弹层 ──────────────────────────────────────────────────────
    async onPickCell(event) {
        const ds = event.currentTarget.dataset;
        const day = Number(ds.day);
        const slot = ds.slot;
        if (!isFinite(day) || !slot) return;

        this.setData({
            pickerOpen: true,
            pickerDay: day,
            pickerSlot: slot,
            pickerTab: 'favorite',
            pickerTitle: '周' + (day + 1) + ' · ' + (SLOT_LABELS[slot] || ''),
            aiDishes: [],
            aiError: '',
            manualTitle: '',
            manualError: '',
        });

        await this.loadFavorites();
    },

    async loadFavorites() {
        const result = await recipesApi.list();
        if (result.error) {
            this.setData({ favoriteList: [], aiError: guard.errorText(result.error) });
            return;
        }

        // 已排进本周的菜名，用来算多样性
        const planned = [];
        (this.data.days || []).forEach((day) => {
            day.meals.forEach((meal) => {
                if (meal.item && meal.item.title) {
                    planned.push({ title: meal.item.title, used: meal.item.used });
                }
            });
        });

        const inv = await ingredientsApi.list();
        const inventory = (inv.items || []).map((item) => ({
            name: item.name,
            expireAt: item.expireAt,
        }));

        const ranked = recommend.scoreDishes({
            candidates: (result.items || []).map((item) => ({
                title: item.title,
                used: item.used,
                source: item,
            })),
            inventory: inventory,
            planned: planned,
            prefs: {},
        });

        this.setData({
            favoriteList: ranked.map((row) => ({
                id: row.candidate.source.id,
                title: row.candidate.title,
                reason: row.reason,
                score: row.score,
                used: row.candidate.used,
            })),
        });
    },

    onSwitchTab(event) {
        this.setData({ pickerTab: event.currentTarget.dataset.tab });
    },

    // 从收藏里挑一道：直接用它自带的食材快照
    async onPickFavorite(event) {
        const id = event.currentTarget.dataset.id;
        const row = (this.data.favoriteList || []).filter((item) => String(item.id) === String(id))[0];
        if (!row || this.data.saving) return;
        await this.addToCell(row.title, row.used, row.id);
    },

    // AI 推荐：照着冰箱现有食材生成几道
    async onGenerateAi() {
        if (this.data.aiBusy) return;
        this.setData({ aiBusy: true, aiError: '', aiDishes: [] });

        try {
            const inv = await ingredientsApi.list();
            const items = (inv.items || []).filter((item) => item.name).slice(0, 20);
            if (items.length === 0) {
                this.setData({ aiBusy: false, aiError: '冰箱里还没有食材，先去添加几样' });
                return;
            }
            const result = await cooking.generate({
                ingredients: items,
                count: 3,
            });
            if (!result.dishes || result.dishes.length === 0) {
                this.setData({ aiBusy: false, aiError: '这次没生成出菜，再试一次' });
                return;
            }
            this.setData({
                aiBusy: false,
                aiDishes: result.dishes.map((dish, index) => ({
                    key: 'ai-' + index,
                    title: dish.title,
                    summary: dish.summary,
                    used: dish.used,
                    steps: dish.steps,
                    nutrition: dish.nutrition || null,
                })),
            });
        } catch (error) {
            this.setData({ aiBusy: false, aiError: cooking.friendlyMessage(error) });
        }
    },

    // AI 推荐的菜原来直接进计划、不带 recipeId，结果点开这道菜看不到做法，
    // 营养也追不到（打卡时要靠 meal_plan_item.recipe_id 找回快照）。
    // 现在先落一条 recipe_favorite 再排菜；落库失败也不拦着排菜，
    // 用户要的是「排上」，菜谱只是附加信息。
    async onPickAi(event) {
        const index = Number(event.currentTarget.dataset.index);
        const row = (this.data.aiDishes || [])[index];
        if (!row || this.data.saving) return;

        let recipeId = null;
        if (Array.isArray(row.steps) && row.steps.length > 0) {
            const saved = await recipesApi.save({
                title: row.title,
                summary: row.summary,
                used: row.used,
                steps: row.steps,
                nutrition: row.nutrition || null,
            });
            if (saved.item && saved.item.id) recipeId = String(saved.item.id);
        }
        await this.addToCell(row.title, row.used, recipeId);
    },

    // 手输菜名：先用名字写进去，食材留空，后面可以补
    onManualInput(event) {
        this.setData({ manualTitle: event.detail.value });
    },

    async onManualAdd() {
        const title = String(this.data.manualTitle || '').trim();
        if (title === '' || this.data.manualBusy) return;
        await this.addToCell(title, [], null);
        this.setData({ manualTitle: '' });
    },

    // 手输之后让 AI 补食材（单独一个按钮：不是每道菜都值得烧一次额度）
    async onManualFillIngredients() {
        const title = String(this.data.manualTitle || '').trim();
        if (title === '' || this.data.manualBusy) {
            if (title === '') this.setData({ manualError: '先写菜名' });
            return;
        }
        this.setData({ manualBusy: true, manualError: '' });
        try {
            const result = await dishRecipe.generate(title);
            await this.addToCell(title, result.used || [], null);
            this.setData({ manualTitle: '' });
        } catch (error) {
            this.setData({
                manualBusy: false,
                manualError: dishRecipe.friendly(error),
            });
        }
    },

    async addToCell(title, used, recipeId) {
        if (!this.data.plan || this.data.saving) return;
        this.setData({ saving: true });

        const result = await mealPlan.addItem({
            planId: this.data.plan.id,
            dayOffset: this.data.pickerDay,
            slot: this.data.pickerSlot,
            title: title,
            used: used,
            recipeId: recipeId,
        });

        this.setData({ saving: false });
        if (result.error) {
            wx.showToast({ title: guard.errorText(result.error), icon: 'none' });
            return;
        }
        this.setData({ pickerOpen: false });
        wx.showToast({ title: '排上了', icon: 'success' });
        this.reload();
    },

    onClosePicker() {
        this.setData({ pickerOpen: false });
    },

    // ── 点已排的菜：改名/删除/做好了 ──────────────────────────────────────
    onTapItem(event) {
        const id = event.currentTarget.dataset.id;
        for (let d = 0; d < this.data.days.length; d += 1) {
            const meals = this.data.days[d].meals;
            for (let m = 0; m < meals.length; m += 1) {
                if (meals[m].item && String(meals[m].item.id) === String(id)) {
                    this.openCookSheet(meals[m].item);
                    return;
                }
            }
        }
    },

    // ── 做完确认 ──────────────────────────────────────────────────────────
    async openCookSheet(item) {
        // 这一格的食材 → 冰箱里对应的那几行，让用户勾「用完了没有」
        const inv = await ingredientsApi.list();
        const stock = inv.items || [];

        const rows = [];
        (item.used || []).forEach((unit) => {
            if (unit.fromFridge === false) return;   // 调料不进清单
            const matched = pantry.levelOf(unit.name, stock.map((row) => row.name));
            let ingredientId = '';
            if (matched.level === 'have' && matched.hit) {
                const hit = stock.filter((row) => row.name === matched.hit)[0];
                if (hit) ingredientId = hit.id;
            }
            rows.push({
                name: unit.name,
                amount: unit.amount,
                ingredientId: ingredientId,
                action: ingredientId ? 'removed' : 'kept',   // 默认全勾「用完」
                checkable: !!ingredientId,
            });
        });

        this.setData({ cookOpen: true, cookItem: item, cookRows: rows });
    },

    onToggleCookRow(event) {
        const index = Number(event.currentTarget.dataset.index);
        const rows = this.data.cookRows.slice();
        if (!rows[index] || !rows[index].checkable) return;
        rows[index].action = rows[index].action === 'removed' ? 'kept' : 'removed';
        this.setData({ cookRows: rows });
    },

    onCloseCook() {
        if (this.data.cooking) return;
        this.setData({ cookOpen: false, cookItem: null, cookRows: [] });
    },

    async onConfirmCook() {
        const item = this.data.cookItem;
        if (!item || this.data.cooking) return;
        this.setData({ cooking: true });

        const consume = (this.data.cookRows || [])
            .filter((row) => row.ingredientId)
            .map((row) => ({ ingredientId: row.ingredientId, action: row.action }));

        const result = await mealPlan.cookItem({ itemId: item.id, consume: consume });

        this.setData({ cooking: false });
        if (result.error) {
            wx.showToast({ title: guard.errorText(result.error), icon: 'none' });
            return;
        }
        this.setData({ cookOpen: false, cookItem: null, cookRows: [] });
        const removed = (result.result && result.result.removed) || [];
        wx.showToast({
            title: removed.length > 0 ? '做好了，冰箱少了 ' + removed.length + ' 样' : '做好了',
            icon: 'success',
        });
        this.reload();
    },

    // 删掉一个格子（只能删还没做的）
    async onRemoveItem() {
        const item = this.data.cookItem;
        if (!item) return;
        const confirmed = await new Promise((resolve) => {
            wx.showModal({
                title: '删掉这道菜？',
                content: '「' + item.title + '」会从这周的菜单里移除。',
                confirmText: '删掉',
                confirmColor: '#C0392B',
                success: (res) => resolve(res.confirm),
                fail: () => resolve(false),
            });
        });
        if (!confirmed) return;

        const result = await mealPlan.removeItem(item.id);
        if (result.error) {
            wx.showToast({ title: guard.errorText(result.error), icon: 'none' });
            return;
        }
        this.setData({ cookOpen: false, cookItem: null, cookRows: [] });
        this.reload();
    },

    // ── 确认菜单 / 缺料 ───────────────────────────────────────────────────
    async onConfirmPlan() {
        if (!this.data.plan || this.data.confirming) return;
        if (this.data.itemCount === 0) {
            wx.showToast({ title: '先排几道菜', icon: 'none' });
            return;
        }
        this.setData({ confirming: true });
        const result = await mealPlan.confirm(this.data.plan.id);
        this.setData({ confirming: false });
        if (result.error) {
            wx.showToast({ title: guard.errorText(result.error), icon: 'none' });
            return;
        }
        wx.showToast({ title: '这周就吃这些', icon: 'success' });
        this.reload();
    },

    async onRefreshShortage() {
        if (!this.data.plan) return;
        const result = await mealPlan.refreshShortage(this.data.plan.id);
        if (result.error) {
            wx.showToast({ title: guard.errorText(result.error), icon: 'none' });
            return;
        }
        wx.showToast({ title: '缺料已刷新', icon: 'success' });
        this.reload();
    },

    onToggleShortage() {
        this.setData({ shortageOpen: !this.data.shortageOpen });
    },

    // 一键把缺料加进购物车（复用现有 cart_add，不新建购物链路）
    async onAddMissingToCart() {
        const misses = (this.data.shortageMiss || []).map((row) => row.name);
        if (misses.length === 0) {
            wx.showToast({ title: '没有要买的', icon: 'none' });
            return;
        }

        const existing = await shopping.list();
        const inCart = {};
        (existing.items || []).forEach((row) => {
            inCart[pantry.normalizeName(row.name)] = true;
        });

        let added = 0;
        let failed = 0;
        for (let i = 0; i < misses.length; i += 1) {
            const key = pantry.normalizeName(misses[i]);
            if (inCart[key]) continue;
            const result = await shopping.add({ name: misses[i], quantity: 1, unit: '', price: 0 });
            if (result.error) failed += 1;
            else {
                inCart[key] = true;
                added += 1;
            }
        }

        let message = added > 0 ? '加进购物车 ' + added + ' 样' : '购物车里已经有了';
        if (failed > 0) message += '，' + failed + ' 样没加上';
        wx.showToast({ title: message, icon: 'none' });
    },

    // 阻止弹层内的点击穿透到遮罩
    noop() {
        // 故意留空：WXML 里用 catchtap="noop" 挂在弹层容器上
    },
});
