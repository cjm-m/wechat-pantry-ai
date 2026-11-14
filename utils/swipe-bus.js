// 滑动行实例登记表。
// 两个用途：① 行与行互斥（展开一行时收起其它行）；② 页面在「点其它区域 / 页面滚动」时统一收起。
// 不用 selectAllComponents 做树查询：那需要页面知道行的 class，且每次点击都要遍历组件树。

let rows = [];

function attach(row) {
    if (rows.indexOf(row) < 0) rows.push(row);
    return function detach() {
        const index = rows.indexOf(row);
        if (index >= 0) rows.splice(index, 1);
    };
}

// except 用于「打开某一行时，别把这一行自己也关掉」。
function closeAll(except) {
    rows.slice().forEach((row) => {
        if (row === except) return;
        if (row && typeof row.close === 'function') row.close();
    });
}

module.exports = { attach, closeAll };
