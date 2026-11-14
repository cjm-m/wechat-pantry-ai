// 点菜详情：状态、缺料、做法。
//
// 缺料是点菜唯一真正跨模块的价值，所以这里有一条完整的解析流水线：
//   本单快照 → 收藏同名菜 → 同小家同名缓存 → 模型按菜名生成
// 四个来源按「可信度与成本」排序：快照零成本、收藏是人确认过的、缓存是历史估算、模型最贵最慢。
// 库存永远现读，绝不存在快照里 —— 否则清单会和冰箱实际情况漂移。
const guard = require('../../utils/auth-guard');
const dishesApi = require('../../utils/dishes');
const recipesApi = require('../../utils/recipes');
const ingredientsApi = require('../../utils/ingredients');
const shopping = require('../../utils/shopping');
const pantry = require('../../utils/pantry-match');
const dishRecipe = require('../../utils/dish-recipe');
const modelConfig = require('../../utils/model-config');
const format = require('../../utils/format');
const mealPlan = require('../../utils/meal-plan');

// 底部主按钮：有动作就发动作，没有动作就只说明现在轮到谁。
function barOf(item) {
    if (item.canClaim) return { label: '我来做', action: 'claim' };
    if (item.canFinish) return { label: '做好了', action: 'finish' };
    if (item.status === 'wanted') return { label: '等 TA 接单', action: '' };
    if (item.status === 'accepted') return { label: 'TA 正在做', action: '' };
    if (item.status === 'done') return { label: '这道菜做完了', action: '' };
    return { label: '已取消', action: '' };
}

// 清单来源要说清楚：收藏是人写的，模型是估的，用户有权知道该不该核对。
function noteOf(source, at) {
    const base = source === 'favorite' ? '清单来自收藏的菜谱' : '清单是 AI 按菜名估的，顺手核对一下';
    const day = at ? format.dayLabel(String(at).slice(0, 10)) : '';
    return day ? base + '（' + day + '记的）' : base;
}

Page({
    data: {
        authState: 'checking',
        loading: true,
        error: '',
        item: null,
        barLabel: '',
        barAction: '',
        // 缺料状态机：idle → checking → (generating) → ready / empty / failed
        recipePhase: 'idle',
        recipeSource: '',
        recipeNote: '',
        needRows: [],
        missCount: 0,
        maybeCount: 0,
        maybeText: '',
        stockFailed: false,
        genElapsed: 0,
        genChars: 0,
        recipeErrorText: '',
        canRetry: false,
        steps: [],
        stepsTitle: '',
        recipeGone: false,
        actionBusy: '',
        cartBusy: false,
        cartMessage: '',
        // N9：做完之后的消耗确认（点菜链路与周计划共用一个弹层形状）
        cookOpen: false,
        cookRows: [],
        cooking: false,
    },

    onLoad(query) {
        this.dishId = query && query.id ? String(query.id) : '';
    },

    onShow() {
        this.load();
    },

    onPullDownRefresh() {
        this.load(true);
    },

    onUnload() {
        // 离开页面就放弃这次生成，别让请求在后台白烧额度；切 tab 不算离开（onHide 不动）。
        this.stopTimer();
        dishRecipe.cancel();
    },

    async load(fromPull) {
        const context = await guard.check(this);
        if (!context) {
            if (fromPull) wx.stopPullDownRefresh();
            return;
        }
        this.context = context;
        dishesApi.setScope(context.space.id, context.meId, context.meName);

        if (!this.dishId) {
            if (fromPull) wx.stopPullDownRefresh();
            this.setData({ loading: false, error: '没有找到这道菜' });
            return;
        }

        const got = await dishesApi.get(this.dishId);
        if (fromPull) wx.stopPullDownRefresh();
        if (got.error || !got.item) {
            this.setData({
                loading: false,
                error: got.error ? guard.errorText(got.error) : '这道菜已经不在了',
            });
            return;
        }

        const item = got.item;
        const bar = barOf(item);
        this.setData({
            loading: false,
            error: '',
            item: item,
            barLabel: bar.label,
            barAction: bar.action,
        });

        this.loadSteps(item);
        if (this.data.recipePhase !== 'generating') await this.resolveRecipe(item);
    },

    // 做法与缺料解耦：拿不到做法不影响算缺料。
    async loadSteps(item) {
        if (!item.recipeId) {
            this.setData({ steps: [], stepsTitle: '', recipeGone: false });
            return;
        }
        const context = this.context;
        recipesApi.setScope(context.space.id, context.meName);
        const got = await recipesApi.get(item.recipeId);
        if (got.error || !got.item) {
            this.setData({ steps: [], stepsTitle: '', recipeGone: true });
            return;
        }
        this.setData({
            steps: got.item.steps || [],
            stepsTitle: got.item.title || '',
            recipeGone: false,
        });
    },

    // 解析流水线：快照 → 收藏 → 同名缓存 → 模型
    async resolveRecipe(item) {
        if (this.data.recipePhase === 'generating') return;

        // 1. 本单已有快照：直接比对，零查询零额度
        if (item.used && item.used.length > 0) {
            await this.applyIngredients(item.used, item.recipeSource, item.recipeAt);
            return;
        }

        const key = dishRecipe.titleKey(item.title);
        if (key === '') {
            this.setData({
                recipePhase: 'empty',
                recipeErrorText: '菜名太短，说不清要什么。点备注补一句，或者从收藏里选一道。',
                canRetry: false,
            });
            return;
        }

        this.setData({ recipePhase: 'checking', recipeErrorText: '', canRetry: false });

        // 2. 收藏里有同名菜：人确认过的清单最可信，也最省钱
        const context = this.context;
        recipesApi.setScope(context.space.id, context.meName);
        const favorites = await recipesApi.list();
        const hit = dishRecipe.matchFavorite(item.title, favorites.items || []);
        if (hit) {
            const saved = await dishesApi.saveIngredients(item.id, {
                titleKey: key,
                used: hit.used,
                source: 'favorite',
                recipeId: hit.id,
            });
            await this.settle(saved, hit.used, 'favorite', '');
            return;
        }

        // 3. 同一小家点过同名菜：复用上次的清单，不再调模型
        const cached = await dishesApi.lookupByTitle(key);
        if (cached.item && cached.item.used.length > 0) {
            const source = cached.item.recipeSource === 'favorite' ? 'favorite' : 'model';
            const saved = await dishesApi.saveIngredients(item.id, {
                titleKey: key,
                used: cached.item.used,
                source: source,
                recipeId: cached.item.recipeId,
            });
            await this.settle(saved, cached.item.used, source, cached.item.recipeAt);
            return;
        }

        // 4. 都没有：让模型按菜名估一份
        await this.generateRecipe(item, key);
    },

    // 落库后的收口：保存失败也要把已经算出来的清单显示出来，只是提醒下次还得再算。
    async settle(saved, fallbackUsed, fallbackSource, fallbackAt) {
        if (saved.error) {
            wx.showToast({ title: '清单没能存下来', icon: 'none' });
            await this.applyIngredients(fallbackUsed, fallbackSource, fallbackAt);
            this.setData({ recipeNote: noteOf(fallbackSource, fallbackAt) + '，这次没能存下来' });
            return;
        }
        const row = saved.item;
        const used = row && row.used.length > 0 ? row.used : fallbackUsed;
        const source = row && row.recipeSource ? row.recipeSource : fallbackSource;
        const at = row && row.recipeAt ? row.recipeAt : fallbackAt;
        await this.applyIngredients(used, source, at);
    },

    async generateRecipe(item, key) {
        const now = Date.now();
        if (this.lastGenerateAt && now - this.lastGenerateAt < modelConfig.COOLDOWN_MS) {
            this.setData({
                recipePhase: 'failed',
                recipeErrorText: '刚算过一次，缓两秒再试',
                canRetry: true,
            });
            return;
        }
        this.lastGenerateAt = now;

        this.setData({
            recipePhase: 'generating',
            genElapsed: 0,
            genChars: 0,
            recipeErrorText: '',
            canRetry: false,
        });
        this.startTimer();

        try {
            const result = await dishRecipe.generate(item.title, {
                onProgress: (chars) => this.setData({ genChars: chars }),
            });
            this.stopTimer();
            const saved = await dishesApi.saveIngredients(item.id, {
                titleKey: key,
                used: result.used,
                source: 'model',
                recipeId: item.recipeId,
                model: result.model,
            });
            await this.settle(saved, result.used, 'model', '');
        } catch (error) {
            this.stopTimer();
            const code = (error && error.code) || '';
            this.setData({
                recipePhase: code === 'empty' ? 'empty' : 'failed',
                recipeErrorText: dishRecipe.friendly(error),
                canRetry: true,
            });
        }
    },

    // 库存现读 + 三档比对。库存读失败时只列食材、不下判断 —— 把所有食材标成「缺」再给个加购按钮，
    // 会让人白跑一趟超市。
    async applyIngredients(used, source, at) {
        const context = this.context;
        const need = (used || []).filter((unit) => unit.fromFridge !== false);

        ingredientsApi.setScope(context.space.id, context.meId, context.meName);
        const stock = await ingredientsApi.list();
        const stockFailed = !!stock.error;
        const names = stockFailed ? [] : (stock.items || []).map((row) => row.name);

        let rows = [];
        let missCount = 0;
        let maybeCount = 0;
        let maybeText = '';

        if (stockFailed) {
            rows = need.map((unit) => ({
                name: unit.name,
                amount: unit.amount,
                level: '',
                hint: '',
            }));
        } else {
            const diff = pantry.diffNeeds(need, names);
            rows = diff.rows;
            missCount = diff.miss.length;
            maybeCount = diff.maybe.length;
            maybeText = diff.rows
                .filter((row) => row.level === 'maybe')
                .map((row) => row.name + '（冰箱里是' + row.hint + '）')
                .join('、');
        }

        const hasAny = (used || []).length > 0;
        this.setData({
            recipePhase: hasAny ? 'ready' : 'empty',
            recipeSource: source || '',
            recipeNote: !hasAny
                ? ''
                : (need.length > 0 ? noteOf(source, at) : '这道菜只用基础调料，不用特地买什么'),
            needRows: rows,
            missCount: missCount,
            maybeCount: maybeCount,
            maybeText: maybeText,
            stockFailed: stockFailed,
            canRetry: false,
        });
    },

    startTimer() {
        this.stopTimer();
        this.timer = setInterval(() => {
            this.setData({ genElapsed: this.data.genElapsed + 1 });
        }, 1000);
    },

    stopTimer() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    },

    onCancelRecipe() {
        dishRecipe.cancel();
        this.stopTimer();
        this.setData({
            recipePhase: 'failed',
            recipeErrorText: '已取消',
            canRetry: true,
            genElapsed: 0,
            genChars: 0,
        });
    },

    onRetryRecipe() {
        if (!this.data.item) return;
        this.load();
    },

    onRetryStock() {
        if (!this.data.item) return;
        if (this.data.item.used && this.data.item.used.length > 0) {
            this.applyIngredients(this.data.item.used, this.data.recipeSource, this.data.item.recipeAt);
            return;
        }
        this.load();
    },

    onGoFavorites() {
        wx.navigateTo({ url: '/pages/favorites/favorites' });
    },

    onOpenRecipe() {
        const item = this.data.item;
        if (!item || !item.recipeId) return;
        wx.navigateTo({ url: '/pages/recipe-detail/recipe-detail?id=' + item.recipeId });
    },

    // M11：从这里直接进烹饪模式。步骤已经在本页 data.steps 里拿到了（loadSteps），
    // 但没有 recipeId 时就进不去——cook-mode 页要靠 id 自己重拉整份菜谱（含食材）。
    onStartCooking() {
        const item = this.data.item;
        if (!item || !item.recipeId) return;
        wx.navigateTo({ url: '/pages/cook-mode/cook-mode?recipeId=' + item.recipeId });
    },

    onBarTap() {
        const action = this.data.barAction;
        if (action === 'claim') this.onClaim();
        else if (action === 'finish') this.onFinish();
    },

    // 所有动作共用一个入口：置忙 → 调函数 → 成功与否都整页重拉，绝不本地改状态。
    // onDone 可选，成功后才跑（点菜做完要接着弹消耗确认）。
    async runAction(kind, fn, okText, onDone) {
        if (this.data.actionBusy) return;
        this.setData({ actionBusy: kind });
        const result = await fn(this.dishId);
        this.setData({ actionBusy: '' });
        if (result.error) {
            wx.showToast({ title: guard.errorText(result.error), icon: 'none' });
            this.load();
            return;
        }
        if (okText) wx.showToast({ title: okText, icon: 'none' });
        if (typeof onDone === 'function') onDone();
        this.load();
    },

    onClaim() {
        this.runAction('claim', dishesApi.claim, '接下来了，好好做');
    },

    onFinish() {
        // N9：先标记完成，再弹消耗确认。两次调用而不是一次 ——
        // 改 dish_finish 要 DROP 线上 RPC，风险不值得。
        this.runAction('finish', dishesApi.finish, '做好了', () => this.openCookSheet());
    },

    // 做完之后列这道菜用到的冰箱食材，默认全勾「用完」
    async openCookSheet() {
        const item = this.data.item;
        if (!item || !item.used || item.used.length === 0) return;

        const inv = await ingredientsApi.list();
        const stock = inv.items || [];
        const stockNames = stock.map((row) => row.name);

        const rows = [];
        item.used.forEach((unit) => {
            if (unit.fromFridge === false) return;
            const matched = pantry.levelOf(unit.name, stockNames);
            let ingredientId = '';
            if (matched.level === 'have' && matched.hit) {
                const hit = stock.filter((row) => row.name === matched.hit)[0];
                if (hit) ingredientId = hit.id;
            }
            rows.push({
                name: unit.name,
                amount: unit.amount,
                ingredientId: ingredientId,
                action: ingredientId ? 'removed' : 'kept',
                checkable: !!ingredientId,
            });
        });

        if (rows.length === 0) return;
        this.setData({ cookOpen: true, cookRows: rows });
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
        this.setData({ cookOpen: false, cookRows: [] });
    },

    async onConfirmCook() {
        if (this.data.cooking) return;
        this.setData({ cooking: true });

        const consume = (this.data.cookRows || [])
            .filter((row) => row.ingredientId)
            .map((row) => ({ ingredientId: row.ingredientId, action: row.action }));

        const result = await mealPlan.dishConsume(this.dishId, consume);
        this.setData({ cooking: false });
        if (result.error) {
            wx.showToast({ title: guard.errorText(result.error), icon: 'none' });
            return;
        }
        this.setData({ cookOpen: false, cookRows: [] });
        const removed = (result.result && result.result.removed) || [];
        if (removed.length > 0) {
            wx.showToast({ title: '冰箱少了 ' + removed.length + ' 样', icon: 'none' });
        }
        this.load();
    },

    onRelease() {
        if (this.data.actionBusy) return;
        wx.showModal({
            title: '做不了这道菜？',
            content: '会放回待接单，TA 可以另外安排。',
            confirmText: '放回',
            success: (res) => {
                if (res.confirm) this.runAction('release', dishesApi.release, '已放回');
            },
        });
    },

    onCancel() {
        if (this.data.actionBusy) return;
        wx.showModal({
            title: '取消这道菜？',
            content: 'TA 那边也会看到它被取消了。',
            confirmText: '取消点菜',
            confirmColor: '#C0392B',
            success: (res) => {
                if (res.confirm) this.runAction('cancel', dishesApi.cancel, '已取消');
            },
        });
    },

    onDelete() {
        if (this.data.actionBusy) return;
        wx.showModal({
            title: '删掉这条记录？',
            content: '两个人都会看不到它。',
            confirmText: '删除',
            confirmColor: '#C0392B',
            success: async (res) => {
                if (!res.confirm) return;
                const result = await dishesApi.remove(this.dishId);
                if (result.error) {
                    wx.showToast({ title: guard.errorText(result.error), icon: 'none' });
                    return;
                }
                wx.navigateBack();
            },
        });
    },

    // 缺料进购物车：先按名字去重，再逐条串行加 —— 并发加会导致部分失败时说不清加进了哪几样。
    async onAddMissing() {
        if (this.data.cartBusy || this.data.stockFailed) return;
        const misses = (this.data.needRows || [])
            .filter((row) => row.level === 'miss')
            .map((row) => row.name);
        if (misses.length === 0) return;

        const context = this.context;
        if (!context) return;

        this.setData({ cartBusy: true, cartMessage: '' });
        shopping.setScope(context.space.id, context.meName);
        const existing = await shopping.list();

        const inCart = {};
        (existing.items || []).forEach((row) => {
            inCart[pantry.normalizeName(row.name)] = true;
        });

        let added = 0;
        let skipped = 0;
        let failed = 0;
        for (let i = 0; i < misses.length; i += 1) {
            const name = misses[i];
            const key = pantry.normalizeName(name);
            if (inCart[key]) {
                skipped += 1;
                continue;
            }
            const result = await shopping.add({ name: name, quantity: 1, unit: '', price: 0 });
            if (result.error) {
                failed += 1;
                continue;
            }
            inCart[key] = true;
            added += 1;
        }

        let message = added > 0 ? '加进购物车 ' + added + ' 样' : '购物车里已经有了';
        if (skipped > 0) message += '，' + skipped + ' 样本就在清单里';
        if (failed > 0) message += '，' + failed + ' 样没加上';

        this.setData({ cartBusy: false, cartMessage: message });
        wx.showToast({ title: message, icon: 'none' });
    },

    onGoCart() {
        wx.switchTab({ url: '/pages/cart/cart' });
    },

    // 阻止消耗确认弹层内的点击穿透到遮罩
    noop() {
        // 故意留空：WXML 里用 catchtap="noop" 挂在弹层容器上
    },
});
