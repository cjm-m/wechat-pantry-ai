'use strict';
// M12 营养追踪的离线测试：全部纯函数，零网络、零 DB。
//
// 覆盖三块：
//   1. utils/cooking.js 的 normalizeNutrition —— 模型输出不可信，脏输入必须整条丢弃
//   2. utils/nutrition.js 的 ringPercent / macroRows / fillDays / barRows / summarize
//   3. utils/recipes.js 的 normalizeStepList —— 历史 steps 可能是对象，渲染前必须归一
//
// 跑法：node ops/tmp-nutrition-e2e.js

const cooking = require('../utils/cooking');
const nutrition = require('../utils/nutrition');
const recipes = require('../utils/recipes');

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

function checkTrue(name, ok) {
    if (ok) {
        pass += 1;
        console.log('  PASS ' + name);
    } else {
        fail += 1;
        console.log('  FAIL ' + name);
    }
}

console.log('\n########## A1 normalizeNutrition：正常与文本 ##########');
check('四个数字', cooking.normalizeNutrition({ kcal: 420, protein: 32, carb: 18, fat: 22 }),
    { kcal: 420, protein: 32, carb: 18, fat: 22, approx: true });
check('带「约」和单位', cooking.normalizeNutrition({ kcal: '约 420', protein: '32g', carb: '18', fat: '22 克' }),
    { kcal: 420, protein: 32, carb: 18, fat: 22, approx: true });
// 22.5 → 23：Math.round 是向上取整（不是银行家舍入），这里钉住行为免得以后被改坏
check('小数四舍五入', cooking.normalizeNutrition({ kcal: 419.6, protein: 31.5, carb: 18.4, fat: 22.5 }),
    { kcal: 420, protein: 32, carb: 18, fat: 23, approx: true });

console.log('\n########## A2 normalizeNutrition：别名 ##########');
check('英文别名', cooking.normalizeNutrition({ calories: 500, proteins: 40, carbs: 60, fats: 12 }),
    { kcal: 500, protein: 40, carb: 60, fat: 12, approx: true });
check('中文别名', cooking.normalizeNutrition({ 热量: 500, 蛋白质: 40, 碳水化合物: 60, 脂肪: 12 }),
    { kcal: 500, protein: 40, carb: 60, fat: 12, approx: true });

console.log('\n########## A3 normalizeNutrition：脏输入必须整条丢弃 ##########');
check('null', cooking.normalizeNutrition(null), null);
check('undefined', cooking.normalizeNutrition(undefined), null);
check('数组', cooking.normalizeNutrition([]), null);
check('字符串', cooking.normalizeNutrition('420'), null);
check('缺 fat → 整条丢弃', cooking.normalizeNutrition({ kcal: 420, protein: 32, carb: 18 }), null);
check('缺 kcal → 整条丢弃', cooking.normalizeNutrition({ protein: 32, carb: 18, fat: 22 }), null);
check('非法文本 → 整条丢弃', cooking.normalizeNutrition({ kcal: '不知道', protein: 32, carb: 18, fat: 22 }), null);
check('空对象 → 整条丢弃', cooking.normalizeNutrition({}), null);

console.log('\n########## A4 normalizeNutrition：钳制 ##########');
check('负 kcal 归零', cooking.normalizeNutrition({ kcal: -5, protein: 32, carb: 18, fat: 22 }),
    { kcal: 0, protein: 32, carb: 18, fat: 22, approx: true });
check('超上限钳到 3000/300', cooking.normalizeNutrition({ kcal: 99999, protein: 999, carb: 999, fat: 999 }),
    { kcal: 3000, protein: 300, carb: 300, fat: 300, approx: true });
check('0 是合法值不是缺失', cooking.normalizeNutrition({ kcal: 0, protein: 0, carb: 0, fat: 0 }),
    { kcal: 0, protein: 0, carb: 0, fat: 0, approx: true });

console.log('\n########## A5 normalizeDishes 透传 nutrition ##########');
const parsed = cooking.parseDishes(JSON.stringify({
    dishes: [{
        title: '青椒鸡丝',
        summary: '快手菜',
        used: [{ name: '鸡胸肉', amount: '300g', from_fridge: true }],
        steps: ['鸡胸肉切丝', '青椒切丝后下锅炒 2 分钟'],
        nutrition: { kcal: 380, protein: 34, carb: 12, fat: 20 },
    }],
}));
checkTrue('解析成功且带 nutrition', !!(parsed.dishes && parsed.dishes[0].nutrition));
check('nutrition 四值', parsed.dishes[0].nutrition,
    { kcal: 380, protein: 34, carb: 12, fat: 20, approx: true });

const noNutri = cooking.parseDishes(JSON.stringify({
    dishes: [{ title: '西红柿炒蛋', used: [], steps: ['打蛋', '下锅'] }],
}));
check('模型没给 nutrition → null', noNutri.dishes[0].nutrition, null);

console.log('\n########## A6 ringPercent ##########');
check('75%', nutrition.ringPercent(1500, 2000), 75);
check('超目标钉在 100（环形画不出超过一圈）', nutrition.ringPercent(2500, 2000), 100);
check('0', nutrition.ringPercent(0, 2000), 0);
check('负值归零', nutrition.ringPercent(-100, 2000), 0);
check('goal 为 0 时回落默认目标', nutrition.ringPercent(1000, 0), 50);
checkTrue('ringStyle 含 conic-gradient', nutrition.ringStyle(1000, 2000).indexOf('conic-gradient') >= 0);

console.log('\n########## A7 macroRows ##########');
const macroRows = nutrition.macroRows({ protein: 30, carb: 125, fat: 0 });
check('三条', macroRows.length, 3);
check('蛋白质 30/60', macroRows[0].percent, 50);
check('碳水 125/250', macroRows[1].percent, 50);
check('脂肪 0', macroRows[2].percent, 0);
check('null 输入不炸', nutrition.macroRows(null).length, 3);

console.log('\n########## A8 fillDays ##########');
const today = new Date(2026, 10, 13);   // 2026-11-13
const filled = nutrition.fillDays(
    [{ day: '2026-11-13', kcal: 800, protein: 40, carb: 90, fat: 30, meals: 2, estimated: 2 }],
    3,
    today
);
check('补齐成 3 天', filled.length, 3);
check('第 1 天是 11-11 且为 0', { day: filled[0].day, kcal: filled[0].kcal, meals: filled[0].meals },
    { day: '2026-11-11', kcal: 0, meals: 0 });
check('第 3 天是今天且有数', { day: filled[2].day, kcal: filled[2].kcal }, { day: '2026-11-13', kcal: 800 });
check('空输入也补齐', nutrition.fillDays([], 7, today).length, 7);
check('days 上限 30', nutrition.fillDays([], 999, today).length, 30);

console.log('\n########## A9 barRows ##########');
const bars = nutrition.barRows(filled);
check('三根柱', bars.length, 3);
check('无记录的是 empty', { empty: bars[0].empty, kcal: bars[0].kcal }, { empty: true, kcal: 0 });
check('有记录的不是 empty', bars[2].empty, false);
checkTrue('最高柱接近 100%', bars[2].style.indexOf('100') >= 0);
checkTrue('空柱仍可见（不是 0%）', bars[0].style !== 'height: 0%;');

console.log('\n########## A10 summarize ##########');
const sum = nutrition.summarize(filled);
check('1 个有记录的日子', sum.activeDays, 1);
check('均值 = 当天值', sum.avgKcal, 800);
check('没有缺估算', sum.missing, 0);
checkTrue('文案提到平均', sum.text.indexOf('800') >= 0);

const partial = nutrition.fillDays(
    [{ day: '2026-11-13', kcal: 800, protein: 40, carb: 90, fat: 30, meals: 3, estimated: 1 }],
    2,
    today
);
const sumPartial = nutrition.summarize(partial);
check('3 餐里只有 1 餐有估算', sumPartial.missing, 2);
checkTrue('缺估算必须在文案里说出来', sumPartial.text.indexOf('2 餐没有营养估算') >= 0);

const sumEmpty = nutrition.summarize([]);
check('空数据 empty=true', sumEmpty.empty, true);
check('空数据均值为 0', sumEmpty.avgKcal, 0);
checkTrue('空数据文案不是「0 千卡」这种误导', sumEmpty.text.indexOf('还没有消耗记录') >= 0);

console.log('\n########## A11 todayOf ##########');
check('取最后一个（今天）', nutrition.todayOf(filled).day, '2026-11-13');
check('空数组给零值不炸', nutrition.todayOf([]).kcal, 0);

console.log('\n########## A12 recipes.normalizeStepList ##########');
check('纯字符串原样', recipes.normalizeStepList(['切菜', '下锅']), ['切菜', '下锅']);
check('对象取 text', recipes.normalizeStepList([{ text: '切菜' }, { desc: '下锅' }]), ['切菜', '下锅']);
check('混合', recipes.normalizeStepList(['切菜', { text: '下锅' }, null, '']), ['切菜', '下锅']);
check('JSON 字符串', recipes.normalizeStepList('["切菜","下锅"]'), ['切菜', '下锅']);
check('null', recipes.normalizeStepList(null), []);

console.log('\n########## A13 GOALS 与目标一致性 ##########');
check('每日目标 2000 千卡', nutrition.GOALS.kcal, 2000);
check('三大营养素目标', [nutrition.GOALS.protein, nutrition.GOALS.carb, nutrition.GOALS.fat], [60, 250, 65]);

console.log('\n════════════════════════════════════');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail > 0) process.exit(1);
