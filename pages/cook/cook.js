// 配菜：已勾选食材 → 生成菜谱 → 可收藏。
// 生成失败的三种形态分开处理：网络/额度错误、模型有输出但没解析成 JSON、用户主动取消。
const guard = require('../../utils/auth-guard');
const ingredientsApi = require('../../utils/ingredients');
const recipesApi = require('../../utils/recipes');
const selection = require('../../utils/selection');
const cooking = require('../../utils/cooking');
const modelConfig = require('../../utils/model-config');

// 目录里会出现同名不同 id 的条目（例如三个都叫 Hy3），只显示 name 完全分不清。
// 后缀取自 id：最后一段太短就再带上一段；如果拼出来跟名称重复，就交给编号兜底。
function shortSuffix(id, name) {
    const segments = String(id || '').split(/[-_.\/]/).filter((part) => part !== '');
    if (segments.length === 0) return '';
    let suffix = segments[segments.length - 1];
    if (suffix.length <= 3 && segments.length > 1) {
        suffix = segments.slice(-2).join('-');
    }
    const normalize = (text) => String(text).toLowerCase().replace(/[\s_-]/g, '');
    // 后缀本身就是名称的一部分（hy3 / hy4）时，加了等于没加，交给后面的编号兜底。
    if (normalize(name).indexOf(normalize(suffix)) >= 0) return '';
    return suffix.length > 16 ? suffix.slice(-16) : suffix;
}

// 两遍：先给每个模型取一个尽量有区分度的标签，再统一解决重名。
function labelModels(models) {
    const base = models.map((item) => {
        const name = String(item.name || item.id || '模型');
        const hint = shortSuffix(item.id, name);
        return hint ? (name + ' · ' + hint).slice(0, 30) : name;
    });
    const counts = {};
    base.forEach((label) => {
        counts[label] = (counts[label] || 0) + 1;
    });
    const seen = {};
    return base.map((label) => {
        if (counts[label] === 1) return label;
        seen[label] = (seen[label] || 0) + 1;
        return label + ' (' + seen[label] + ')';
    });
}

function nameMatched(name, pool) {
    for (let i = 0; i < pool.length; i += 1) {
        const candidate = pool[i];
        if (candidate === name) return true;
        if (candidate.indexOf(name) >= 0) return true;
        if (name.indexOf(candidate) >= 0) return true;
    }
    return false;
}

Page({
    data: {
        authState: 'checking',
        loading: true,
        error: '',
        chips: [],
        selectedCount: 0,
        totalCount: 0,
        phase: 'idle',
        elapsed: 0,
        progressChars: 0,
        dishes: [],
        rawText: '',
        errorText: '',
        modelName: '',
    },

    onShow() {
        this.load();
    },

    onHide() {
        // 切到别的 tab 不打断生成：页面还在，让它跑完。
    },

    onUnload() {
        this.stopTimer();
        cooking.cancel();
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = null;
        }
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

        if (!this.unsubscribe) {
            this.unsubscribe = selection.subscribeCommitted(() => this.renderChips());
        }

        const result = await ingredientsApi.list();
        if (fromPull) wx.stopPullDownRefresh();
        if (result.error) {
            this.setData({ loading: false, error: guard.errorText(result.error) });
            return;
        }
        this.items = result.items;
        selection.reconcileCommitted(this.items);
        this.setData({ loading: false, error: '', totalCount: this.items.length });
        this.renderChips();
        this.loadModels();
    },

    // 模型目录在会话内不变，页面进来时取一次即可。
    async loadModels() {
        const listed = await cooking.listModels();
        if (listed.error || listed.models.length === 0) {
            this.models = [];
            this.labels = [];
            this.setData({ modelName: '' });
            return;
        }
        this.models = listed.models;
        this.labels = labelModels(listed.models);
        const preferred = cooking.getPreferredModelId();
        let index = 0;
        listed.models.forEach((item, i) => {
            if (item.id === preferred) index = i;
        });
        this.currentIndex = index;
        this.setData({ modelName: this.labels[index] });
    },

    onPickModel() {
        const models = this.models || [];
        if (models.length === 0) {
            wx.showToast({ title: '还没有取到可用模型', icon: 'none' });
            return;
        }
        // actionSheet 最多 6 项；目录本身很小，取前 6 个足够。
        const shown = models.slice(0, 6);
        const names = (this.labels || []).slice(0, 6);
        wx.showActionSheet({
            itemList: names,
            success: (res) => {
                const picked = shown[res.tapIndex];
                if (!picked) return;
                const persisted = cooking.setPreferredModelId(picked.id);
                this.currentIndex = res.tapIndex;
                this.setData({ modelName: names[res.tapIndex] });
                wx.showToast({
                    title: persisted ? '已切到 ' + names[res.tapIndex] : '已切到 ' + names[res.tapIndex] + '，但没能记住',
                    icon: 'none',
                });
            },
            fail: () => {},
        });
    },

    renderChips() {
        const ids = selection.getCommitted();
        const byId = {};
        (this.items || []).forEach((item) => {
            byId[item.id] = item;
        });
        const chips = ids
            .map((id) => byId[id])
            .filter((item) => !!item)
            .map((item) => ({ id: item.id, name: item.name, amount: item.amount }));
        this.setData({ chips: chips, selectedCount: chips.length });
    },

    onRemoveChip(event) {
        selection.removeCommitted(event.currentTarget.dataset.id);
    },

    onSelectAll() {
        selection.setAllCommitted((this.items || []).map((item) => item.id));
    },

    onClearSelection() {
        selection.clearCommitted();
    },

    onGoFridge() {
        wx.switchTab({ url: '/pages/fridge/fridge' });
    },

    startTimer() {
        this.stopTimer();
        this.timer = setInterval(() => {
            this.setData({ elapsed: this.data.elapsed + 1 });
        }, 1000);
    },

    stopTimer() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    },

    async onGenerate() {
        if (this.data.phase === 'generating') return;
        // 平台通道按次消耗额度，连点两下等于白烧一次调用。
        const now = Date.now();
        if (this.lastGenerateAt && now - this.lastGenerateAt < modelConfig.COOLDOWN_MS) {
            wx.showToast({ title: '等两秒再生成', icon: 'none' });
            return;
        }
        const ids = selection.getCommitted();
        if (ids.length === 0) {
            wx.showToast({ title: '先在冰箱里勾几样', icon: 'none' });
            return;
        }
        const byId = {};
        (this.items || []).forEach((item) => {
            byId[item.id] = item;
        });
        const picked = ids
            .map((id) => byId[id])
            .filter((item) => !!item)
            .map((item) => ({ name: item.name, amount: item.amount, category: item.category }));
        if (picked.length === 0) {
            wx.showToast({ title: '勾选的食材已经被删掉了', icon: 'none' });
            selection.reconcileCommitted(this.items || []);
            return;
        }

        this.lastGenerateAt = Date.now();
        this.setData({
            phase: 'generating',
            elapsed: 0,
            progressChars: 0,
            dishes: [],
            rawText: '',
            errorText: '',
            error: '',
        });
        this.startTimer();

        const pool = picked.map((item) => item.name);
        try {
            const result = await cooking.generate({
                ingredients: picked,
                count: 3,
                onProgress: (chars) => this.setData({ progressChars: chars }),
            });
            this.stopTimer();

            if (result.dishes && result.dishes.length > 0) {
                const dishes = result.dishes.map((dish, index) => ({
                    key: 'dish-' + index,
                    title: dish.title,
                    summary: dish.summary,
                    steps: dish.steps,
                    nutrition: dish.nutrition || null,
                    used: dish.used.map((unit) => ({
                        name: unit.name,
                        amount: unit.amount,
                        fromFridge: unit.fromFridge,
                        missing: unit.fromFridge ? !nameMatched(unit.name, pool) : false,
                    })),
                    saved: false,
                    recipeId: '',
                }));
                this.setData({ phase: 'done', dishes: dishes });
            } else {
                this.setData({ phase: 'raw', rawText: result.raw || '' });
            }
        } catch (error) {
            this.stopTimer();
            this.setData({ phase: 'error', errorText: cooking.friendlyMessage(error) });
        }
    },

    onCancelGenerate() {
        cooking.cancel();
        this.stopTimer();
        this.setData({ phase: 'idle', elapsed: 0, progressChars: 0 });
        wx.showToast({ title: '已取消', icon: 'none' });
    },

    onRegenerate() {
        this.onGenerate();
    },

    // 收藏与「就做这个」共用：两个动作都需要一条 recipe_favorite 记录，
    // 顺手把返回的 id 存回 dishes[index].recipeId，避免重复收藏出两条。
    async saveDishRecord(dish) {
        const result = await recipesApi.save({
            title: dish.title,
            summary: dish.summary,
            used: dish.used.map((unit) => ({
                name: unit.name,
                amount: unit.amount,
                fromFridge: unit.fromFridge,
            })),
            steps: dish.steps,
            // M12：营养跟着菜谱一起落库，之后打卡时由 DB 拷快照。
            nutrition: dish.nutrition || null,
        });
        if (result.error) return { id: '', error: result.error };
        return { id: result.item ? String(result.item.id) : '', error: null };
    },

    async onSaveDish(event) {
        const index = Number(event.currentTarget.dataset.index);
        const dish = this.data.dishes[index];
        if (!dish || dish.saved) return;

        const key = 'dishes[' + index + '].saved';
        this.setData({ [key]: true });
        const saved = await this.saveDishRecord(dish);
        if (saved.error) {
            this.setData({ [key]: false });
            wx.showToast({ title: guard.errorText(saved.error), icon: 'none' });
            return;
        }
        if (saved.id) this.setData({ ['dishes[' + index + '].recipeId']: saved.id });
        wx.showToast({ title: '已收藏', icon: 'success' });
    },

    // 点菜入口：先确保这道菜已经落成可引用的菜谱记录，再把菜名和 id 带过去。
    async onMakeThis(event) {
        const index = Number(event.currentTarget.dataset.index);
        const dish = this.data.dishes[index];
        if (!dish || this.makeBusy) return;

        this.makeBusy = true;
        let recipeId = dish.recipeId || '';
        if (!recipeId) {
            wx.showLoading({ title: '保存菜谱…', mask: true });
            const saved = await this.saveDishRecord(dish);
            wx.hideLoading();
            if (saved.error || !saved.id) {
                this.makeBusy = false;
                wx.showToast({
                    title: saved.error ? guard.errorText(saved.error) : '保存失败',
                    icon: 'none',
                });
                return;
            }
            recipeId = saved.id;
            this.setData({
                ['dishes[' + index + '].saved']: true,
                ['dishes[' + index + '].recipeId']: recipeId,
            });
        }
        this.makeBusy = false;
        wx.navigateTo({
            url: '/pages/dish-edit/dish-edit?recipeId=' + recipeId
                + '&title=' + encodeURIComponent(dish.title),
        });
    },
});
