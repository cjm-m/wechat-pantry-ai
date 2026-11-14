'use strict';
// M11 烹饪模式计时器的离线测试：纯函数，零网络。
//
// 重点在 parseDuration —— 它从中文步骤文字里抽时长，是所有真实步骤文本喂进来的。
// 抽错一个数量级（1 小时 → 1 分钟）比抽不到更糟：用户会信计时器。
//
// 跑法：node ops/tmp-cook-mode-e2e.js

const { parseDuration, formatClock, parseNumber } = require('../utils/step-timer');

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        pass += 1;
        console.log('  PASS ' + name);
    } else {
        fail += 1;
        console.log('  FAIL ' + name + '\n    期望 ' + e + '\n    实际 ' + a);
    }
}

console.log('\n########## B1 parseNumber：阿拉伯与中文数字 ##########');
check('阿拉伯 15', parseNumber('15'), 15);
check('中文 三', parseNumber('三'), 3);
check('中文 两（口语）', parseNumber('两'), 2);
check('半', parseNumber('半'), 0.5);
check('一刻', parseNumber('一刻'), 15);
check('十', parseNumber('十'), 10);
check('十五', parseNumber('十五'), 15);
check('二十', parseNumber('二十'), 20);
check('二十五', parseNumber('二十五'), 25);
check('非数字', parseNumber('一会儿'), null);
check('空串', parseNumber(''), null);

console.log('\n########## B2 parseDuration：真实步骤文本 ##########');
check('中火翻炒 1 分钟', parseDuration('中火下肉沫翻炒 1 分钟至变色散开'), 60);
check('焯水 30 秒', parseDuration('水开后下西兰花焯水 30 秒捞出过凉'), 30);
check('小火炖半小时', parseDuration('转小火炖半小时至软烂'), 1800);
check('炖 1 小时', parseDuration('加盖炖 1 小时'), 3600);
check('炖一小时（中文）', parseDuration('加盖炖一小时'), 3600);
check('腌 15 分钟', parseDuration('加料酒生抽腌 15 分钟'), 900);
check('煮 2 分半写法（分钟）', parseDuration('煮 2 分钟'), 120);
check('小火焖十分钟', parseDuration('小火焖十分钟'), 600);
check('大火收汁 3 分钟', parseDuration('大火收汁 3 分钟即可'), 180);

console.log('\n########## B3 优先级：小时必须先于分钟匹配 ##########');
// 这条是回归测试：如果先匹配「分钟」，从「1 小时」里一个都匹配不到，
// 但「1 小时 30 分钟」会被匹配成 30 分钟 —— 少数一个数量级。
check('1 小时 30 分钟 → 1 小时优先', parseDuration('炖 1 小时 30 分钟'), 3600);
check('2 小时', parseDuration('烤 2 小时'), 7200);

console.log('\n########## B4 第一个时长优先 ##########');
check('先焯 30 秒再炖 20 分钟 → 取 30 秒', parseDuration('先焯水 30 秒，再炖 20 分钟'), 30);

console.log('\n########## B5 没有时长 ##########');
check('空串', parseDuration(''), 0);
check('null', parseDuration(null), 0);
check('纯动作没有时间', parseDuration('把青椒切成细丝'), 0);
check('只有火候没有时间', parseDuration('大火爆炒至断生'), 0);
// 「一分钟也不要停」这种口语里带数字但不是时长的，宁可按 1 分钟处理（保守无害）
check('口语「一分钟」', parseDuration('一分钟也不要停地翻炒'), 60);

console.log('\n########## B6 formatClock ##########');
check('0 秒', formatClock(0), '00:00');
check('30 秒', formatClock(30), '00:30');
check('90 秒', formatClock(90), '01:30');
check('3600 秒', formatClock(3600), '60:00');
check('负数归零', formatClock(-5), '00:00');
check('小数四舍五入', formatClock(59.6), '01:00');
check('null', formatClock(null), '00:00');

console.log('\n########## B7 边界一致性 ##########');
// 每个识别出的时长都必须能被 formatClock 无歧义地显示回来
const samples = ['炒 1 分钟', '炖半小时', '焯 30 秒', '烤 2 小时', '焖十分钟'];
samples.forEach((text) => {
    const seconds = parseDuration(text);
    const clock = formatClock(seconds);
    const back = clock.split(':');
    const total = Number(back[0]) * 60 + Number(back[1]);
    check('往返一致：' + text, total, seconds);
});

console.log('\n════════════════════════════════════');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail > 0) process.exit(1);
