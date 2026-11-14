// 大模型：识图、保质期 / 菜谱各用什么模型，在这一页选。
//
// 选择只存本机（couple_vision_model / couple_cook_model，两人各用各的，不跟账号走）。
// 服务端 /llm/models 返回的目录是兜底：列表顺序就是服务端的默认顺序，
// 列表里没有的模型，选了也不会生效——下次进入按目录重新解析。
//
// 深度思考在识图、保质期、菜谱三类任务上统一固定关闭——它们要的都是结构化 JSON，
// 开了会把首字从约 1.5 秒拖到十几秒（wx.request 上限 60 秒），推理段还可能把 JSON 尾部挤断。
// 这条策略落在服务端（server/llm-proxy.js 的 DEEP_THINKING），页面只读展示，
// 刻意不做成能点的开关：一个点了不生效的开关，比没有开关更糟。

const guard = require('../../utils/auth-guard');
const llm = require('../../utils/llm');
const modelPref = require('../../utils/model-pref');

const GROUP_META = [
    {
        key: 'vision',
        title: '识图模型',
        note: '拍照识别食材用',
        empty: '服务端没配置能看图的模型',
    },
    {
        key: 'text',
        title: '保质期 / 菜谱模型',
        note: '保质期推断、配菜、要买什么用',
        empty: '服务端没配置可用的文本模型',
    },
];

function pickList(result) {
    if (Array.isArray(result)) return result;
    if (result && Array.isArray(result.data)) return result.data;
    return [];
}

// supportsImages 是「能力」不是「分类」：能看图的模型照样能写菜谱、推断保质期，
// 所以识图组只收能看图的，文本组收全部。两组合计会有重叠，这是故意的。
// 服务端 pickModel() 只校验模型在不在目录里，从不按 supportsImages 排除；
// 早期这里把文本组写成 supportsImages !== true，等于让 UI 比服务端更严，
// 用户明明能把 glm 选来写菜谱却选不到。
// 标签按服务端顺序给「默认 / 备位」，因为 pickModel() / pickVisionModel() 取的就是
// 目录里（各自集合的）第一个，顺序即兜底优先级。
// 「使用中」按 resolve 的结果标记，而不是 storage 里的原值：偏好被服务端下架后
// resolve 会回退到该组第一个，页面展示的必须是真实生效的模型。
function buildGroups(models) {
    const usable = models.filter((item) => item && item.disabled !== true);
    // 识图组：只有能看图的才能选；文本组：全部（识图模型也能做文本任务）。
    const visionList = usable.filter((item) => item.supportsImages === true);
    const textList = usable;
    const visionPick = modelPref.resolve(visionList, modelPref.get('vision'));
    const textPick = modelPref.resolve(textList, modelPref.get('text'));

    // 每组独立编号，同一个模型在两组里可以各自是「默认 / 备位」。
    function rowsFor(list, pick) {
        return list.map((item, index) => {
            const selected = item.id === pick;
            const thinkingOn = item.thinkingEnabled === true;
            return {
                id: item.id,
                name: item.name || item.id,
                baseTag: index === 0 ? '默认' : '备位', // 默认 / 备位，供切换时还原
                selected: selected,
                tag: selected ? '使用中' : (index === 0 ? '默认' : '备位'),
                tagClass: selected ? 'tag-soft' : '',
                thinkingOn: thinkingOn,
                thinkingText: thinkingOn ? '深度思考 · 已开启' : '深度思考 · 已关闭',
                thinkingClass: thinkingOn ? 'tag-warn' : 'tag-ok',
            };
        });
    }

    const rows = { vision: rowsFor(visionList, visionPick), text: rowsFor(textList, textPick) };

    return GROUP_META.map((meta) => ({
        key: meta.key,
        title: meta.title,
        note: meta.note,
        empty: meta.empty,
        models: rows[meta.key],
    }));
}

Page({
    data: {
        authState: 'checking',
        loading: true,
        error: '',
        groups: [],
        totalCount: 0,
        allThinkingOff: true,
        saving: false,
    },

    onShow() {
        this.load();
    },

    async load() {
        const context = await guard.check(this);
        if (!context) return;
        await this.reload();
    },

    async reload() {
        this.setData({ loading: true, error: '' });

        let models = [];
        try {
            models = pickList(await llm.models.list());
        } catch (error) {
            // 域名白名单、证书、401 的处置方式完全不同，原样透出比统一压成一句更有用。
            this.setData({
                loading: false,
                groups: [],
                totalCount: 0,
                allThinkingOff: true,
                error: guard.errorText(error),
            });
            return;
        }

        const groups = buildGroups(models);
        // 两组合计有重叠（识图模型也会出现在文本组），去重后再算「可用模型数」，
        // 否则 6 个模型会显示成 10 个。
        const uniqueIds = {};
        groups.forEach((group) => group.models.forEach((item) => { uniqueIds[item.id] = true; }));
        const totalCount = Object.keys(uniqueIds).length;
        const anyThinkingOn = groups.some((group) => group.models.some((item) => item.thinkingOn));

        this.setData({
            loading: false,
            groups: groups,
            totalCount: totalCount,
            allThinkingOff: !anyThinkingOn,
            error: totalCount === 0 ? '服务端没有返回可用模型，稍后再试' : '',
        });
    },

    onRetry() {
        this.reload();
    },

    // 点选模型：写本机 storage → 重算同组选中态 → toast。
    // 与配菜页的 action sheet 写同一个 key，两个入口天然同步。
    onPickModel(event) {
        const dataset = event.currentTarget.dataset;
        const kind = dataset.kind;
        const id = dataset.id;
        if (kind !== 'vision' && kind !== 'text') return;
        if (!id) return;
        if (this.data.saving) return;

        this.setData({ saving: true });
        const persisted = modelPref.set(kind, id);
        this.setData({ saving: false });

        const groups = this.data.groups.map((group) => {
            if (group.key !== kind) return group;
            return Object.assign({}, group, {
                models: group.models.map((model) => {
                    const using = model.id === id;
                    return Object.assign({}, model, {
                        selected: using,
                        tag: using ? '使用中' : model.baseTag,
                        tagClass: using ? 'tag-soft' : '',
                    });
                }),
            });
        });
        this.setData({ groups: groups });
        wx.showToast({
            title: persisted ? '已切换' : '已切换，但没能记住',
            icon: 'none',
        });
    },
});
