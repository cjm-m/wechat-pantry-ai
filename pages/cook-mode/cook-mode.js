// 全屏烹饪模式（M11）：一次只看一步，大字，计时器，屏幕常亮。
//
// 为什么单独开一页而不是在 recipe-detail 里加个「放大」按钮：
//   1. 做饭时手上有油、离手机远，字号要能到 100rpx 以上，得占满整屏；
//   2. 其余页面都有导航栏和底部按钮，全屏需要 navigationStyle: custom；
//   3. 屏幕常亮必须在 onShow/onHide 成对开关，只有独立页面才有干净的生命周期。
//
// 不做语音下一步：微信同声传译插件需要小程序后台添加插件，app.json 目前没有
// plugins 字段。这里把「下一步」做成占满屏宽的大按钮，仍是单手可点的尺寸。
const guard = require('../../utils/auth-guard');
const recipesApi = require('../../utils/recipes');
const stepTimer = require('../../utils/step-timer');

Page({
    data: {
        authState: 'checking',
        error: '',
        title: '',
        index: 0,
        total: 0,
        currentText: '',
        isLast: false,
        // 计时器
        duration: 0,          // 这一步自动识别出的总秒数，0 = 没识别到
        remain: 0,
        clock: '00:00',
        running: false,
        finished: false,
        statusBarHeight: 20,
    },

    onLoad(query) {
        // getWindowInfo 是新接口，getSystemInfoSync 在 3.x 仍可用但已标记弃用，留作兜底。
        const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
        this.setData({ statusBarHeight: (info && info.statusBarHeight) || 20 });
        this.recipeId = query && query.recipeId ? String(query.recipeId) : '';
        this.timer = null;
        this.load();
    },

    onShow() {
        // 防息屏：做饭全程不锁屏。失败不影响页面（部分机型不支持），所以不弹错。
        if (wx.setKeepScreenOn) {
            wx.setKeepScreenOn({ keepScreenOn: true, fail: () => {} });
        }
    },

    onHide() {
        // 切后台必须停表：setInterval 在后台不可靠，回来后 remain 会是错的。
        this.stopTimer();
        this.setData({ running: false });
        if (wx.setKeepScreenOn) {
            wx.setKeepScreenOn({ keepScreenOn: false, fail: () => {} });
        }
    },

    onUnload() {
        this.stopTimer();
        if (wx.setKeepScreenOn) {
            wx.setKeepScreenOn({ keepScreenOn: false, fail: () => {} });
        }
    },

    async load() {
        const context = await guard.check(this);
        if (!context) return;
        recipesApi.setScope(context.space.id, context.meName);

        if (!this.recipeId) {
            this.setData({ authState: 'ready', error: '没有找到这道菜' });
            return;
        }
        const result = await recipesApi.get(this.recipeId);
        if (result.error || !result.item) {
            this.setData({
                authState: 'ready',
                error: result.error ? guard.errorText(result.error) : '这道菜可能已经被取消收藏了',
            });
            return;
        }
        const steps = result.item.steps || [];
        if (steps.length === 0) {
            this.setData({ authState: 'ready', error: '这道菜还没有做法' });
            return;
        }
        this.setData({
            authState: 'ready',
            error: '',
            title: result.item.title,
            total: steps.length,
            currentText: steps[0] || '',
            isLast: steps.length === 1,
        });
        this.steps = steps;
        this.applyStep(0);
    },

    // 换步：重置计时器，并按新步骤文字里识别出的时长自动填。
    // steps 存在 this 上而不是 data 里：WXML 只渲染当前一条，
    // 整份放 data 会让每次 setData 都重复传输十几条文本。
    applyStep(index) {
        const steps = this.steps || [];
        if (steps.length === 0) return;
        const safe = Math.max(0, Math.min(Number(index) || 0, steps.length - 1));
        const text = steps[safe] || '';
        const duration = stepTimer.parseDuration(text);
        this.stopTimer();
        this.setData({
            index: safe,
            currentText: text,
            isLast: safe === steps.length - 1,
            duration: duration,
            remain: duration,
            clock: stepTimer.formatClock(duration),
            running: false,
            finished: false,
        });
    },

    onPrev() {
        if (this.data.index <= 0) return;
        this.applyStep(this.data.index - 1);
    },

    onNext() {
        if (this.data.isLast) {
            this.onDone();
            return;
        }
        this.applyStep(this.data.index + 1);
    },

    // 最后一步的按钮就是「做好了」。不做二次确认：做饭的人手上正忙，
    // 多点一次弹窗只会烦；走错一步可以点「上一步」回来。
    onDone() {
        wx.showToast({ title: '开饭吧', icon: 'success', duration: 1200 });
        setTimeout(() => wx.navigateBack(), 900);
    },

    onToggleTimer() {
        // 没识别出时长：一次点击先给 5 分钟的可用预设，而不是点了没反应。
        if (this.data.duration === 0) {
            this.setDuration(300);
            return;
        }
        if (this.data.running) {
            this.stopTimer();
            this.setData({ running: false });
            return;
        }
        const start = this.data.remain > 0 ? this.data.remain : this.data.duration;
        this.setData({ remain: start, clock: stepTimer.formatClock(start), running: true, finished: false });
        this.startTimer();
    },

    // 手动加 1 分钟：识别不准时的兜底，比让用户重开计时器快。
    onBumpDuration() {
        this.setDuration((this.data.duration || 0) + 60);
    },

    setDuration(seconds) {
        const safe = Math.max(0, Math.min(Math.round(Number(seconds) || 0), 7200));
        this.stopTimer();
        this.setData({
            duration: safe,
            remain: safe,
            clock: stepTimer.formatClock(safe),
            running: false,
            finished: false,
        });
    },

    onResetTimer() {
        this.stopTimer();
        this.setData({
            remain: this.data.duration,
            clock: stepTimer.formatClock(this.data.duration),
            running: false,
            finished: false,
        });
    },

    startTimer() {
        this.stopTimer();
        this.timer = setInterval(() => {
            const next = this.data.remain - 1;
            if (next <= 0) {
                this.stopTimer();
                this.setData({ remain: 0, clock: '00:00', running: false, finished: true });
                // 震动 + toast：用户这时多半没在看屏幕，只有触觉和声音能叫住他。
                // type 用 heavy，普通 short 在炒菜噪声里容易被忽略。
                if (wx.vibrateShort) wx.vibrateShort({ type: 'heavy', fail: () => {} });
                wx.showToast({ title: '时间到了', icon: 'none' });
                return;
            }
            this.setData({ remain: next, clock: stepTimer.formatClock(next) });
        }, 1000);
    },

    stopTimer() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    },

    onBack() {
        wx.navigateBack();
    },
});
