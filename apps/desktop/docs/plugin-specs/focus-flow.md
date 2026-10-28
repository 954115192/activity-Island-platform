# Focus Flow（专注节奏）· 插件开发规格

> 交给插件工坊「AI 生成」的实现说明书。可以直接整段粘贴给工坊。
> 契约依据：`docs/plugin-contract.md`（contractVersion 2）。

---

## 1. 一句话定义

一个**在灵动岛上完成的专注计时器**：小岛显示剩余时间，中岛负责"调时长 → 开始 → 计时 → 休息"的全过程，
**专注时长用 Apple 时间选择器那样的滚轮在中岛里当场调**，不进设置表单。

## 2. 做什么 / 不做什么

**做**

- 专注 / 短休息 / 长休息三段循环，默认 25 / 5 / 15 分钟、4 轮后进入长休息。
- 中岛里用**竖向滚轮**（鼠标滚轮 + 上下拖拽 + 键盘）调整专注时长，实时预览。
- 开始 / 暂停 / 继续 / 跳过 / 结束，全部在中岛完成。
- 小岛显示剩余时间与阶段；进行中不消失。
- 到点用 `island.alert()` 提醒；结束后写一条今日记录。
- 大岛显示今日统计、最近记录、节奏预设。

**不做（重要）**

- ❌ 不在控制台设置表单里放"专注时长"输入框 —— 时长就在中岛里调。
- ❌ 不在岛上自己画设置弹窗、遮罩、浮层。
- ❌ 不自己做 hover 缩放、不做外层圆角卡片 / 边框 / 外阴影（外轮廓归宿主）。
- ❌ 不用裸 `setInterval` 轮询（隐藏时会烧 CPU）。
- ❌ 不往插件目录写任何文件（会触发热重载风暴）。

---

## 3. plugin.json（可直接用）

```json
{
  "id": "focus-flow",
  "name": "专注节奏",
  "version": "1.0.0",
  "runtime": "web-app",
  "priority": 60,
  "resident": false,
  "entry": "dist/index.html",
  "small": { "enabled": true, "width": 150, "height": 40 },
  "medium": { "width": 420, "height": 200 },
  "large": { "width": 640, "height": 340 },
  "settings": {
    "fields": [
      { "key": "rounds", "label": "几轮后长休息", "type": "number", "default": 4, "min": 1, "max": 8 },
      { "key": "shortBreak", "label": "短休息（分钟）", "type": "number", "default": 5, "min": 1, "max": 30 },
      { "key": "longBreak", "label": "长休息（分钟）", "type": "number", "default": 15, "min": 5, "max": 60 },
      { "key": "autoStartBreak", "label": "专注结束自动开始休息", "type": "boolean", "default": true },
      { "key": "notifySound", "label": "到点提示音", "type": "boolean", "default": true },
      { "key": "taskLabel", "label": "当前任务名（可留空）", "type": "text", "default": "", "placeholder": "例如：写插件规格" }
    ]
  }
}
```

> 注意：`settings.fields` 里**故意不放"专注时长"**。那个值属于中岛滚轮，存 `island.storage`。

---

## 4. 三种视图

### 4.1 small（150 × 40）—— 一眼看状态

| 状态 | 显示 |
| --- | --- |
| 空闲（今天还没开始） | `专注` + 一个淡色圆点 |
| 进行中（专注） | `24:36` + 细进度条 |
| 进行中（休息） | `休息 04:12`，颜色换成更柔和的绿色 |
| 暂停 | 时间前缀 `⏸`，整体降透明度到 0.7 |

- 整段可点：`island.ui.expand()`（**必须自己挂**，宿主不会代劳）。
- 进行中 `island.ui.setPresence(true)`；完全空闲且今天没有未完成目标时 `setPresence(false)`，不占 mini 条。
- 字号随 `island.metrics().scale` 缩放，不要写死 px 假设。

### 4.2 medium（420 × 200）—— 主战场

分三个子状态，由插件自己切 DOM：

**A. 就绪态（未开始）—— 滚轮选择器**

```text
┌──────────────────────────────────────────────┐
│  专注时长                                     │
│                                              │
│         ┌──────────────────────┐             │
│    22   │                      │             │
│    23   │        25            │  ← 选中带    │
│    24   │                      │             │
│         └──────────────────────┘             │
│                 分钟                          │
│                                              │
│   [ 开始专注 ]        ↓ 滚轮 / 上下拖动调整    │
└──────────────────────────────────────────────┘
```

**B. 运行态（计时中）**

```text
┌──────────────────────────────────────────────┐
│    ● 专注中 · 第 2 / 4 轮                      │
│                                              │
│         ╭──────────────╮                     │
│        ╱    18:42       ╲   ← SVG 进度环      │
│        ╲   写插件规格    ╱                    │
│         ╰──────────────╯                     │
│                                              │
│      [ 暂停 ]   [ 跳过 ]   [ 结束 ]           │
└──────────────────────────────────────────────┘
```

- 进度环：SVG `circle` + `stroke-dasharray`，随剩余时间更新（不要用 canvas，省掉 dpr 换算）。
- 滚轮在运行态**锁定**；长按中间数字 600ms 才解锁回到就绪态（防止误改正在跑的计时）。

**C. 休息态** —— 与运行态同构，标题换成"短休息 / 长休息"，颜色转绿，按钮只有「跳过休息」「结束」。

**D. 完成态** —— 全部轮次结束，显示"今天完成 4 轮 · 100 分钟"，两个按钮：「再来一轮」「查看统计」（进大岛）。

### 4.3 large（640 × 340）—— 回顾

- 左：今日统计（总专注分钟、完成轮数、最长连续专注）。
- 中：最近 7 次专注记录列表（时间、时长、任务名）。
- 右：节奏预设卡片 `25 / 5`、`50 / 10`、`90 / 20`，点一下直接写回滚轮的当前值。
- 底部：「清空今日记录」（两步确认，不用原生 `confirm`）。
- 必须提供 `island.ui.collapse()` 入口（例如右上角「收起」）。

---

## 5. 核心交互：Apple 风格滚轮选择器

这是这个插件的灵魂，请**单独实现成一个可复用组件** `wheel-picker.js`，不要和计时逻辑耦合。

### 5.1 视觉规格

| 项目 | 值 |
| --- | --- |
| 容器 | 宽 200px，高 170px，水平居中，垂直居中偏上 |
| 行高 `ITEM_H` | 34px |
| 可见行 | 5 行（中心 ±2），上下各留一行做淡出 |
| 选中带 | 宽 200px、高 34px、圆角 10px、背景 `rgba(255,255,255,.08)`，上下各 1px `rgba(255,255,255,.10)` 分隔线 |
| 中心行文字 | 28px / 600 |
| ±1 行 | 22px / 500，透明度 .72 |
| ±2 行 | 18px / 500，透明度 .40 |
| 单位文字 | 选中带下方 22px 处，12px，`--island-ink-dim` |
| 上下淡出 | 容器上下各 34px 高的 `linear-gradient(黑色 → 透明)` 遮罩 |

**3D 圆柱感**（关键，苹果那味就在这）：

对每一行，设它相对中心的行偏移 `i`（中心为 0，可为小数）：

```text
ROW_ANGLE = 30°                        // 每行绕 X 轴转多少；苹果大约 25°~35°，从这里调手感
R         = ITEM_H / ROW_ANGLE         // ≈ 65px，圆柱半径（由行高与角步长推出，保证小角度时接近线性）

angle  = i * ROW_ANGLE                 // i=2 时 60°，i=3 时 90°（正好看不见）
y      = R * Math.sin(angle)           // 用 sin 而不是 i*ITEM_H：边缘行会被自然压缩、更贴圆柱
scaleY = Math.cos(angle)               // i=2 压到 0.5，i=3 压到 0
alpha  = 1 - Math.min(1, Math.abs(i) / 2.6)

transform: translateY(y) scaleY(scaleY)
```

> 别用 `angle = i * ITEM_H / R` 配一个大 `R`（例如 170）：那样最外行只压到 `cos(23°)≈0.92`，
> 看着就是普通列表，没有圆柱感。**角度必须按行递增**，最外一行接近 90° 才会"转过去"。

用 **DOM 行 + CSS `transform`** 实现（不要用 canvas），理由：
- 文字清晰，不需要处理 devicePixelRatio；
- 天然支持 `role="spinbutton"` 无障碍；
- 改样式不用重写绘制代码。

行的复用：只渲染 `当前索引 ±6` 的行，其余移除，避免 DOM 无限增长。

### 5.2 数值规格

| 项目 | 值 |
| --- | --- |
| 范围 | 5 – 180 分钟 |
| 步进 | 1 分钟（滚轮细调）；按住 `Shift` 时为 5 分钟粗调 |
| 默认 | 25 |
| 循环 | **不循环**。到 5 或 180 就是硬边界，继续滚有 4px 的橡皮筋阻尼然后弹回（苹果的边界手感） |
| 单位 | 分钟 |

> 只做一列。不要拆成"小时 + 分钟"两列 —— 专注时长以分钟为单位，两列反而难调。

### 5.3 手势规格

**鼠标滚轮**

```js
container.addEventListener('wheel', (event) => {
  event.preventDefault()                      // 必须：否则宿主页面滚动
  // Windows 一格 ≈ 100，触控板是小增量；统一折算成像素
  const delta = event.deltaMode === 1 ? event.deltaY * ITEM_H : event.deltaY
  picker.nudge(-delta * 0.35)                 // 累加进 offset，并记录速度用于惯性
}, { passive: false })
```

- 滚轮是**主输入方式**（用户明确要求）。
- 每一格滚动的视觉位移要明显但不过冲：`offset += delta * 0.35`。
- 停止滚动后按 5.4 吸附。

> ✅ **实测已验证**（`npm run test:wheel`，9/9）：中岛状态下插件页能收到真实滚轮事件、
> `deltaY` 正负与大小都可读、`preventDefault()` 生效（不会穿透去滚宿主页面），
> 且中岛的插件视图正好铺满 `420×200` —— 真实滚轮确实落在插件身上。
> 该测试必须让窗口真实显示：把 `showInactive` 打桩成空操作时，Chromium 不转发
> `WebContentsView` 的 resize，插件页会永远停在初始尺寸，结论就不可信了。

**上下拖拽**

```js
row.addEventListener('pointerdown', (event) => {
  row.setPointerCapture(event.pointerId)      // 拖出元素也能继续收事件
  dragging = true; startY = event.clientY; dragging = true
})
// pointermove: offset = startOffset + (event.clientY - startY)，并记录速度
// pointerup:   dragging = false，带入惯性 → 吸附
```

- 拖拽期间**禁止开始计时**（`pointerdown` 时把开始按钮设为 disabled）。
- 拖拽位移方向：**手指/鼠标向下拖 = 数值变大**（和苹果一致：内容跟着手走，露出上面的更小值）。
- 拖拽结束后 120ms 内忽略按钮点击，避免"甩一下手就误触开始"。

**键盘**（无障碍，也必须做）

| 键 | 行为 |
| --- | --- |
| `↑` / `↓` | ±1 分钟 |
| `PageUp` / `PageDown` | ±5 分钟 |
| `Home` / `End` | 跳到 5 / 180 |
| `Enter` / `Space` | 开始专注 |

### 5.4 物理规格

```text
ITEM_H        = 34
摩擦           v *= Math.pow(0.92, dt * 60)     // 按 dt 归一，60fps 与 120fps 手感一致
停止阈值       |v| < 40 px/s  → 进入吸附
吸附目标       targetIndex = clamp(round(offset / ITEM_H), 0, count - 1)
吸附弹簧       stiffness 180, damping 26        // 临界阻尼，220ms 内落位，不回弹
吸附过程可打断  用户再次滚轮/拖拽 → 立即取消吸附，接管 offset
```

- 用 `requestAnimationFrame` 驱动，但**必须包在 `island.raf(fn)` 里**：岛隐藏时自动暂停，不烧 CPU。
- 动画用「基于时间的积分」，不要写「每帧固定加多少」，否则高刷屏速度翻倍。

### 5.5 提交时机

- 滚轮/拖拽**过程中**：实时更新中心数字（所见即所得）。
- **吸附完成后**才提交：把分钟数写入状态，并**防抖 400ms** 后 `island.storage.set('focusMinutes', value)`。
- 计时开始后立刻锁定；锁定期间滚轮事件直接 `return`。

### 5.6 无障碍

```html
<div class="wheel" role="spinbutton"
     aria-label="专注时长（分钟）"
     aria-valuemin="5" aria-valuemax="180" aria-valuenow="25" tabindex="0">
```

`aria-valuenow` 随提交更新。中心数字加 `aria-live="polite"`（节流到 500ms，别每秒刷屏）。

---

## 6. 状态机

```text
idle ──开始──▶ focusing ──到点──▶ breakReady ──自动/手动──▶ breaking ──到点──▶ idle | longBreak
                 │                    │                        │
                 ├─暂停─▶ paused ──继续──┘                      │
                 └─结束──────────────────────────────────────────┘
```

- `round` 计数在每次 `focusing → 到点` 时 +1。
- `round % rounds === 0` → 下一段是**长休息**，否则短休息。
- 「跳过」：专注中跳过 = 这段不计入统计；休息中跳过 = 直接回 `idle`。

**状态要能被小岛正确反映**：`idle / focusing / paused / breaking` 四种，写在一个 `state.phase` 里。

---

## 7. 计时逻辑（别用 setInterval 累加）

```js
// 存的是"结束时间戳"，不是"剩余秒数"，这样休眠/挂起后回来仍然准确
state.endsAt = Date.now() + minutes * 60_000
state.pausedRemaining = null

island.every(250, () => {
  const remaining = state.pausedRemaining ?? Math.max(0, state.endsAt - Date.now())
  render(remaining)
  if (remaining <= 0 && !state.pausedRemaining) finishSegment()
})
```

- **暂停**：`pausedRemaining = endsAt - Date.now()`，并清空 `endsAt`。
- **继续**：`endsAt = Date.now() + pausedRemaining`。
- 采样 250ms 足够（显示到秒），不要 16ms 刷 DOM。
- **必须用 `island.every()`**，不要裸 `setInterval`：岛隐藏时会自动暂停。
- 从睡眠恢复后，因为存的是绝对时间戳，回来一次就对上，不需要补偿逻辑。

---

## 8. 持久化（`island.storage`）

| key | 内容 |
| --- | --- |
| `focusMinutes` | 中岛滚轮当前值（跨启动保留） |
| `session` | `{ phase, endsAt, pausedRemaining, round }` —— 用于岛重载后恢复 |
| `today` | `{ date: 'YYYY-MM-DD', minutes, rounds, log: [{ at, minutes, task }] }` |

- 启动时读 `today`，**日期不是今天就自动重置**（不要写定时清理任务）。
- `session` 里如果是一段已经过期的专注，启动时判定为"它在你离开时结束了"，计入统计并提示一次，不要静默丢弃。

---

## 9. 提醒与"该不该出现"

- 专注/休息到点：`island.alert({ key: 'focus-flow:done', level: 'info', ttl: 5000 })`。
- 到点时如果岛正被别的插件独占，`alert` 会自动排队（宿主行为），**不要自己尝试抢占**。
- 就绪态且今天还没开始：`island.ui.setPresence(false)`，不占 mini 条。
- 一旦开始：`setPresence(true)`。
- ⚠️ **被摘掉后 `island.every()` 会暂停**，所以"要不要显示"必须由**状态变化时**决定，
  不能靠轮询里判断后调 `setPresence`（那样永远醒不过来）。

---

## 10. 与宿主的边界（硬性规则）

1. `100% × 100%` 自适应；底色透明或纯黑；禁止外层圆角卡片 / 边框 / 外阴影。
2. 颜色、圆角、字体全部用 CSS 变量：`--island-surface / --island-ink / --island-ink-dim / --island-accent / --island-radius / --island-gap / --island-font`。
3. small 段的点击必须自己挂：`onclick → island.ui.expand()`；控制按钮要 `stopPropagation`。
4. 模式切换只认 `island.ui.onModeChange(mode => ...)`（**不是** `island.onModeChange`）。
5. 参数表单和日志由宿主渲染在控制台里；插件只用 `island.log.*` 上报。
6. 需要就地调的控件（就是这个滚轮）画在自己的 medium/large 页面里，**这是契约允许的**。

---

## 11. 已知约束（必须知道，别踩）

- **岛在鼠标移出时会收起**：宿主每 40ms 做一次命中检测，中岛/大岛在鼠标离开且非 sticky 时会收回小岛。
  - 所以**滚轮是主输入**（光标不动，完全不受这条影响），拖拽时尽量在岛内垂直移动（中岛 200px 高，中心上下各约 100px 余量）。
  - 拖拽用 `setPointerCapture`，并且**不要**在位移超过 ±80px 后继续线性放大数值（用阻尼收敛）。
- **插件页会正确 reflow 到中岛尺寸**（实测 `420×200`），所以滚轮坐标、`elementFromPoint`、布局都可以直接按当前 `innerWidth/innerHeight` 算，不需要自己反推缩放。
- 岛隐藏时 `island.raf()` 会暂停，动画接管逻辑要能容忍"下次回来时 offset 还是对的"。
- 插件页 zoom 是按 `file://` origin 共享的，**不要**用 `getBoundingClientRect() × 手算缩放`，用 `island.metrics()` 给的 `scale` / `zoom`。
- `sendInputEvent` 之类的**合成**滚轮会走 Chromium 滚动管线，多个事件的派发顺序不保证；插件必须把每个 `deltaY` 当独立增量处理（规格里就是这么要求的），不要假设成对到达。

---

## 12. 验收清单（每一项都要能跑出来）

**滚轮**

1. 中岛就绪态能看到选中带与 5 行数字，中心行明显更大更亮。
2. 鼠标滚轮向上 → 数值变大，向下 → 变小；每一格位移肉眼可见。
3. 停止滚动后自动吸附到整数行，且**不回弹**。
4. 拖到 5 以下 / 180 以上有阻尼并弹回边界。
5. 上下拖拽同样改数值，方向与苹果一致（向下拖 = 变大）。
6. `↑ ↓ PageUp PageDown Home End` 都能改值。
7. 改完的值在重新打开中岛后还在（跨启动保留）。
8. 计时进行中滚轮无效；长按数字 600ms 才解锁。
9. 拖拽期间「开始专注」不可点；松手 120ms 内点击不生效。

**计时**

10. 计时用绝对时间戳：把系统时间往后调 1 分钟，界面立刻对上。
11. 暂停后 `endsAt` 清空，继续后剩余时间从暂停处接着走。
12. 4 轮后进入长休息（用 `rounds` 参数改成 1 验证）。
13. 小岛在 `focusing / paused / breaking` 三种状态下显示不同内容。

**岛与提醒**

14. 点小岛进中岛（`ui:expand` 自己挂）。
15. 到点触发 `island.alert` 且 `host:intent` 收到 `granted`。
16. 就绪且今天未开始时 `setPresence(false)` 从 mini 条消失；开始后回来。
17. 大岛有 `collapse()` 入口，能回到小岛。

**规矩**

18. 页面无外层圆角卡片 / 边框 / 外阴影（用计算样式断言）。
19. 隐藏 1.5s 内插件 IPC 调用数为 0（证明没有裸 `setInterval`）。
20. 控制台里日志能看到 `island.log` 输出。

---

## 13. 实现建议

```text
focus-flow/
├─ plugin.json
└─ dist/
   ├─ index.html          引用 app.js / wheel-picker.js / style.css
   ├─ style.css           只用 CSS 变量，透明背景
   ├─ wheel-picker.js     ★ 可复用滚轮组件（纯 DOM + CSS transform）
   └─ app.js              状态机 + 计时 + 视图切换 + storage
```

`app.js` 里的职责切分：

```text
state/        状态机与计时（不碰 DOM）
picker/       滚轮组件（不碰计时）
views/        small / medium-ready / medium-running / medium-break / large 五个渲染函数
```

三个视图共享一个 `render(state)` 入口，`onModeChange` 只负责切哪一组 DOM 可见，不要在回调里写业务逻辑。

---

## 14. 需要宿主配合的（可选，先不做）

拖拽期间如果鼠标离开岛，宿主会按规则收起。更稳的做法是宿主提供一个
`island.ui.setInteractionLock(true|false)`：锁住期间不做鼠标移出收起。
这一条**不在本插件范围内**，插件侧先用"滚轮为主 + 拖拽位移阻尼"绕过。
