'use strict';
// 验证 buildGroups 的分组结果：直接抽取 model-setting.js 里的真实函数源码来跑，
// 而不是另写一份复制品——复制品测不出真文件的错。
const fs = require('fs');
const path = 'pages/model-setting/model-setting.js';
const src = fs.readFileSync(path, 'utf8');

const start = src.indexOf('function buildGroups(models) {');
if (start < 0) { console.error('找不到 buildGroups'); process.exit(1); }
// 从函数起始位置做花括号配平，取出完整函数体
let depth = 0, end = -1, seen = false;
for (let i = start; i < src.length; i += 1) {
    if (src[i] === '{') { depth += 1; seen = true; }
    else if (src[i] === '}') { depth -= 1; if (seen && depth === 0) { end = i + 1; break; } }
}
const fnSrc = src.slice(start, end);

const GROUP_META = [
    { key: 'vision', title: '识图模型', note: '拍照识别食材用', empty: '服务端没配置能看图的模型' },
    { key: 'text', title: '保质期 / 菜谱模型', note: '保质期推断、配菜、要买什么用', empty: '服务端没配置可用的文本模型' },
];

// 真实 model-pref.resolve 语义：偏好在列表里才采用，否则第一个
const modelPref = {
    _pref: { vision: '', text: '' },
    get(kind) { return this._pref[kind] || ''; },
    resolve(list, preferredId) {
        if (!list || list.length === 0) return '';
        const want = String(preferredId || '').trim();
        if (want !== '' && list.some((item) => item.id === want)) return want;
        return list[0].id;
    },
};

const buildGroups = new Function('modelPref', 'GROUP_META', fnSrc + '\nreturn buildGroups;')(modelPref, GROUP_META);

const MODELS = [
    { id: 'Tark1/deepseek-v4-flash', name: 'Tark1/deepseek-v4-flash', supportsImages: false },
    { id: 'Free-glm-4.6v-flash', name: 'Free-glm-4.6v-flash', supportsImages: true },
    { id: 'Free-mimo-v2.6-flash', name: 'Free-mimo-v2.6-flash', supportsImages: true },
    { id: 'SiliconFlow/Qwen3-VL-30B-A3B-Instruct', name: 'SiliconFlow/Qwen3-VL-30B-A3B-Instruct', supportsImages: true },
    { id: 'mimo-v2.6-flash', name: 'mimo-v2.6-flash', supportsImages: true },
    { id: 'sensenova-6.8-flash-lite', name: 'sensenova-6.8-flash-lite', supportsImages: true },
];

function show(groups, label) {
    console.log('===== ' + label + ' =====');
    groups.forEach((g) => {
        console.log('[' + g.title + '] ' + g.models.length + ' 个');
        g.models.forEach((m) => console.log('   ' + (m.tag === '使用中' ? '●' : '○') + ' ' + m.name.padEnd(40) + m.tag));
    });
    const ids = new Set();
    groups.forEach((g) => g.models.forEach((m) => ids.add(m.id)));
    console.log('去重后模型数 = ' + ids.size);
}

show(buildGroups(MODELS), '默认（无偏好）');

// 关键回归：把 glm（识图模型）选作文本模型，必须能生效
modelPref._pref.text = 'Free-glm-4.6v-flash';
const g2 = buildGroups(MODELS);
show(g2, '文本偏好 = Free-glm-4.6v-flash（识图模型当文本用）');
const textGroup = g2.find((g) => g.key === 'text');
const glmRow = textGroup.models.find((m) => m.id === 'Free-glm-4.6v-flash');
console.log(glmRow && glmRow.selected ? '✅ 识图模型可以被选为文本模型' : '❌ 仍然选不上');

// 识图偏好独立于文本偏好
modelPref._pref.vision = 'mimo-v2.6-flash';
const g3 = buildGroups(MODELS);
const vGroup = g3.find((g) => g.key === 'vision');
const mimoRow = vGroup.models.find((m) => m.id === 'mimo-v2.6-flash');
const textStill = g3.find((g) => g.key === 'text').models.find((m) => m.id === 'Free-glm-4.6v-flash');
console.log(mimoRow && mimoRow.selected ? '✅ 识图偏好独立生效' : '❌ 识图偏好失效');
console.log(textStill && textStill.selected ? '✅ 文本偏好未受识图偏好影响' : '❌ 文本偏好被识图偏好覆盖');

// 边界：全部模型都不支持识图时，识图组应为空而不是报错
const noVision = MODELS.filter((m) => !m.supportsImages);
const g4 = buildGroups(noVision);
console.log('全无识图能力时识图组数量 = ' + g4.find((g) => g.key === 'vision').models.length
    + (g4.find((g) => g.key === 'vision').models.length === 0 ? ' ✅' : ' ❌'));

// 边界：空列表
const g5 = buildGroups([]);
console.log('空目录时两组数量 = ' + g5.map((g) => g.models.length).join('/') + (g5.every((g) => g.models.length === 0) ? ' ✅' : ' ❌'));

// 边界：disabled 模型要被过滤掉
const withDisabled = MODELS.concat([{ id: 'dead-model', supportsImages: true, disabled: true }]);
const g6 = buildGroups(withDisabled);
const hasDead = g6.some((g) => g.models.some((m) => m.id === 'dead-model'));
console.log(hasDead ? '❌ disabled 模型没被过滤' : '✅ disabled 模型被过滤');
