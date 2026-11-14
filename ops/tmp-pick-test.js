'use strict';
// 抽取 model-setting.js 里真实的 buildGroups + onPickModel 源码来跑，
// 验证「选中项迁移」：选别的表项时，原来那项必须回到初始状态（默认/备位）。
const fs = require('fs');
const src = fs.readFileSync('pages/model-setting/model-setting.js', 'utf8');

function extract(sig) {
    const start = src.indexOf(sig);
    if (start < 0) throw new Error('找不到 ' + sig);
    let depth = 0, end = -1, seen = false;
    for (let i = start; i < src.length; i += 1) {
        if (src[i] === '{') { depth += 1; seen = true; }
        else if (src[i] === '}') { depth -= 1; if (seen && depth === 0) { end = i + 1; break; } }
    }
    return src.slice(start, end);
}

const GROUP_META = [
    { key: 'vision', title: '识图模型', note: '', empty: '' },
    { key: 'text', title: '保质期 / 菜谱模型', note: '', empty: '' },
];
const modelPref = {
    _pref: { vision: '', text: '' },
    get(k) { return this._pref[k] || ''; },
    resolve(list, want) {
        if (!list || !list.length) return '';
        const w = String(want || '').trim();
        if (w && list.some((i) => i.id === w)) return w;
        return list[0].id;
    },
    set(k, id) { this._pref[k] = id; return true; },
};

const buildGroups = new Function('modelPref', 'GROUP_META', extract('function buildGroups(models) {') + '\nreturn buildGroups;')(modelPref, GROUP_META);

const pickBody = extract('onPickModel(event) {');
// onPickModel 用到 this.data / this.setData / wx.showToast
const sandbox = { setData(obj) { Object.assign(this.data, obj); }, data: { saving: false, groups: [] } };
const fnSrc = 'function ' + pickBody + String.fromCharCode(10) + 'return onPickModel;';
const onPickModel = new Function('wx', 'modelPref', fnSrc)(
    { showToast() {} }, modelPref
).bind(sandbox);

const MODELS = [
    { id: 'Tark1/deepseek-v4-flash', name: 'Tark1/deepseek-v4-flash', supportsImages: false },
    { id: 'Free-glm-4.6v-flash', name: 'Free-glm-4.6v-flash', supportsImages: true },
    { id: 'Free-mimo-v2.6-flash', name: 'Free-mimo-v2.6-flash', supportsImages: true },
    { id: 'mimo-v2.6-flash', name: 'mimo-v2.6-flash', supportsImages: true },
];

let fails = 0;
function ok(cond, msg) { console.log((cond ? '✅ ' : '❌ ') + msg); if (!cond) fails += 1; }

sandbox.data.groups = buildGroups(MODELS);
const vision0 = sandbox.data.groups[0].models;
ok(vision0[0].tag === '使用中' && vision0[1].tag === '备位', '初始：glm 使用中、Free-mimo 备位');

// 选 Free-mimo 为识图模型
sandbox.data.saving = false;
onPickModel({ currentTarget: { dataset: { kind: 'vision', id: 'Free-mimo-v2.6-flash' } } });
let v = sandbox.data.groups[0].models;
ok(v[0].selected === false && v[0].tag === '默认', '切走后 glm 回到「默认」（初始状态）');
ok(v[0].tagClass === '', '切走后 glm 的 tagClass 清空');
ok(v[1].selected === true && v[1].tag === '使用中', 'Free-mimo 变成使用中');
ok(v[2].tag === '备位', '未参与的项保持备位');

// 再选 mimo
onPickModel({ currentTarget: { dataset: { kind: 'vision', id: 'mimo-v2.6-flash' } } });
v = sandbox.data.groups[0].models;
ok(v[1].selected === false && v[1].tag === '备位', 'Free-mimo 回到「备位」（初始状态）');
ok(v[2].selected === true && v[2].tag === '使用中', 'mimo 变成使用中');
ok(v.filter((m) => m.selected).length === 1, '任何时候同组只有一个使用中');

// 文本组不受识图选择影响
const t = sandbox.data.groups[1].models;
ok(t[0].tag === '使用中', '文本组仍是 deepseek-v4 使用中，未被识图选择影响');

// 选回默认项
onPickModel({ currentTarget: { dataset: { kind: 'vision', id: 'Free-glm-4.6v-flash' } } });
v = sandbox.data.groups[0].models;
ok(v[0].selected === true && v[0].tag === '使用中', '选回 glm → 使用中');
ok(v[2].tag === '备位', 'mimo 回到备位');

console.log(fails === 0 ? '\n全部通过' : '\n失败 ' + fails + ' 项');
process.exit(fails === 0 ? 0 : 1);
