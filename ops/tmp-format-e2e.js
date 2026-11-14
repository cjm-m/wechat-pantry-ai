'use strict';
// utils/format.js 的纯函数测试。
// 重点是 amountText —— AI 入库会把「一块」整个写进 quantity、
// 同时 unit 也填「块」，直接拼会变成「一块 块」。

const { amountText } = require('../utils/format.js');

let pass = 0, fail = 0;
const eq = (a, e, m) => {
    const okv = a === e;
    if (okv) { pass++; console.log('  PASS ' + m); }
    else { fail++; console.log('  FAIL ' + m + ' -- 期望 ' + JSON.stringify(e) + '，实际 ' + JSON.stringify(a)); }
};

console.log('\n########## F1 amountText：常规拼接 ##########');
eq(amountText('', ''), '适量', '都空 → 适量');
eq(amountText('2', '个'), '2 个', '2 + 个');
eq(amountText('4', '根'), '4 根', '4 + 根');
eq(amountText('300', 'g'), '300 g', '300 + g');
eq(amountText('2', ''), '2', '只有数量');
eq(amountText('', '袋'), '袋', '只有单位');

console.log('\n########## F2 amountText：数量自带量词，不重复拼 ##########');
eq(amountText('一块', '块'), '一块', '「一块」+「块」不重复');
eq(amountText('一盒', '盒'), '一盒', '「一盒」+「盒」不重复');
eq(amountText('一袋', '袋'), '一袋', '「一袋」+「袋」不重复');
eq(amountText('半把', '把'), '半把', '「半把」+「把」不重复');
eq(amountText('三个', '个'), '三个', '「三个」+「个」不重复');

console.log('\n########## F3 边界：量词不一致也按已有量词处理 ##########');
eq(amountText('一块', '盒'), '一块', '量词冲突时保留原话，不拼出「一块 盒」');
eq(amountText('半', '把'), '半 把', '「半」不是量词结尾，正常拼');

console.log('\n########## F4 空值与空白 ##########');
eq(amountText(null, null), '适量', 'null → 适量');
eq(amountText(undefined, undefined), '适量', 'undefined → 适量');
eq(amountText('  2 ', ' 个 '), '2 个', '两端空白被 trim');

console.log('\n════════════════════════════════════');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail > 0 ? 1 : 0);
