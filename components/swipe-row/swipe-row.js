// 列表行滑动手势组件：手指朝一侧滑动，露出该侧的操作按钮（默认左滑露出右侧按钮组）。
//
// 布局模型：内容层始终不动，操作区作为不透明抽屉从该侧边缘滑入，覆盖内容尾部。
// 这一点是刻意的——早期把内容整体平移的做法，会让行首的勾选圆点与名称被 overflow 裁掉。
//
// 阈值与动画（单位 px，配置用 rpx，内部按屏宽换算）：
//   AXIS_LOCK_PX     6     位移不足 6px 不做方向判定，保证点击不被吃掉
//   AXIS_PROMOTE_PX  14    起手 14px 内允许把误判的竖向改判为横向，避免一帧抖动让整段手势失效
//   OPEN_RATIO       0.42  闭合态拉过 42% 吸附展开
//   CLOSE_RATIO      0.62  展开态残留不足 62%（即回拖超过 38%）吸附闭合——回滑比展开更容易成功
//   FLICK_VELOCITY   0.35  px/ms（约 350px/s）以上的平均速度按方向直接判定，不再看位移比例
//   FLICK_MIN_PX     18    轻扫判定的最小位移，避免 1~2px 抖动算出虚高速度
//   FLICK_IDLE_MS    120   松手前停顿超过 120ms 视为速度 0，防止「拖住不动再松手」被当成轻扫
//   RUBBER_RATIO     0.32  越界拖动的阻尼系数，MAX_OVERSCROLL_PX 限制最多越界 26px
//   过渡动画            吸附与回弹统一 240ms cubic-bezier(0.22, 0.61, 0.36, 1)，拖动过程中关闭过渡
//
// 同一时刻只允许一行展开：展开时通过模块级注册表把其他行收回去。
// 组件抛 open / close / swipeend / action，页面据此实现「点其它区域或滚动时复位」。

const AXIS_LOCK_PX = 6;
const AXIS_PROMOTE_PX = 14;
const OPEN_RATIO = 0.42;
const CLOSE_RATIO = 0.62;
const FLICK_VELOCITY = 0.35;
const FLICK_MIN_PX = 18;
const FLICK_IDLE_MS = 120;
const RUBBER_RATIO = 0.32;
const MAX_OVERSCROLL_PX = 26;
const RPX_BASE = 750;
// 必须与 wxss 里 .swipe-actions 的 transition-duration 保持一致，
// 动画途中接手指时要靠它换算当前视觉位置。
const DURATION_MS = 240;
const EASE = { x1: 0.22, y1: 0.61, x2: 0.36, y2: 1 };

const swipeBus = require('../../utils/swipe-bus');

// 解算 cubic-bezier：动画进行到一半时被按住，要能算出此刻的真实进度，
// 否则起点会直接取终点值，抽屉出现一次瞬跳（就是「不跟手」的体感来源）。
function bezierAxis(t, p1, p2) {
    const u = 1 - t;
    return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t;
}

function easeProgress(progress) {
    let t = progress;
    for (let i = 0; i < 5; i += 1) {
        const offsetX = bezierAxis(t, EASE.x1, EASE.x2) - progress;
        if (Math.abs(offsetX) < 0.0001) break;
        const slope = 3 * (1 - t) * (1 - t) * EASE.x1
            + 6 * (1 - t) * t * (EASE.x2 - EASE.x1)
            + 3 * t * t * (1 - EASE.x2);
        if (Math.abs(slope) < 0.0001) break;
        t -= offsetX / slope;
        if (t < 0) { t = 0; break; }
        if (t > 1) { t = 1; break; }
    }
    return bezierAxis(t, EASE.y1, EASE.y2);
}

function windowWidth() {
    try {
        if (typeof wx.getWindowInfo === 'function') {
            const info = wx.getWindowInfo();
            if (info && info.windowWidth > 0) return info.windowWidth;
        }
        const legacy = wx.getSystemInfoSync();
        if (legacy && legacy.windowWidth > 0) return legacy.windowWidth;
    } catch (error) {
        // 取不到就用常见屏宽兜底，只影响按钮的像素宽度。
    }
    return 375;
}

function rpxToPx(rpx) {
    const value = Number(rpx) || 0;
    if (value <= 0) return 0;
    return Math.round((value * windowWidth()) / RPX_BASE);
}

// 越界后的阻尼位移，越拉越沉，且不会无限拉长。
function damp(value) {
    return Math.min(value * RUBBER_RATIO, MAX_OVERSCROLL_PX);
}

// right：抽屉在右侧、手指左滑展开；left 相反。
function signOf(side) {
    return side === 'right' ? 1 : -1;
}

// 展开进度（0 = 收起，width = 完全展开）换算成抽屉的横移量：收起时抽屉整个停在边缘外。
function panelOffset(width, revealed, sideSign) {
    const value = Math.round((width - revealed) * sideSign);
    // 归掉 -0，避免写进 style 时出现无意义的负零。
    return value === 0 ? 0 : value;
}

function closeOthers(current) {
    swipeBus.closeAll(current);
}

Component({
    properties: {
        // [{ key, text, tone }]，tone: danger | quiet | primary。数组顺序即按钮从左到右的顺序。
        actions: {
            type: Array,
            value: [{ key: 'delete', text: '删除', tone: 'danger' }],
        },
        // 单个按钮宽度，rpx；操作区总宽度 = 按钮宽度 × 按钮个数。
        actionWidth: { type: Number, value: 120 },
        // right：左滑露出右侧按钮（默认）；left：右滑露出左侧按钮。
        side: { type: String, value: 'right' },
        disabled: { type: Boolean, value: false },
    },

    data: {
        // 展开进度：0 = 收起，actionPx = 完全展开。所有手势判定都用它。
        revealed: 0,
        // 抽屉的 translateX，由 revealed 换算，仅用于渲染。
        panelX: 60,
        dragging: false,
        open: false,
        actionPx: 60,
        maskStyle: 'left: 0; right: 60px;',
    },

    observers: {
        'actions, actionWidth, side': function () {
            this.measure();
        },
    },

    lifetimes: {
        attached() {
            this.detachBus = swipeBus.attach(this);
            this.measure();
        },
        detached() {
            if (this.detachBus) {
                this.detachBus();
                this.detachBus = null;
            }
            this.gesture = null;
        },
    },

    pageLifetimes: {
        hide() {
            this.close();
        },
    },

    methods: {
        measure() {
            const count = Math.max((this.data.actions || []).length, 1);
            const px = rpxToPx(this.data.actionWidth) * count;
            const sideSign = signOf(this.data.side);
            const revealed = this.data.open ? px : 0;
            // 尺寸变了，之前记录的动画轨迹不再有效。
            this.anim = null;
            this.setData({
                actionPx: px,
                // 遮罩只盖内容区：压住抽屉就点不到按钮了。
                maskStyle: sideSign > 0
                    ? 'left: 0; right: ' + px + 'px;'
                    : 'left: ' + px + 'px; right: 0;',
                revealed: revealed,
                panelX: panelOffset(px, revealed, sideSign),
            });
        },

        onTouchStart(event) {
            if (this.data.disabled) return;
            const touch = event.touches && event.touches[0];
            if (!touch) return;
            const now = Date.now();

            // 动画还在跑就被按住：按缓动曲线还原此刻的展开进度，从这里接着跟手，避免瞬跳。
            let startRevealed = this.data.revealed;
            let frozen = false;
            const anim = this.anim;
            if (anim) {
                const elapsed = now - anim.start;
                if (elapsed > 0 && elapsed < DURATION_MS) {
                    const ratio = easeProgress(elapsed / DURATION_MS);
                    startRevealed = Math.round(anim.from + (anim.to - anim.from) * ratio);
                    frozen = true;
                }
                this.anim = null;
            }

            this.gesture = {
                startX: touch.clientX,
                startY: touch.clientY,
                startRevealed: startRevealed,
                startOpen: this.data.open,
                frozen: frozen,
                axis: '',
                // 起手时间与最后一次移动时间：松手时据此算平均速度、并判断手指是否已停住。
                time: now,
                lastMoveTime: now,
            };
            // 拖动期间必须关掉过渡，否则位移会被补间，跟手失准；冻结位置与关过渡同帧提交。
            if (!this.data.dragging || startRevealed !== this.data.revealed) {
                const patch = { dragging: true };
                if (startRevealed !== this.data.revealed) {
                    patch.revealed = startRevealed;
                    patch.panelX = panelOffset(this.data.actionPx, startRevealed, signOf(this.data.side));
                }
                this.setData(patch);
            }
        },

        onTouchMove(event) {
            const gesture = this.gesture;
            if (!gesture || this.data.disabled) return;
            const touch = event.touches && event.touches[0];
            if (!touch) return;

            const dx = touch.clientX - gesture.startX;
            const dy = touch.clientY - gesture.startY;
            gesture.lastMoveTime = Date.now();

            if (gesture.axis !== 'x') {
                const absX = Math.abs(dx);
                const absY = Math.abs(dy);
                if (absX < AXIS_LOCK_PX && absY < AXIS_LOCK_PX) return;

                if (absX > absY) {
                    // 起手抖动可能先把方向判成竖向；只要还在早期（纵向位移未超过 14px）就允许改判，
                    // 否则一次 1~2px 的抖动就会让整段横滑彻底失效。
                    if (gesture.axis === '' || absY < AXIS_PROMOTE_PX) {
                        gesture.axis = 'x';
                        closeOthers(this);
                    } else {
                        return;
                    }
                } else {
                    if (gesture.axis === '') gesture.axis = 'y';
                    return;
                }
            }

            const width = this.data.actionPx;
            const sideSign = signOf(this.data.side);
            // revealed 是展开进度：0 为收起，width 为完全展开；越界同样做阻尼。
            let revealed = gesture.startRevealed - dx * sideSign;
            if (revealed < 0) {
                revealed = -damp(-revealed);
            } else if (revealed > width) {
                revealed = width + damp(revealed - width);
            }
            // 像素没变就不发 setData，减少与视图层的通信次数。
            const next = Math.round(revealed);
            if (next !== this.data.revealed) {
                this.setData({
                    revealed: next,
                    panelX: panelOffset(width, next, sideSign),
                });
            }
        },

        onTouchEnd() {
            const gesture = this.gesture;
            this.gesture = null;
            if (!gesture) return;

            // 先恢复过渡，再让 settle 改位移：分两次提交才能让补间动画生效。
            if (this.data.dragging) this.setData({ dragging: false });
            if (this.data.disabled) return;

            if (gesture.axis !== 'x') {
                // 按住时冻结了动画但没有横滑（纯点击）：把动画接着走完，状态与位移才不会脱节。
                if (gesture.frozen) this.settle(this.data.open);
                return;
            }

            const width = this.data.actionPx;
            const ratio = width > 0 ? this.data.revealed / width : 0;

            // 用整段手势的平均速度而不是最后一帧：单帧位移常只有 1~2px，算出的瞬时速度虚高，
            // 手指轻微抖动就会被误判成轻扫。停住超过 120ms 则直接归零。
            const now = Date.now();
            const idle = now - gesture.lastMoveTime;
            const moved = this.data.revealed - gesture.startRevealed;
            const elapsed = Math.max(1, now - gesture.time);
            const speed = idle > FLICK_IDLE_MS ? 0 : moved / elapsed;
            const flicked = Math.abs(moved) >= FLICK_MIN_PX && Math.abs(speed) >= FLICK_VELOCITY;

            let open;
            if (flicked) {
                // 轻扫按「这次手势往哪边动」判定：回滑就该收起，而不是看残余比例。
                open = speed > 0;
            } else if (gesture.startOpen) {
                // 展开态只要往回拖够 38% 就收起，比展开更容易达成。
                open = ratio > CLOSE_RATIO;
            } else {
                open = ratio >= OPEN_RATIO;
            }

            this.triggerEvent('swipeend', { reveal: this.data.revealed, open: open });
            this.settle(open);
        },

        onActionTap(event) {
            if (this.data.disabled) return;
            const key = event.currentTarget.dataset.key;
            // 点了按钮就先收起来：后续二次确认被取消时，行不会一直半挂在打开状态。
            this.close();
            this.triggerEvent('action', { key: key });
        },

        onMaskTap() {
            this.close();
        },

        close() {
            if (!this.data.open && this.data.revealed === 0) return;
            this.settle(false);
        },

        settle(open) {
            const width = this.data.actionPx;
            const sideSign = signOf(this.data.side);
            const target = open ? width : 0;
            const wasOpen = this.data.open;

            // 以编程方式展开时同样要保证「只有一行是打开的」。
            if (open) closeOthers(this);

            // 记下这段动画的起止与起点时间，供「动画途中被按住」时还原视觉位置。
            this.anim = { from: this.data.revealed, to: target, start: Date.now() };

            if (this.data.dragging) {
                // 先恢复过渡再改位移：两者同一帧提交会被合并，动画不生效。
                this.setData({ dragging: false, open: open }, () => {
                    this.setData({
                        revealed: target,
                        panelX: panelOffset(width, target, sideSign),
                    });
                });
            } else {
                this.setData({
                    open: open,
                    revealed: target,
                    panelX: panelOffset(width, target, sideSign),
                });
            }

            if (open && !wasOpen) this.triggerEvent('open');
            if (!open && wasOpen) this.triggerEvent('close');
        },
    },
});
