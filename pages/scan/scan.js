// 拍照入库，三段式：
//   1) 基础识别（只认「有什么」，不猜保质期）
//   2) 用户核对修改（识别失败的照片也保留，可以手动补条目）
//   3) 保质期单独一轮：用专门提示词的模型，按「确认后的数据 + 存放位置」估算
//
// 状态机：pick（还没拍） → collect（已拍若干张） → recognizing（逐张基础识别）
//        → review（核对页，可编辑） → 入库
//        review 里另有两个子状态：estimating（正在估保质期）、expireReady（已估过一轮）
//
// 关键约束：
// 1. 拍照阶段不发任何请求，拍多少张都不会被识别阻塞。
// 2. 基础识别按图逐张请求：单张失败只影响那一张，可只重试失败的。
// 3. 识别失败的照片保留在列表里，可以「手动补充」条目，仍然能入库。
// 4. 保质期不参与基础识别，只由 utils/shelf.js 在用户确认之后再单独算。
// 5. 核对页里「没认出来」的单张可点「重新识别」单独重认：重认期间该张显示
//    加载态，其余照片不受影响；认完就地刷新这一张的结果与汇总数字。
const guard = require('../../utils/auth-guard');
const ingredientsApi = require('../../utils/ingredients');
const vision = require('../../utils/vision');
const shelf = require('../../utils/shelf');
const { CATEGORY_KEYS } = require('../../utils/format');

const MAX_SHOTS = 9;
const DEFAULT_CATEGORY_INDEX = CATEGORY_KEYS.length - 1;

function toEditable(item, shotKey, index) {
    const categoryIndex = CATEGORY_KEYS.indexOf(item.category);
    return {
        key: shotKey + '-' + index,
        name: item.name,
        category: item.category,
        categoryIndex: categoryIndex < 0 ? DEFAULT_CATEGORY_INDEX : categoryIndex,
        quantity: item.quantity,
        unit: item.unit,
        storage: item.storage,
        expireAt: '',
        expireNote: '',
        checked: true,
    };
}

function blankItem(shotKey) {
    return {
        key: shotKey + '-m' + Date.now() + Math.floor(Math.random() * 100),
        name: '',
        category: CATEGORY_KEYS[DEFAULT_CATEGORY_INDEX],
        categoryIndex: DEFAULT_CATEGORY_INDEX,
        quantity: '1',
        unit: '份',
        storage: '冷藏',
        expireAt: '',
        expireNote: '',
        checked: true,
    };
}

Page({
    data: {
        authState: 'checking',
        stage: 'pick',
        shots: [],
        total: 0,
        doneCount: 0,
        failCount: 0,
        selectedCount: 0,
        pendingExpire: 0,
        expireReady: false,
        estimating: false,
        saving: false,
        categories: CATEGORY_KEYS,
        maxShots: MAX_SHOTS,
        errorText: '',
        retryingKey: '',
    },

    onLoad() {
        this.init();
    },

    async init() {
        const context = await guard.check(this);
        if (!context) return;
        ingredientsApi.setScope(context.space.id, context.meId, context.meName);
        this.setData({ authState: 'ready' });
    },

    // ---------- 1. 拍照：只收集，不识别 ----------

    onAddPhotos() {
        if (this.data.stage === 'recognizing' || this.data.saving || this.data.estimating || this.data.retryingKey) return;
        const remaining = MAX_SHOTS - this.data.shots.length;
        if (remaining <= 0) {
            wx.showToast({ title: '最多 ' + MAX_SHOTS + ' 张', icon: 'none' });
            return;
        }

        wx.chooseMedia({
            count: remaining,
            mediaType: ['image'],
            sourceType: ['camera', 'album'],
            sizeType: ['compressed'],
            camera: 'back',
            success: (res) => {
                const files = res.tempFiles || [];
                if (files.length === 0) return;
                const shots = this.data.shots.slice();
                const stamp = Date.now();
                files.forEach((file, index) => {
                    if (!file || !file.tempFilePath) return;
                    shots.push({
                        key: 's' + stamp + '-' + index,
                        path: file.tempFilePath,
                        status: 'pending', // pending | running | done | failed
                        error: '',
                        manual: false,
                        items: [],
                    });
                });
                this.setData({ shots: shots, stage: 'collect', errorText: '' });
                this.recount();
            },
            fail: (error) => {
                const message = (error && error.errMsg) || '';
                if (message.indexOf('cancel') >= 0) return;
                wx.showToast({ title: '打不开相机或相册', icon: 'none' });
            },
        });
    },

    onRemoveShot(event) {
        if (this.data.stage === 'recognizing' || this.data.estimating || this.data.retryingKey) return;
        const key = event.currentTarget.dataset.key;
        const shots = this.data.shots.filter((shot) => shot.key !== key);
        this.setData({
            shots: shots,
            stage: shots.length === 0 ? 'pick' : this.data.stage,
        });
        this.recount();
    },

    onPreviewShot(event) {
        const key = event.currentTarget.dataset.key;
        const shot = this.data.shots.filter((item) => item.key === key)[0];
        if (!shot) return;
        wx.previewImage({ current: shot.path, urls: this.data.shots.map((item) => item.path) });
    },

    // ---------- 2. 基础识别（不含保质期） ----------

    onStartRecognize() {
        if (this.data.stage === 'recognizing' || this.data.saving || this.data.retryingKey) return;
        if (this.data.shots.length === 0) {
            wx.showToast({ title: '先拍几张', icon: 'none' });
            return;
        }
        this.recognizeAll();
    },

    onRetryFailed() {
        if (this.data.retryingKey || this.data.saving || this.data.estimating) return;
        const failed = this.data.shots.filter((shot) => shot.status === 'failed' && shot.items.length === 0);
        if (failed.length === 0) {
            wx.showToast({ title: '失败的都已手动补过', icon: 'none' });
            return;
        }
        const shots = this.data.shots.map((shot) => (
            shot.status === 'failed' && shot.items.length === 0
                ? Object.assign({}, shot, { status: 'pending', error: '' })
                : shot
        ));
        this.setData({ shots: shots, stage: 'recognizing' });
        this.recognizeAll();
    },

    // 单张重认：核对页里「没认出来」的那一张单独重试，不影响其他照片。
    onRetryShot(event) {
        if (this.data.retryingKey || this.data.saving || this.data.estimating || this.data.stage === 'recognizing') return;
        const si = Number(event.currentTarget.dataset.si);
        this.retryShot(si);
    },

    async retryShot(si) {
        const shot = (this.data.shots || [])[si];
        if (!shot) return;

        // 这一张进入 running：rescue-card 切到加载态，按钮变「识别中…」。
        this.setData({
            retryingKey: shot.key,
            errorText: '',
            ['shots[' + si + '].status']: 'running',
            ['shots[' + si + '].error']: '',
        });

        let ok = false;
        let message = '';
        try {
            const result = await vision.recognize(shot.path);
            // 等待期间用户可能删了这张、或点了「全部重来」：key 对不上就放弃写回。
            const current = (this.data.shots || [])[si];
            if (!current || current.key !== shot.key) {
                this.setData({ retryingKey: '' });
                return;
            }
            if (!result.items || result.items.length === 0) {
                this.setData({
                    ['shots[' + si + '].status']: 'failed',
                    ['shots[' + si + '].error']: '模型没返回食材，再试一次或手动补',
                });
                message = '还是没认出来';
            } else {
                // 重认成功：整组替换为最新结果，rescue-card 消失，就地刷新展示。
                const items = result.items.map((item, index) => toEditable(item, shot.key, index));
                this.setData({
                    ['shots[' + si + '].status']: 'done',
                    ['shots[' + si + '].items']: items,
                    ['shots[' + si + '].error']: '',
                });
                ok = true;
                message = '认出 ' + items.length + ' 样';
            }
        } catch (error) {
            const current = (this.data.shots || [])[si];
            if (!current || current.key !== shot.key) {
                this.setData({ retryingKey: '' });
                return;
            }
            this.setData({
                ['shots[' + si + '].status']: 'failed',
                ['shots[' + si + '].error']: vision.friendly(error),
            });
            message = '识别失败，稍后再试';
        }

        this.setData({ retryingKey: '' });
        this.recountProgress();
        this.recount();
        wx.showToast({ title: message, icon: ok ? 'success' : 'none' });
    },

    // 重认结束后同步汇总卡数字：认出几张、还剩几张要手动补。
    recountProgress() {
        let done = 0;
        let fail = 0;
        (this.data.shots || []).forEach((shot) => {
            if (shot.status === 'done' || (shot.items && shot.items.length > 0)) done += 1;
            else if (shot.status === 'failed') fail += 1;
        });
        this.setData({ doneCount: done, failCount: fail });
    },

    async recognizeAll() {
        this.setData({ stage: 'recognizing', errorText: '', doneCount: 0, failCount: 0 });

        const shots = this.data.shots;
        let done = 0;
        let fail = 0;

        for (let i = 0; i < shots.length; i += 1) {
            // 已识别成功、或已经手动补过内容的，都不再重复请求。
            if (shots[i].status === 'done' || (shots[i].items && shots[i].items.length > 0)) {
                done += 1;
                continue;
            }
            this.setData({ ['shots[' + i + '].status']: 'running', ['shots[' + i + '].error']: '' });
            try {
                const result = await vision.recognize(shots[i].path);
                if (!result.items || result.items.length === 0) {
                    this.setData({
                        ['shots[' + i + '].status']: 'failed',
                        ['shots[' + i + '].error']: '这张没认出食材',
                        ['shots[' + i + '].items']: [],
                    });
                    fail += 1;
                } else {
                    const items = result.items.map((item, index) => toEditable(item, shots[i].key, index));
                    this.setData({
                        ['shots[' + i + '].status']: 'done',
                        ['shots[' + i + '].items']: items,
                    });
                    done += 1;
                }
            } catch (error) {
                this.setData({
                    ['shots[' + i + '].status']: 'failed',
                    ['shots[' + i + '].error']: vision.friendly(error),
                });
                fail += 1;
            }
            this.setData({ doneCount: done, failCount: fail });
            this.recount();
        }

        this.setData({ doneCount: done, failCount: fail, stage: 'review' });
        this.recount();
    },

    // ---------- 3. 核对与手动补充 ----------

    // 识别失败的照片也留在这里，可以往里面加条目，不会变成死路。
    onAddManualItem(event) {
        const si = Number(event.currentTarget.dataset.si);
        const shot = (this.data.shots || [])[si];
        if (!shot) return;
        // 正在重认这张：等结果落地再补，避免手动条目被识别结果冲掉。
        if (this.data.retryingKey === shot.key) {
            wx.showToast({ title: '正在识别这张，稍等一下', icon: 'none' });
            return;
        }
        const items = (shot.items || []).slice();
        items.push(blankItem(shot.key));
        this.setData({
            ['shots[' + si + '].items']: items,
            ['shots[' + si + '].manual']: true,
        });
        this.recount();
    },

    onToggle(event) {
        this.patchItem(event, (item) => ({ checked: !item.checked }), true);
    },

    onFieldInput(event) {
        const field = event.currentTarget.dataset.field;
        if (!field) return;
        const patch = {};
        patch[field] = event.detail.value;
        this.patchItem(event, () => patch, field === 'name');
    },

    onCategoryChange(event) {
        const value = Number(event.detail.value) || 0;
        this.patchItem(event, () => ({
            categoryIndex: value,
            category: CATEGORY_KEYS[value],
        }), false);
    },

    onStoragePick(event) {
        const storage = event.currentTarget.dataset.storage === '冷冻' ? '冷冻' : '冷藏';
        this.patchItem(event, () => ({ storage: storage }), false);
    },

    onDateChange(event) {
        this.patchItem(event, () => ({ expireAt: event.detail.value, expireNote: '' }), false);
    },

    patchItem(event, build, needRecount) {
        const si = Number(event.currentTarget.dataset.si);
        const ii = Number(event.currentTarget.dataset.ii);
        const shot = (this.data.shots || [])[si];
        if (!shot || !shot.items || !shot.items[ii]) return;
        const items = shot.items.slice();
        items[ii] = Object.assign({}, items[ii], build(items[ii]));
        this.setData({ ['shots[' + si + '].items']: items });
        if (needRecount) this.recount();
    },

    onRemoveItem(event) {
        const si = Number(event.currentTarget.dataset.si);
        const ii = Number(event.currentTarget.dataset.ii);
        const shot = (this.data.shots || [])[si];
        if (!shot) return;
        const items = shot.items.slice();
        items.splice(ii, 1);
        this.setData({ ['shots[' + si + '].items']: items });
        this.recount();
    },

    onSelectAll() {
        this.setAllChecked(true);
    },

    onSelectNone() {
        this.setAllChecked(false);
    },

    setAllChecked(checked) {
        const shots = this.data.shots.map((shot) => Object.assign({}, shot, {
            items: (shot.items || []).map((item) => Object.assign({}, item, { checked: checked })),
        }));
        this.setData({ shots: shots });
        this.recount();
    },

    // ---------- 4. 保质期：独立一轮 ----------

    // 只处理「勾选了、名字非空、还没有保质期」的条目；用户改过的名称/类别/存放位置都会带上。
    async onEstimateExpire() {
        if (this.data.estimating || this.data.saving || this.data.stage === 'recognizing' || this.data.retryingKey) return;

        const targets = [];
        (this.data.shots || []).forEach((shot, si) => {
            (shot.items || []).forEach((item, ii) => {
                if (!item.checked) return;
                if (String(item.name || '').trim() === '') return;
                if (item.expireAt) return;
                targets.push({ si: si, ii: ii, name: item.name, category: item.category, storage: item.storage });
            });
        });

        if (targets.length === 0) {
            wx.showToast({ title: '要填的保质期都齐了', icon: 'none' });
            return;
        }

        this.setData({ estimating: true, errorText: '' });
        try {
            const result = await shelf.suggest(targets.map((item) => ({
                name: item.name,
                category: item.category,
                storage: item.storage,
            })));

            const byIndex = {};
            result.suggestions.forEach((item) => {
                byIndex[item.idx] = item;
            });

            const shots = this.data.shots.map((shot) => Object.assign({}, shot, {
                items: (shot.items || []).slice(),
            }));
            let filled = 0;
            targets.forEach((target, index) => {
                const suggestion = byIndex[index];
                if (!suggestion) return;
                shots[target.si].items[target.ii] = Object.assign({}, shots[target.si].items[target.ii], {
                    expireAt: suggestion.expireAt,
                    expireNote: suggestion.note,
                });
                filled += 1;
            });

            this.setData({
                estimating: false,
                shots: shots,
                expireReady: filled > 0 || this.data.expireReady,
            });
            this.recount();

            if (filled === 0) {
                wx.showModal({
                    title: '没估出来',
                    content: '模型没有给出可用的保质期。可以手动填日期，或者再试一次。',
                    showCancel: false,
                });
                return;
            }
            wx.showToast({ title: '估好 ' + filled + ' 样', icon: 'success' });
        } catch (error) {
            this.setData({ estimating: false });
            wx.showModal({
                title: '没估成',
                content: shelf.friendly(error),
                showCancel: false,
            });
        }
    },

    // ---------- 5. 入库 ----------

    async onSave() {
        if (this.data.saving || this.data.stage === 'recognizing' || this.data.estimating || this.data.retryingKey) return;

        const rows = [];
        const seen = {};
        (this.data.shots || []).forEach((shot) => {
            (shot.items || []).forEach((item) => {
                const name = String(item.name || '').trim();
                if (!item.checked || name === '') return;
                const dedupe = name + '|' + (item.unit || '');
                if (seen[dedupe]) return;
                seen[dedupe] = true;
                rows.push({
                    name: name,
                    category: item.category,
                    quantity: item.quantity,
                    unit: item.unit,
                    storage: item.storage,
                    expireAt: item.expireAt || null,
                });
            });
        });

        if (rows.length === 0) {
            wx.showToast({ title: '没有勾选任何食材', icon: 'none' });
            return;
        }

        this.setData({ saving: true, errorText: '' });
        const result = await ingredientsApi.createMany(rows);
        if (result.error) {
            this.setData({ saving: false, errorText: guard.errorText(result.error) });
            return;
        }
        this.setData({ saving: false });
        wx.showToast({ title: '加进来 ' + result.count + ' 样', icon: 'success' });
        setTimeout(() => {
            wx.navigateBack();
        }, 700);
    },

    recount() {
        let selected = 0;
        let total = 0;
        let pending = 0;
        (this.data.shots || []).forEach((shot) => {
            (shot.items || []).forEach((item) => {
                total += 1;
                const usable = item.checked && String(item.name || '').trim() !== '';
                if (usable) {
                    selected += 1;
                    if (!item.expireAt) pending += 1;
                }
            });
        });
        this.setData({ selectedCount: selected, total: total, pendingExpire: pending });
    },

    onReset() {
        // 重认在途也允许重来：retryShot 写回前会校验 key，对不上就丢弃结果。
        this.setData({
            stage: 'pick',
            shots: [],
            total: 0,
            doneCount: 0,
            failCount: 0,
            selectedCount: 0,
            pendingExpire: 0,
            expireReady: false,
            estimating: false,
            saving: false,
            errorText: '',
            retryingKey: '',
        });
    },

    onManual() {
        wx.redirectTo({ url: '/pages/ingredient-edit/ingredient-edit' });
    },
});
