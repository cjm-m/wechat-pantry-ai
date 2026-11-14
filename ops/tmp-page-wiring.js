'use strict';
// 页面接线自检：WXML 里每个 bindtap/catchtap 绑定的处理函数，JS 里必须真的存在。
// 这类错误在开发者工具里只会在点击那一刻报 undefined，静态检查能提前发现。
//
// 跑法：node ops/tmp-page-wiring.js

const fs = require('fs');
const path = require('path');

const PAGES = [
    'pages/nutrition/nutrition',
    'pages/cook-mode/cook-mode',
    'pages/recipe-detail/recipe-detail',
    'pages/dish-detail/dish-detail',
    'pages/consumption/consumption',
    'pages/me/me',
    'pages/cook/cook',
    'pages/meal-plan/meal-plan',
];

let pass = 0;
let fail = 0;

function existsInJs(js, name) {
    // 三种写法都算存在：方法简写 `name(`、属性 `name:`、赋值 `name =`
    return new RegExp('(^|[\\s,{])' + name + '\\s*\\(').test(js)
        || new RegExp('(^|[\\s,{])' + name + '\\s*:').test(js)
        || new RegExp('\\b' + name + '\\s*=').test(js);
}

PAGES.forEach((base) => {
    const wxmlPath = base + '.wxml';
    const jsPath = base + '.js';
    if (!fs.existsSync(wxmlPath) || !fs.existsSync(jsPath)) {
        console.log('  SKIP ' + base + '（不存在）');
        return;
    }
    const wxml = fs.readFileSync(wxmlPath, 'utf8');
    const js = fs.readFileSync(jsPath, 'utf8');

    const handlers = [...wxml.matchAll(/(?:bind|catch)[a-z]+="([a-zA-Z0-9_]+)"/g)].map((m) => m[1]);
    const unique = [...new Set(handlers)];
    const missing = unique.filter((name) => !existsInJs(js, name));

    if (missing.length === 0) {
        pass += 1;
        console.log('  PASS ' + path.basename(base) + '（' + unique.length + ' 个处理函数）');
    } else {
        fail += 1;
        console.log('  FAIL ' + path.basename(base) + ' 缺少：' + missing.join(', '));
    }
});

console.log('\n════════════════════════════════════');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail > 0) process.exit(1);
