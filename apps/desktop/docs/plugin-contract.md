# 插件 ↔ 灵动岛 契约 v2（决策版）

本文是**插件与宿主之间唯一的接口事实源**。视觉细则见 `docs/plugin-requirements.md`，进程/窗口模型见 `docs/architecture.md`。
v1 只列了"缺什么"，v2 把**该怎么做决定**写死，可直接照着实现。

图例：✅ 已实现 ｜ ⚠️ 部分 ｜ ❌ 待实现 ｜【待点头】= 产品口味决策，可推翻

## 0. 设计立场（五条不再讨论的前提）

1. **宿主是唯一仲裁者，插件只声明意图。**
   插件永远不说"现在展开/现在显示我"，只说 `ambient`（我是常驻成员）/ `alert`（我要提醒一下）/ `focus`（我要独占展开）。
   宿主决定结果并回执。这样"勿扰、全屏游戏、低电量、用户在拖拽"这类全局策略才能由宿主统一实施，插件不需要知道任何上下文。

2. **mini 条是宿主排版的一行，插件只是其中一段。**
   宽度、padding、分隔线、缩放、溢出策略全部归宿主。插件只声明"我需要多宽"。

3. **契约做成"默认就对"的 SDK，而不是文档里的君子协定。**
   凡是"插件应该…"（隐藏时停止轮询、缩放变化时重算画布、跟随主题色），SDK 都要提供开箱即用的默认实现（`sdk.every()`、`sdk.onVisible()`、`sdk.canvas()`），让守约比违约更省事。

4. **只做单向事件 + 请求/回执，不做同步 RPC，不做插件间直接调用。**
   插件之间只能通过宿主转发的命名空间事件通信，避免死锁、权限扩散和"插件 A 依赖插件 B 存在"。

5. **岛上不做模板渲染。**
   宿主不提供 `metric/list/media` 这类岛上 UI 模板（那是另一套产品路线）。宿主只提供**表层 token + 裁剪 + 排版**，UI 由插件自己画。
   例外：控制台「插件详情 → 工具」页的数据视图由宿主渲染（`tools[].view`），它只存在于设置窗口，不进入岛上，也不改变插件自己的 small/medium/large 渲染方式。

## 1. 模型

```text
Island（宿主）                       Plugin（插件）
├─ mode:   idle | compact | expanded | detail | custom
├─ 排版:   mini 条 = [段(plugin) ...]        ← 插件声明宽度/优先级
├─ 意图:   ambient | alert | focus           ← 插件声明，宿主仲裁
└─ 策略:   勿扰 / 全屏独占 / 用户操作优先      ← 宿主独有，插件不可见
```

三种意图的语义（**这是契约的心脏**）：

| 意图 | 声明方式 | 宿主保证 | 宿主不保证 |
|---|---|---|---|
| `ambient` | manifest `resident: true` + `small.enabled` | 常驻 mini 条，用户启用的成员一定在 | 不会被用户拖出/停用 |
| `alert` | `plugin.alert({ key, level, ttl, badge })` | 全条临时覆盖一次提醒，`ttl` 后恢复 | 一定立刻显示（可能被勿扰/队列推后） |
| `focus` | `plugin.focus({ view: 'medium'\|'large', reason })` | 独占展开；被拒/被抢占一定有回执 | 一定成功（可能排队或拒绝） |

**上岛方式由用户最终决定**（✅ 控制台插件页）：

- `manifest.resident` 只是**默认值**；用户可以在插件详情里改成「常驻岛上 / 仅提醒 / 关闭」。
- 只有「常驻」的插件会占 mini 条；「仅提醒」的插件不占条，只在 `alert` / `focus` 时出现。
- `small.enabled: false` 的插件没有小岛视图，只能「仅提醒」或「关闭」。
- 用户选择存 `<userData>/settings.json` 的 `pluginModes: { [id]: 'resident' | 'alert' }`；关闭仍用 `disabledPlugins`。
- 升级迁移：旧版本没有 `pluginModes` 时，宿主会把已有插件的模式写成常驻，保持升级前 mini 条行为；之后新装的插件才按 `manifest.resident` 默认（`false` = 仅提醒）。

【待点头】**alert 采用"整条覆盖"而不是"插入一段"**：插入一段会让 mini 条所有段位移 + 整条宽度动画，视觉噪声大、实现复杂；覆盖式（宿主记住被覆盖的 ambient 集合，alert 结束后原样恢复）用同样的动画骨架就能做，且"提醒"本来就该打断当前信息。

**覆盖态的画面就是插件自己的 small 视图**：宿主只消费 alert 参数里的 `key / level / ttl`（决定排队、光晕颜色、停留时长），`title / content / message` 等其它字段宿主一概不渲染。插件必须在调 `island.alert()` 之前把要给用户看的文字画进 small 视图的 DOM，否则用户看到的是空胶囊。

## 2. 握手、版本与能力

`plugin.json` 新增：

```json
{
  "contract": 2,
  "minHostVersion": "0.2.0",
  "capabilities": [{ "name": "process", "scripts": ["resources/listener.ps1"] }],
  "settings": "dist/settings.html"
}
```

插件启动后第一件事是握手（SDK 自动做）：

```ts
// 宿主 → 插件
host:hello {
  contractVersion: 2,            // 宿主支持的契约版本
  hostVersion: '0.2.0',
  capabilities: ['process','notify','media','launch'],   // 宿主允许的能力集
  theme: { surface, ink, inkDim, accent, radius, gap, font, dark }
}
```

插件侧也可以反向握手：`await window.dynamicIsland.ready` 拿到同一份载荷（preload 里的 `plugin:hello` invoke）。页面脚本可能早于宿主推送 `host:hello` 运行，所以推荐直接用 `ready`／`onHello`。

规则：
- 插件按 `contractVersion` 降级（版本 < 自己需要的 → 只能使用公共子集）。
- 插件声明的能力若不在宿主 `capabilities` 里，对应 API 调用返回 `{ ok:false, error:'capability-not-granted' }`，**不抛异常**。
- 契约升级走"新增字段 + 保留旧字段至少一个大版本"，禁止改语义。

## 3. 宿主 → 插件

| 消息 | 载荷 | 时机 | 状态 |
|---|---|---|---|
| `host:hello` | 见上 | 每次页面加载 | ❌ |
| `host:mode` | `{ mode }` | small/medium/large 切换 | ✅ |
| `host:visibility` | `{ visible, reason: 'mini'\|'expanded'\|'hidden'\|'obscured', rendering? }` | 该插件在岛上出现/消失、岛被收起、被别的插件展开顶掉；收起时可 `visible:false, rendering:true` 继续预热 | ❌ |
| `host:metrics` | `{ scale, zoom, dpr, width, height }` | miniScale / zoom / 尺寸变化 | ❌ |
| `host:theme` | 同 hello.theme | 主题变化（浅色、强调色） | ❌ |
| `host:intent` | `{ kind:'alert'\|'focus', result:'granted'\|'queued'\|'denied'\|'expired'\|'dismissed'\|'preempted', key?, reason? }` | 意图回执 | ✅ |
| `host:event` | `{ name, payload }` | 跨插件事件，**以及该插件自己后台脚本 stdout 的事件**（`type` 就是 name） | ✅ |
| `host:tool-action` | `{ toolId, actionId }` | 用户点了控制台「工具」页里插件声明的按钮；插件执行后调 `island.tools.set()` 推新数据 | ✅ |
| `host:lifecycle` | `{ event: 'suspend'\|'resume'\|'unload' }` | 休眠/唤醒/卸载前 | ❌ |

`visible` 表示插件内容是否真的显示在岛上；`rendering` 表示宿主是否允许 SDK 的 `every()`、`raf()` 与 canvas 继续更新。收起为顶部触发条时，预热的小视图可收到 `visible:false, reason:'obscured', rendering:true`：页面被裁剪但持续渲染，鼠标移入时直接随岛展开。其它隐藏情形为 `rendering:false`，SDK 自动暂停；旧宿主未发送 `rendering` 时按 `visible` 处理。插件若需判断是否真的在岛上，仍用 `visible`，不要用 `rendering` 代替。

### 后台脚本（`background.entry`，✅ 已实现）

```json
"background": { "entry": "resources/listener.ps1" }
```

- 入口在 `plugin.json` 里声明，**不声明就不会启动**（最常见的"插件一直检测不到数据"就是这个原因）。
- `.ps1` 用 `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File` 启动（Windows PowerShell 5.1，**不是** pwsh 7，WinRT interop 只在 5.1 有）；`.js` 用 Electron 自带的 node 跑。
- stdout **每行一个 JSON**：`{"type":"<事件名>", …}` → 宿主发 `host:event { name: type, payload: 整行对象 }` 给**该插件自己**（同时广播给别的插件做观察）。不是 JSON 的行按 `runtime:log` 落日志；stderr 落日志；进程退出发 `runtime:exit`。
- 脚本**不要往插件目录写文件**：插件目录被文件监听盯着，按秒改写会触发每秒一次的热重载（宿主已忽略 `state.js` / `state.json` / `.tmp` 等运行时文件，但别依赖它）。
- stdin 不转发、退出不自动重启；控制类操作走 `island.media.command()` 或让脚本按需自己执行。
- 宿主把该插件当前参数以环境变量 `ISLAND_PLUGIN_SETTINGS`（JSON 字符串）注入子进程；保存参数会重启后台脚本，脚本在启动时读一次即可。
- 宿主同时注入 `ISLAND_PLUGIN_DATA`（该插件 storage 目录，`plugin:storage` 读写的就是这里的 `<id>.json`）。需要"视图 → 后台"的控制通道时，约定信箱模式：视图 `island.storage.set('cmd', …)` 写命令，后台脚本轮询这个文件执行，结果走 stdout 事件推回（信箱里放自增 `seq` 防止重放旧命令；脚本启动时把已有 `seq` 记为基线，跳过热重载前残留的命令）。

### 使用说明（`guide`，✅ 已实现）

```json
"guide": {
  "summary": "给脚本/CI 用的通知入口：向本机端口 POST 一条 JSON，岛上就弹提醒。",
  "requires": ["插件已启用（后台监听随插件启动）"],
  "setupRequired": true,
  "steps": [
    { "title": "确认监听端口", "text": "默认 {{port}}。", "actions": [{ "kind": "settings", "label": "打开参数" }] },
    { "title": "发送一条通知", "code": "curl -X POST http://127.0.0.1:{{port}}/ -d '{\"title\":\"完成\"}'" }
  ],
  "troubleshooting": [
    { "problem": "端口被占用", "text": "换端口并保存。", "actions": [{ "kind": "logs", "label": "查看日志" }] }
  ],
  "links": [{ "label": "打开系统设置", "url": "ms-settings:notifications" }]
}
```

- 由宿主在控制台渲染：**插件名 → 详情 →「说明」页**；不占用岛上空间（按需插件没数据时不可见，说明放岛上用户到不了）。
- `{{key}}` 替换成该插件当前的参数值，命令/地址跟着用户配置变。
- `actions` 只支持 `settings` / `logs` / `reload`（前两个切到详情抽屉对应页）；`links` 只放行 `https:` 与 `ms-settings:`。
- 纯文本 + 结构，不支持 HTML / 自由 Markdown；`code` 会带「复制」按钮。
- `setupRequired: true` 标记「装完还需要配置」，用于后续的待配置提示。

### 控制台工具（`tools`，✅ 已实现）

`tools` 只用于控制台「插件详情 → 工具」页：插件声明**数据视图 + 按钮**，宿主负责渲染和转发点击。它不是岛上 UI 模板，不会改变上岛方式。

```json
"description": "CPU、内存、网速常驻扫读",
"icon": "脉",
"tools": [
  {
    "id": "snapshot",
    "title": "最近 5 分钟",
    "description": "CPU / 内存 / 网速采样",
    "icon": "chart",
    "view": {
      "type": "stats",
      "items": [
        { "label": "CPU", "value": "48%" },
        { "label": "内存", "value": "61%", "tone": "warn" }
      ],
      "spark": [42, 48, 39, 51, 45]
    },
    "actions": [
      { "id": "diag", "label": "复制诊断", "icon": "copy" },
      { "id": "export", "label": "导出 CSV", "icon": "download", "primary": true },
      { "id": "clear", "label": "清空历史", "icon": "trash", "tone": "danger" }
    ]
  }
]
```

视图类型：

- `stats`：`items[{label,value,tone?}]` + 可选 `spark: number[]`
- `list`：`items[{name,meta?,tone?:'bad'}]`
- `focus`：`{ value, note?, rounds?, done? }`
- `media`：`{ track, source?, progress? }`
- `text`：`{ text }`

规则：

- `description` / `icon` 也用于控制台列表：`icon` 只放**单个字符或 Emoji**，不要放 HTML/SVG。
- 清单里的 `view` 是首帧兜底；实时数据由插件推送，宿主会保留到下次重载：
  ```js
  island.tools.set('snapshot', { view: { type: 'stats', items: [...] } })
  island.tools.set('snapshot', { notice: '后台脚本已退出，以下是上次数据' })
  island.tools.set('snapshot', { notice: null }) // 清除提示
  ```
- 按钮点击只发 `host:tool-action { toolId, actionId }`，不会自动执行任何东西；插件用 `island.tools.onAction(({toolId, actionId}) => …)` 接收，执行完再 `tools.set()` 更新视图。
- `tone:'danger'` 在控制台需要点两次确认；插件关闭时宿主禁用所有按钮，但保留上次数据。
- `tool.panel: true` 会在卡片右下角显示「打开完整面板」，只有 `settings` 为自定义面板路径时才出现；复杂管理界面继续放面板。
- 工具按钮与参数分工：**长期设置**放 `settings.fields`；**读一次数据 / 触发一次操作**放 `tools`。

## 4. 插件 → 宿主

| 命令 | 载荷 | 回执 | 状态 |
|---|---|---|---|
| `ui:expand` | — | `host:intent(granted/denied)` | ✅ 用户点击即"用户操作"，直接抢占。**small 段上的点击由插件自己挂**（`onclick → island.ui.expand()`）：mini 条状态→medium，已是 medium 且属于自己→large；宿主不会代劳，漏了就是"点插件没反应" |
| `ui:collapse` | — | — | ✅ 语义＝"回到 mini 段" |
| `ui:close` | — | `host:intent(alert: dismissed)` | ✅ 语义＝"我这条显示结束"：先撤自己的提醒，否则按收起处理 |
| `ui:request-size` | `{ width, height }` | `size:accepted/rejected{ reason }` | ⚠️ 已有，缺回执与 mini 支持 |
| `ui:presence` | `true\|false` | 无（`host:visibility` 跟着变） | ✅ SDK：`island.ui.setPresence(bool)`。false = "我现在没内容，别占着 mini 条"（例如没有正在播放的媒体）→ 宿主把它摘掉并重排，全部插件都没内容时整条退回待机。浮动模式会在它有内容时把横条恢复出来；收起模式不主动弹出（下次 hover 自然带上）。**被摘掉后 `island.every()` 会暂停，所以"该不该出现"必须由事件驱动（后台脚本 / 宿主推送），不能靠轮询** |
| `ui:hold` / `ui:release` | `{ reason }` | — | ❌ 引用计数，锁住"不要收起"（对应宿主内部 sticky） |
| `alert` | `{ key, level:'info'\|'warn'\|'critical', ttl, badge, color }` | `host:intent` | ✅ 整条覆盖显示，队列 3，同 key 覆盖；`color`（#RGB/#RRGGBB/#RRGGBBAA）自定义光圈颜色，点提醒展开的中岛继续显示该光圈 |
| `focus` | `{ view:'medium'\|'large', reason }` | `host:intent` | ✅ 独占展开，队列 1，可被用户操作抢占 |
| `media:command` | `'previous'\|'toggle'\|'next'` | — | ✅ SDK 是 `island.media.command(action)`；宿主注入全局媒体键，**所有播放器都认**，插件不必自带后台脚本 |
| `tools:set` | `[toolId, { view?, notice? }]` | 控制台实时收到 | ✅ SDK：`island.tools.set(toolId, patch)`；只允许更新清单里声明过的工具，`notice:null` 清除提示 |
| `log` | `{ level, message }` | — | ❌（建议落地到日志文件） |

旧事件名 `ui:show` / `activity` 已收敛为 `alert({ key:name, level:'info', ttl:4000 })`（现状 ✅）。

保留字（插件不得占用事件名）：`activity`、`ui:*`、`host:*`、`runtime:*`、`alert`、`focus`。

## 5. 显示仲裁规则（可判定，不留解释空间）

✅ 已实现（阶段 B）：`electron/island/intent-arbiter.ts`（纯状态机，18 项单测）+ `electron/plugins/plugin-order.ts` + `electron/island/mini-bar.ts`。

优先级从高到低：

1. **用户操作**：hover、点击、手动展开、拖拽、在设置里启用/停用。
2. **勿扰/全局策略**（❌ 待实现，仲裁器已留好 `canAlert()` 接入点）：全屏独占应用运行中、`勿扰` 开关打开时，`alert`/`focus` 一律 `denied(reason:'dnd')`，但**不丢**——进队列，策略解除后按 level 顺序补发一次（critical 过期仍补，info 过期丢弃）。
3. **focus**：同一时刻只有一个；新请求在无冲突时 `granted`；有冲突时按"level/时间"排队，队列长度 1，超出直接 `denied(reason:'busy')`。被抢占者收到 `preempted`，**恢复由插件自己重发**（宿主不记状态，避免双份状态机）。
4. **alert**：队列长度 3，同 `key` 覆盖不排队；`ttl` 到期 `expired`；用户点击该提醒 = 立即结束并回调。
   - **覆盖条宽度可申请**（✅ 2026-10）：`alert({ width })` 传逻辑 px，实际宽度 = `max(清单 small.width, width)`（按 miniScale 缩放、钳到 mini 条最大宽），宽度直接作用于插件 small 视图（100% 布局自适应）；不传 = 清单声明的推荐宽度。提醒段永不因溢出丢弃的规则不变。
5. **ambient**：只在 mini 条可见时存在，不参与抢占。

排序（mini 条内）：**用户在控制台拖拽的顺序** > `priority`（manifest，默认 50，大到小）> 插件名。
排序是**用户态**，存 `<userData>/settings.json` 的 `pluginOrder: [id,...]`，插件升级不覆盖，插件卸载后从数组里清掉。✅ 已实现（设置 → 插件页顶部岛预览，拖动芯片排序）。

mini 条溢出：所有段宽度之和 > 可用宽度（窗口宽 − 24px）时，按顺序丢弃尾部 ambient 段，折叠成 `+N` 徽标（宿主渲染层自己画，点击进入设置 → 插件页）；`focus`/`alert` 永不因溢出丢弃。✅ 已实现。

## 6. 尺寸与缩放

- 插件在 manifest 声明 `small/medium/large` 尺寸；宿主按 `miniScale` 换算成原生 bounds 并同步 `zoom`（已实现：缩放变化即时重排，不再需要"中岛来回一次"）。
- ⚠️ Chromium 的 zoom **按 origin 共享且持久化**：所有插件都在 `file://` 下，任何一个插件的 zoom 都会影响其它插件。因此宿主不做"值没变就跳过"的缓存，`metrics.zoom` 以真实 `getZoomFactor()` 为准。
- 插件页面必须 `100% × 100%` 自适应；**宿主会在缩放变化后立刻改 bounds + zoom**，插件不得缓存像素尺寸。
- `host:metrics` 给插件真实渲染参数：`width/height` 是插件页面的 **CSS 像素**尺寸（= 原生 bounds / zoom），`zoom` 是当前 zoom，`scale` 是宿主 mini 缩放设置，`deviceScaleFactor` 是显示器缩放（信息性）。
- canvas/图表用 `sdk.fitCanvas(canvas, draw)` 即可：它按 `canvas.width = cssWidth × window.devicePixelRatio` 对齐像素（Chromium 的 `devicePixelRatio` 已经包含 zoom），并在尺寸/缩放变化时重绘。手写时请用 `window.devicePixelRatio`，不要用 `metrics.deviceScaleFactor × zoom` 自行推算。
- `ui:request-size` 在 mini 段申请宽度：宿主按 `round(width * miniScale)` 计算，并在 `mini 条溢出` 规则内接受；回执带 `width/height` 实际值。

## 7. 主题

宿主把 token 同时通过 `host:theme` 和 CSS 变量下发（`:root`），插件零成本跟随：

```css
--island-surface; --island-radius; --island-padding; --island-gap;
--island-ink; --island-ink-dim; --island-accent; --island-font;
```

- 静态样式一律用变量，不要在插件里硬编码 `#000`（现在 docs 要求"透明或纯黑"，将来会有浅色/毛玻璃）。
- `--island-radius` 是**实际生效值**（38px 高的岛声明 28px 实际是 19px），插件如果要在内部做同心圆角应基于它计算。

## 8. 性能契约

宿主承诺：`host:visibility` / `host:metrics` 变化即时通知；插件真正不在岛上时发 `visible:false`。收起模式的顶部触发条会把已预热的小视图裁到 1×1，但允许它继续渲染：此时是 `visible:false, reason:'obscured', rendering:true`。

插件承诺（SDK 兜底，默认即正确）：
- `rendering:false` 时不轮询、不做动画、不写 DOM；收起预热例外由宿主显式通过 `rendering:true` 授权；
- 不用 `setInterval` 裸奔，改用 `sdk.every(ms, fn)`；
- 不用 `requestAnimationFrame` 常驻循环，改用 `sdk.raf(fn)`；
- 后台脚本用低频采样 + 变化才推事件（宿主侧已有 `background` 进程，stdout 限 64KB/行）。

宿主侧最终兜底：若插件在 `visible:false` 时仍持续 IPC（> 20 条/秒），宿主限流并记 `runtime:error`。

## 9. 能力与权限

| capability | 含义 | 宿主校验 | 用户可见 |
|---|---|---|---|
| `process` | 允许运行清单内的后台脚本 | `background.entry` 必须在 `scripts` 白名单内，否则拒绝启动 | 安装时列出脚本名 |
| `notify` | 允许 `alert` | 未声明时 `alert` 返回 `capability-not-granted` | 是 |
| `media` | 允许转发系统媒体键 | 同上 | 是 |
| `launch` | 允许打开外部程序/路径 | 必须走宿主 `shell.openPath`，插件不能自己 spawn | 是 |
| `system` | 允许读取宿主采集的系统指标 | 同上（❌ 待定：是否给；我倾向**不给**，让插件用 `process` 自己采） | 是 |
| `clipboard` | 读写剪贴板 | 同上 | 是 |

【待点头】**不给插件通用系统数据 API**：系统信息、网络速率这类数据由插件自己的后台脚本采集（进程隔离、权限清晰、宿主不背锅）。宿主只提供"岛"相关的能力。

## 10. 生命周期

```text
load → hello → ready → (visible ⇄ hidden) → suspend/resume* → unload(200ms 宽限) → destroy
```

- `unload` 宽限：给插件 200ms 落盘（storage 写入是异步 IPC），超时强杀。
- 渲染进程崩溃：退避重启（1s/5s/15s，最多 3 次），每次 `runtime:error` 并写日志；仍失败则在 mini 条该段显示降级态（灰点），设置页标红可见原因。
- **岛自己的渲染进程崩溃**（画面就是它画的，崩了窗口还在但整块是死的）：`render-process-gone` → 自动 `reload()` 并重新同步布局，用户不用重启应用；1 分钟内超过 3 次则停止自动恢复并打日志，避免崩溃循环。✅
- **插件渲染进程崩溃**：记 `runtime:error(render-process-gone)`，并把这个崩掉的视图从表里丢掉 —— 否则它永远停在崩溃画面上再也建不起来；下一次 ensure / 热重载会重建。✅
- 后台脚本退出：默认不重启（除非 manifest `background.restart: 'on-failure'`），退避同渲染进程。`stop()` 会在 Windows 上用 `taskkill /T /F` 杀整棵进程树，且旧进程的异步 `close` 不会误删新进程的登记（否则每热重载一次就泄漏一个后台进程）。✅

## 11. 存储与设置

- `plugin:storage:get/set`：按 id 隔离在 `<userData>/plugin-data/<id>.json` ✅。
- 插件设置 UI 两种形态 ✅：`settings: { fields }` 宿主渲染静态表单（「参数」按钮）；`settings: "dist/settings.html"`（字符串 = 页面路径）宿主在控制台「插件」页出「面板」按钮，用 `WebContentsView` 叠加在控制台窗口上承载 —— 页面带完整插件 preload（storage / events / log / `ui.closePanel()`），宿主补发 `host:hello` + `host:visibility`，属于该插件的事件（后台脚本 stdout、runtime:*、host:settings）镜像给面板。动态管理界面用它，静态字段用表单。热重载/卸载面板自动关闭。
- 用户侧状态（启用、顺序、每插件开关）存宿主 `settings.json`，插件不可写。

### 界面归属（不许再讨论的一条）

**插件的参数表单与日志界面都是宿主的**，插件只负责声明和上报：

| 东西 | 谁来做 | 在哪 |
|---|---|---|
| 参数表单 | 宿主 | 控制台管理 →「插件」→ 某个插件的「参数」，打开**宿主统一的模态弹窗**（`settings.fields` 渲染）；弹窗只覆盖顶栏以下，关闭键始终可用 |
| 日志查看 | 宿主 | 控制台管理 →「插件」→「日志」，同样走**宿主模态弹窗**（可刷新 / 清空）；文件在 `<userData>/island-plugins/logs/<id>.log` |
| 操作反馈（卸载/重载/保存结果） | 宿主 | 页面内的提示条 + 危险操作两步确认 |

- **任何宿主界面都不使用原生 `alert`/`confirm` 弹窗**，也不给插件开浮层/弹窗：反馈一律内嵌在页面里（`#plugin-notice` / 按钮二次确认），参数与日志用宿主自己的模态弹窗承载。✅
- **插件不要在小岛里自己画设置弹窗或浮层**：小岛是内容展示区，不是控制面板。想看/改参数，用户去控制台管理；插件要展示状态就画在自己 small/medium/large 的正常页面里。
- 需要"就地调一个值"的插件，用 `island.settings.get/set` 读写、把控件画在自己的 medium/large 页面里 —— 那属于插件内容，不受上面限制。

## 12. 错误与降级

- `plugin.json` 非法/入口缺失：不再静默跳过，控制台的「未加载」会列出 id 与具体原因（`PluginManager.issues()`）。✅
- 日志：`<userData>/island-plugins/logs/<id>.log`，单文件 5MB 滚动，控制台「插件 → 日志」可查看/清空。✅ 来源包括 `island.log.*`、`console.error`、页面未捕获异常、后台脚本 stdout/stderr、加载失败与热重载。宿主的崩溃/自愈也写进 `_host.log`。✅
- 插件页面加载失败：mini 段显示降级态 + 悬浮提示原因，不阻塞其它插件。❌

## 13. 明确不做

- ❌ 模板渲染（`metric/list/media` 由宿主画）——UI 由插件负责。
- ❌ 同步 RPC（插件 `await` 宿主做长任务）。
- ❌ 插件间直接引用/通信（只能经宿主事件）。
- ❌ 插件窗口/窗口控制 API、外部脚本随意 spawn。
- ❌ 插件自绘外轮廓（圆角卡片、外阴影、外边距）。

## 14. 验收方式

`contract-probe`（随开发目录一起维护）：一个只做自检的插件，逐个跑 hello/visibility/metrics/theme/mode/intent/alert/focus/hold/request-size/log，把收到的每条消息按契约断言（字段齐全、时机正确、隐藏时无 IPC）。
- 宿主每次改契约，装这个插件跑一遍即可发现漂移；
- 它同时是插件作者的**可运行示例**（比文档更好用）。

阶段 A 实测（Electron 33 / Windows，18/18 通过）：握手与能力集、`visibility` 的 mini/expanded/obscured 三态、`metrics` 在 zoom 变化后重算 CSS 尺寸、主题 CSS 变量与圆角随岛变化、canvas 像素对齐 devicePixelRatio、`every()` 可见时运行且隐藏后 ticks 停止、隐藏 1.5s 内插件 IPC 为 0、隐藏时事件通道仍可用。

## 15. 落地顺序与验收标准

| 阶段 | 内容 | 完成标准 | 状态 |
|---|---|---|---|
| A 契约骨架 | `host:hello/visibility/metrics/theme` + SDK（含 `sdk.every`/`onVisible`/`fitCanvas`）+ demo 插件改造 | 隐藏时插件 IPC 为 0；改缩放后 canvas 不糊；主题变量生效 | ✅ 完成 |
| B 显示仲裁 | 三种意图 + `host:intent` + priority/用户排序 + mini 溢出 `+N` + `ui:close` 与 `ui:collapse` 分离 | 通知插件能抢占并自动退场；被抢占的展开态有明确回执；顺序可在设置里拖拽并持久化 | ✅ 完成 |
| C 作者体验 | 插件模板 + 目录热重载 + 日志面板 + 失败原因 + `.islandplugin` 打包 | 5 分钟内从模板跑出第一个插件；改文件即时生效；打包产物能装回去 | ✅ 完成 |
| D 权限与市场 | capabilities 白名单 + 限额限流 + 签名/市场 | 未声明 `process` 的插件无法执行脚本；超限被限流并记日志 |

阶段 B 的验收方式：

```powershell
npm run build
npm run test:contract                        # 46 项纯逻辑（排序 / mini 条装箱 / 意图仲裁 / 脚手架·打包·日志·问题上报）
npm run test:ui                              # 控制台管理页面冒烟（electron scripts/tests/settings-ui.cjs）
npm run test:bg                              # 14 项后台脚本端到端（真实宿主 + 真插件：stdout → 事件 → 插件页面 → storage）
npm run test:click                           # 10 项点击进中岛端到端（宿主会响应 ui:expand；插件不挂点击就真的没反应；岛渲染进程崩了能自愈）
npm run test:presence                        # 8 项按需出现端到端（setPresence(false) 即从 mini 条消失、可见性变 hidden、没内容时整条退回待机）
npm run test:anim                            # 17 项外壳动画（虚拟时钟逐帧采样：展开/收起的首帧位移、过冲、回弹、稳定时间）
npm run test:geo                             # 7 项收起原生几何（原生 viewport 单调收缩、不缩过 mini、内容不提前切换）
npm run test:wheel                           # 9 项中岛滚轮（插件页能收到 wheel、preventDefault 生效、页面 reflow 到中岛尺寸）
npm run test:icons                           # 6 项图标（icon.ico 多尺寸、tray.png 非空、宿主启动时真的读了它们）
npm run test:settings                        # 18 项控制台管理·插件页（启停、参数/日志模态弹窗、顶栏固定不被滚走、卸载两步确认）
pwsh -File scripts/tests/contract-e2e.ps1    # 阶段 B：真实应用 + 临时 profile，11 项端到端断言
pwsh -File scripts/tests/phase-c-e2e.ps1     # 阶段 C：日志 / 页面异常 / 开发目录热重载，8 项端到端断言
```

单测覆盖：priority/用户顺序排序、mini 条装箱（含 `+N` 预留宽度）、alert 的 ttl 到期 / 队列上限 3 / 同 key 覆盖 / 只有拥有者能撤销 / 岛被占用时排队、focus 的排队 1 / 抢占 / `no-view` / 升级、独占优先于提醒、用户手动展开抢占上一位。

端到端覆盖（真实应用）：alert → 27ms 内 `granted` → 小岛从收起横条弹出来（`visibility: mini`）→ ttl 后 `expired` 并回到收起态 → focus → `granted` + `host:mode=medium` + `visibility: expanded` → `ui.collapse()` 回到 `small`。

## 16. 作者工作流（阶段 C 已落地）

```powershell
npm run new-plugin -- my-plugin "我的插件"   # 从模板生成到 ..\island-plugin\my-plugin
# 到「控制台管理 → 插件 → 添加插件 → 选择文件夹安装」装一次（会记住源码目录）
# 之后改 dist/ 里的文件 → 宿主自动同步 + 热重载，日志在「控制台管理 → 插件 → ⋯ → 日志」
# 分发：控制台管理 → 插件行「⋯ → 导出插件包」→ <id>-<version>.islandplugin
# 别人在「控制台管理 → 插件 → 添加插件 → 导入插件包」里安装，装完直接能用
```

**打包是宿主的能力，不依赖插件目录里有脚本。** 「导出插件包」由宿主把安装目录打成一个 zip：

- **打进去**：`plugin.json`、`dist/`、`resources/`（后台脚本必需，漏了就"到别人机器上检测不到数据"）、以及插件自己的资源目录（如 `assets/`）、`README.md`。
- **不打进去**：`.git` / `.idea` / `.vscode` / `node_modules`、`*.log` / `*.tmp` / `*.swp` / `*.bak`、`state.json` / `state.js`（运行时数据）。
- 用**排除法**而不是白名单：作者往目录里放自有资源是允许的，白名单会把它悄悄丢掉，装到对方机器上才发现缺文件。
- 打包前会复核 `plugin.json` 与 `entry` 指向的文件确实在包内容里 —— 解开来装不上就白搭。
- **打包/解包由宿主自己实现**（`electron/plugins/zip.ts`），不调用 PowerShell。原因：`Compress-Archive` 实测会随调用形态与目标扩展名给出不一致的结果（打包 `.islandplugin` 从 Node 调用 exit 0，从另一个 PowerShell 里调用却报 `.islandplugin is not a supported archive file format`；目标没有扩展名时更是 exit 0 但一个文件都没生成），而它的 stderr 又容易被吞掉，用户只看到一个没有信息量的 `打包失败（exit 1）`。自实现之后扩展名随意、错误信息精确，并且：
  - 自己打的包，系统 `Expand-Archive` 能解开（互操作出得去）；
  - `Compress-Archive` 打的老包，宿主的读取器也能读（互操作进得来，老用户手里的 `.islandplugin` 不会失效）；
  - 解包做路径穿越防护（`../`、绝对路径条目一律拒绝）。
- 从包安装**不登记源码目录**（对方没有你的开发目录），所以是独立安装、不会热重载，这符合预期。
- 端到端覆盖：`npm run test:pack` = `zip-unit.cjs`（10 项：CRC32、压缩率、非 ASCII 文件名、路径穿越、互操作两个方向）+ `package-roundtrip-e2e.cjs`（22 项：导出 → 检查包内容 → **删掉源码目录** → 只用包安装 → 断言插件加载/后台脚本在跑/页面收到事件/参数 schema 齐全）。

### AI 生成（已移除）

内置的 AI 生成插件/工作台功能（原插件工坊「AI 生成」页）已随插件工坊一并移除。
写插件的推荐路线：`npm run new-plugin` 从模板起步，或用「插件 → 下载 Skill 包」把生成规范（SKILL.md）装给 Claude Code 等本地 AI。

### 插件参数（设置项，✅）

需要用户填参数的插件在 `plugin.json` 里声明：

```json
"settings": { "fields": [
  { "key": "city", "label": "城市", "type": "text", "default": "北京" },
  { "key": "threshold", "label": "告警阈值 (%)", "type": "number", "default": 85, "min": 50, "max": 100 },
  { "key": "theme", "label": "风格", "type": "select", "default": "auto", "options": [{ "value": "auto", "label": "跟随宿主" }] }
] }
```

- 宿主在控制台「插件 → 参数」渲染表单，值存进插件自己的 storage（`__settings`），插件用 `island.settings.all()/get()/set()/patch()/onChange()` 读同一份数据；插件自己改也会回灌宿主表单。
- 选项类型：`text / password / number / boolean / select / color / textarea`。
- 类型定义见 `packages/plugin-sdk/src/index.ts`；模板 `scripts/templates/plugin/` 里有完整示例。

- 模板：`scripts/templates/plugin/`（含 `plugin.json`、`dist/`、`pack.ps1`、README）。
- 热重载：`PluginWatcher` 盯住安装目录与开发目录（去抖 400ms），开发目录改动会先 `syncFromSource` 再重建视图、重载页面；`sources.json` 记录源码目录。
- 日志：`island.log.*` + 页面 `console.error` / 未捕获异常（宿主侧兜底捕获）+ 后台脚本 stdout/stderr + 加载失败 + 热重载，统一写 `<userData>/island-plugins/logs/<id>.log`。
- 未加载原因：`PluginManager.issues()` → 控制台的「未加载」面板。

## 17. 待清理

- ✅ 已删除 `plugin-preload.ts` 的 `host:clip` / `host:prepare` / `plugin:prepared`（原生 `setBorderRadius` 接管裁剪）。
- ✅ 已删除 `PluginViewManager` 里那条 `ipc-message`（`plugin:command`/`plugin:event`）死分支：它与 preload 的消息形状不一致，真实链路是 `ipcMain` 上的 `host:command` / `host:event`。
- ⬜ `plugin-manager.list()` 仍按插件名排序 → 阶段 B 改为按用户顺序 + priority。
