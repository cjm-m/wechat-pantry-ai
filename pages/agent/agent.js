// 家庭助手（M5）：一句话让它查冰箱、排菜单、算缺料、加购物车。
//
// 这一页只做「输入 + 展示」。真正的 ReAct 循环在服务端（server/llm-proxy.js
// 的 /llm/agent），因为要访问数据库、还要绕开 wx.request 的 60s 上限。
// 客户端拿到的是一次性的结果：{answer, steps[], truncated}。
//
// 步骤可视化（spec §5 要求）靠 steps 数组：每个工具调用是一条，
// 显示「查冰箱 ✓ 0.2s」这样的行。这不是流式，是请求返回后一次性渲染 ——
// 但用户能看见助手到底做了什么，而不是只给一段结论。

const guard = require('../../utils/auth-guard');
const llm = require('../../utils/llm');
const cooking = require('../../utils/cooking');
const modelPref = require('../../utils/model-pref');

// 工具名 → 中文动作。服务端的工具名是稳定的，这里做展示层翻译，
// 不要在服务端返回中文（那是展示层的事，换文案不用改服务端）。
const TOOL_LABELS = {
    query_inventory: '查冰箱',
    get_week_plan: '查这周菜单',
    add_plan_item: '排一道菜',
    get_shortage: '算缺料',
    add_to_cart: '加进购物车',
};

const SUGGESTIONS = [
    '冰箱里有什么快过期了？',
    '这周晚上吃什么好？',
    '这周还缺什么要买？',
    '周三晚上想吃番茄炒蛋，帮我排上',
];

function labelOf(tool) {
    return TOOL_LABELS[tool] || tool || '执行';
}

function msText(ms) {
    if (!ms || ms < 0) return '';
    if (ms < 1000) return ms + 'ms';
    return (Math.round(ms / 100) / 10) + 's';
}

Page({
    data: {
        authState: 'checking',
        error: '',

        messages: [],       // [{id, role:'user'|'agent', text, steps[], truncated}]
        draft: '',
        sending: false,
        sendingText: '',    // 发送中显示的那句话，让用户知道在等什么
        suggestions: SUGGESTIONS,
    },

    onShow() {
        // 每次进页面都确认登录态，但不自动发请求（这页没有要预加载的数据）
        guard.check(this).catch(() => {});
    },

    onInput(event) {
        this.setData({ draft: event.detail.value });
    },

    onPickSuggestion(event) {
        const text = event.currentTarget.dataset.text;
        if (!text || this.data.sending) return;
        this.send(text);
    },

    onSend() {
        const text = String(this.data.draft || '').trim();
        if (text === '' || this.data.sending) return;
        this.send(text);
    },

    async send(text) {
        const context = await guard.check(this);
        if (!context) return;

        const userMsg = {
            id: 'u-' + Date.now(),
            role: 'user',
            text: text,
            steps: [],
            truncated: false,
        };
        const messages = this.data.messages.concat([userMsg]);

        this.setData({
            messages: messages,
            draft: '',
            sending: true,
            sendingText: '正在想…',
            error: '',
        });

        try {
            // 模型偏好与配菜页共用同一份（存本机，两人各用各的）
            const modelId = modelPref.get('text');
            // 短期记忆：把之前的对话作为纯文本带上去。
            // 只带 user/assistant 的 text，不带 steps —— 工具执行细节由服务端管，
            // 客户端重放只会让模型误以为那些工具已经调过了。
            const history = this.data.messages
                .filter((m) => m && m.text)
                .slice(-10)
                .map((m) => ({
                    role: m.role === 'agent' ? 'assistant' : 'user',
                    content: m.text,
                }));
            const result = await llm.agent({ text: text, model: modelId, history: history });

            const agentMsg = {
                id: 'a-' + Date.now(),
                role: 'agent',
                text: result.answer,
                steps: (result.steps || []).map((step) => ({
                    tool: step.tool,
                    label: labelOf(step.tool),
                    ok: step.ok,
                    retried: step.retried === true,
                    timeText: msText(step.elapsedMs),
                    summary: step.summary,
                })),
                truncated: result.truncated,
                // degraded = 有工具失败但模型仍给了回答。要显式告诉用户
                // 「这次只办成了一部分」，否则他以为全做完了。
                degraded: result.status === 'degraded',
            };

            const next = this.data.messages.concat([agentMsg]);
            this.setData({
                messages: next,
                sending: false,
                sendingText: '',
            });
        } catch (error) {
            const code = (error && error.code) || '';
            let msg = '';
            if (code === 'EMPTY') msg = '说点什么吧';
            else if (code === 'NO_AGENT') msg = '当前模型通道不支持家庭助手，去「我的 → 大模型」切到自建通道';
            else if (code === 'RATE_LIMITED') msg = '问得太快了，等几秒再试';
            else if (code === 'timeout') msg = '这次想了太久，问题拆小一点再问一次';
            else msg = cooking.friendlyMessage(error) || '助手这次没答上来，再试一次';
            this.setData({
                sending: false,
                sendingText: '',
                error: msg,
            });
        }
    },

    onClear() {
        if (this.data.sending) return;
        wx.showModal({
            title: '清空对话？',
            content: '只是清掉这一页的记录，冰箱和菜单都不会动。',
            confirmText: '清空',
            success: (res) => {
                if (res.confirm) this.setData({ messages: [], error: '' });
            },
        });
    },

    // 点结果里的「去这周菜单看看」
    onGoMealPlan() {
        wx.navigateTo({ url: '/pages/meal-plan/meal-plan' });
    },

    onGoFridge() {
        wx.switchTab({ url: '/pages/fridge/fridge' });
    },
});
