// 展示层的常量与格式化：类别顺序、常见单位、数量文案、相对时间。

const CATEGORIES = [
    { key: '蔬菜', icon: '🥬' },
    { key: '肉蛋', icon: '🍖' },
    { key: '水产', icon: '🐟' },
    { key: '豆制品', icon: '🫘' },
    { key: '乳制品', icon: '🥛' },
    { key: '主食', icon: '🍚' },
    { key: '调料', icon: '🧂' },
    { key: '水果', icon: '🍎' },
    { key: '其他', icon: '🧺' },
];

const CATEGORY_KEYS = CATEGORIES.map((item) => item.key);

const UNITS = ['份', '个', '颗', '把', '根', '斤', '克', '盒', '袋', '瓶', '块', '片', '毫升'];

function categoryIndex(key) {
    const index = CATEGORY_KEYS.indexOf(key);
    return index < 0 ? CATEGORY_KEYS.length - 1 : index;
}

function categoryIcon(key) {
    for (let i = 0; i < CATEGORIES.length; i += 1) {
        if (CATEGORIES[i].key === key) return CATEGORIES[i].icon;
    }
    return '🧺';
}

// 数量文案：都没填时说「适量」。
//
// 需要处理「数量自带量词」这种情况：AI 入库时可能把原话「一块」整个写进
// quantity，同时 unit 也填「块」，直接拼会变成「一块 块」。
// 规则：数量末尾已经带了这个单位（或任意量词）就不再重复拼。
const MEASURE_WORDS = [
    '斤', '两', '克', '千克', '公斤', '个', '根', '块', '盒', '袋', '把', '瓶', '包',
    '颗', '只', '条', '片', '份', '罐', '碗', '杯', '勺', '头', '棵', '株', '串', '枚', '粒', '张',
];

function amountText(quantity, unit) {
    const q = (quantity === null || quantity === undefined) ? '' : String(quantity).trim();
    const u = (unit === null || unit === undefined) ? '' : String(unit).trim();
    if (q === '' && u === '') return '适量';
    if (q === '') return u;
    if (u === '') return q;
    // 数量末尾已经带了量词（一块 / 一盒 / 2 个 / 半把）→ 不再拼单位。
    // 量词不一致时也按「已有量词」处理：拼出来是「一块 盒」这种更怪的结果，
    // 保留用户原话反而更好读。
    for (let i = 0; i < MEASURE_WORDS.length; i += 1) {
        if (q.slice(-MEASURE_WORDS[i].length) === MEASURE_WORDS[i]) {
            return q;
        }
    }
    return q + ' ' + u;
}

function pad(value) {
    return value < 10 ? '0' + value : String(value);
}

// 相对时间，只用于「收藏」列表的辅助信息。
function relativeTime(input) {
    if (!input) return '';
    const time = new Date(input).getTime();
    if (!time) return '';
    const diff = Date.now() - time;
    if (diff < 60 * 1000) return '刚刚';
    if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' 小时前';
    if (diff < 7 * 24 * 60 * 60 * 1000) return Math.floor(diff / 86400000) + ' 天前';
    const date = new Date(time);
    return (date.getMonth() + 1) + '月' + date.getDate() + '日';
}

// 我的 / TA 的：两人场景下比昵称更直观。
function ownerText(ownerId, myId) {
    if (!ownerId || !myId) return '';
    return ownerId === myId ? '我' : 'TA';
}

// ---------- 日期与保质期 ----------

// 本地时区的 YYYY-MM-DD，避免用 toISOString 时差把日期算偏一天。
function todayStr() {
    const now = new Date();
    return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
}

function addDays(dateStr, days) {
    const base = dateStr ? new Date(String(dateStr).slice(0, 10) + 'T00:00:00') : new Date();
    if (isNaN(base.getTime())) return '';
    base.setDate(base.getDate() + (Number(days) || 0));
    return base.getFullYear() + '-' + pad(base.getMonth() + 1) + '-' + pad(base.getDate());
}

// 日期说人话：点菜里用得着（今天 / 明天 / 后天 / 10月28日）。
// 必须拼 T00:00:00 再解析，直接 new Date('2026-10-24') 会按 UTC 算，东八区差一天。
function dayLabel(dateStr) {
    if (!dateStr) return '';
    const target = new Date(String(dateStr).slice(0, 10) + 'T00:00:00');
    if (isNaN(target.getTime())) return '';
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const days = Math.round((target.getTime() - today.getTime()) / 86400000);
    if (days === 0) return '今天';
    if (days === 1) return '明天';
    if (days === 2) return '后天';
    if (days === -1) return '昨天';
    return (target.getMonth() + 1) + '月' + target.getDate() + '日';
}

// 保质期状态：列表里只用一个短标签表达，不喧宾夺主。
function expireInfo(dateStr) {
    if (!dateStr) return null;
    const target = new Date(String(dateStr).slice(0, 10) + 'T00:00:00');
    if (isNaN(target.getTime())) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const days = Math.round((target.getTime() - today.getTime()) / 86400000);
    if (days < 0) return { days: days, text: '已过期', level: 'danger' };
    if (days === 0) return { days: days, text: '今天到期', level: 'warn' };
    if (days <= 2) return { days: days, text: days + ' 天后到期', level: 'warn' };
    if (days <= 7) return { days: days, text: '还剩 ' + days + ' 天', level: 'soon' };
    return { days: days, text: '还剩 ' + days + ' 天', level: 'quiet' };
}

// 金额一律两位小数字符串，合计用分做整数运算规避浮点误差。
function money(value) {
    const cents = Math.round((Number(value) || 0) * 100);
    return (cents / 100).toFixed(2);
}

function cents(value) {
    return Math.round((Number(value) || 0) * 100);
}

module.exports = {
    CATEGORIES,
    CATEGORY_KEYS,
    UNITS,
    categoryIndex,
    categoryIcon,
    amountText,
    relativeTime,
    ownerText,
    pad,
    todayStr,
    addDays,
    dayLabel,
    expireInfo,
    money,
    cents,
};
