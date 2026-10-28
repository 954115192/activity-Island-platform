---
name: island-plugin
description: 为 Activity Island（Windows 桌面灵动岛，Electron 应用）生成网页插件。当用户想给灵动岛做插件（时钟、系统状态、媒体控制、通知桥接、番茄钟等）时使用：生成 plugin.json + dist/ 网页 + 可选 PowerShell 后台脚本，遵守三态尺寸与 Apple 风格视觉规范，并指导用户在岛上安装验证。
---

# Activity Island 插件生成

## 任务与产物

在用户指定的工作文件夹里创建插件，产物就是一个普通网页工程：

```text
my-plugin/
├─ plugin.json          # 清单（唯一必填文件）
├─ dist/
│  ├─ index.html        # entry 指向它
│  ├─ app.js
│  └─ style.css
└─ resources/           # 可选：后台脚本（PowerShell / Node）
```

用户安装方式：Activity Island 的「控制台管理 → 插件 → 添加插件 → 选择文件夹安装」选中这个文件夹即可生效；之后改文件会自动热重载。全部完成后运行自检命令（见文末），并把安装步骤告诉用户。

## plugin.json

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "0.1.0",
  "description": "在岛上显示今天天气",
  "icon": "☀",
  "runtime": "web-app",
  "priority": 50,
  "resident": true,
  "entry": "dist/index.html",
  "small":  { "enabled": true, "width": 120, "height": 44 },
  "medium": { "width": 420, "height": 200 },
  "large":  { "width": 640, "height": 340 },
  "settings": { "fields": [ { "key": "city", "label": "城市", "type": "text", "default": "北京" } ] },
  "background": { "entry": "resources/listener.ps1" }
}
```

- `id`：[a-z0-9_-]{1,64}；`version`：x.y 或 x.y.z；`entry` 包内相对路径，禁止 `..`
- `description`：控制台列表里的一句话；`icon`：单个字符或 Emoji（不要 HTML/SVG）
- `small.width` 按内容收紧（≈ 内容宽 + 28px 内边距），不要声明 150px 这类"保险宽度"
- `resident: true` = **默认**常驻 mini 条；用户仍可在控制台改成「仅提醒」或「关闭」。`resident: false` 默认仅提醒，不占条。`small.enabled: false` 的插件只能仅提醒
- 通知型插件用 `resident: false` + `setPresence(false)`；有工具/状态面板的插件可以在 `tools` 里声明控制台工具
- `settings.fields` 类型：text / password / number / boolean / select / color / textarea，宿主自动渲染表单
- **`settings: "dist/settings.html"`（字符串）= 自定义设置面板**：控制台「插件」页出「面板」按钮，宿主用 WebContentsView 承载，页面拿完整插件 SDK（storage / events / log）。适合动态管理界面（列系统应用、勾选开关这种表单做不了的）。页面自带顶部栏和关闭按钮（`island.ui.closePanel()`），配色用控制台深色（#0b0d12），**不要做成岛上的胶囊样式**。宿主会补发 hello/visibility，`onVisible` 里向后台要首帧数据即可
- **管理界面放面板，不放岛上**：岛是内容展示区，设置/管理类 UI 一律走面板或参数表单 —— 用户点开「面板」进不了大岛逐行管理 100 个应用的场景
- 面向用户的使用说明写在 `guide` 里（控制台**点插件名**打开，见下一节）；README 是给开发者的，宿主不渲染

## 使用说明（guide，需要配置的插件必写）

`plugin.json` 声明 `guide` 后，宿主会在控制台渲染成说明页：点插件名弹出，带参数插值、代码复制、动作按钮和系统设置链接。需要配置、需要系统权限、或对接外部程序的插件都应该写。

```json
"guide": {
  "summary": "给脚本/CI 用的通知入口：向本机端口 POST 一条 JSON，岛上就弹提醒。",
  "requires": ["插件已启用（后台监听随插件启动）"],
  "setupRequired": true,
  "steps": [
    {
      "title": "确认监听端口",
      "text": "默认 {{port}}，改完保存后后台会自动重启。",
      "actions": [{ "kind": "settings", "label": "打开参数" }]
    },
    {
      "title": "发送一条通知",
      "code": "curl -X POST http://127.0.0.1:{{port}}/ -H \"Content-Type: application/json\" -d '{\"title\":\"完成\"}'"
    }
  ],
  "troubleshooting": [
    { "problem": "端口被占用", "text": "换端口并保存。", "actions": [{ "kind": "logs", "label": "查看日志" }] }
  ],
  "links": [{ "label": "打开系统设置", "url": "ms-settings:notifications" }]
}
```

- `{{key}}` 会替换成该插件当前的参数值（例如 `{{port}}`）——命令和地址要跟着用户配置变，不要写死。
- `actions` 只支持 `settings` / `logs` / `reload`；`links` 只放行 `https:` 和 `ms-settings:`。
- `code` 渲染成代码块并带「复制」；可以是字符串，也可以是 `{ "language": "bash", "value": "..." }`。
- 纯文本，不支持 HTML / 自由 Markdown；`setupRequired: true` 标记「装完还要配置」。
- 说明要写操作步骤和排障，不要把 README 原样贴进来。

## 控制台工具（tools，可选但推荐）

有些插件除了参数，还需要**展示数据 + 触发一次操作**（CPU 采样、下载队列、计时器、余额检测）。把它写进 `plugin.json` 的 `tools`：宿主在控制台「插件详情 → 工具」页渲染数据卡和按钮，作者不用再单独做设置面板。

```json
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
      "spark": [42, 48, 39, 51, 45, 62, 58, 49, 53, 48]
    },
    "actions": [
      { "id": "copy-diag", "label": "复制诊断", "icon": "copy" },
      { "id": "export", "label": "导出 CSV", "icon": "download", "primary": true },
      { "id": "clear", "label": "清空历史", "icon": "trash", "tone": "danger" }
    ]
  }
]
```

- 视图类型：`stats`（指标 + 可选 spark）、`list`（任务列表，`tone:'bad'` 标红）、`focus`（计时/轮次）、`media`（正在播放 + 进度）、`text`。
- 清单里的 `view` 只是首帧；实时数据用 SDK 推：
  ```js
  island.tools.set('snapshot', { view: { type: 'stats', items: [...] } })
  island.tools.set('snapshot', { notice: '后台脚本已退出，以下是上次数据' })
  island.tools.set('snapshot', { notice: null })
  ```
- 按钮点击由宿主转发：`island.tools.onAction(({ toolId, actionId }) => { ... })`；执行完再 `tools.set()` 更新视图。`tone:'danger'` 控制台会要求点两次。
- 插件关闭时宿主保留上次数据、禁用按钮；不要把长时间设置塞进工具，刷新间隔/显示格式仍放 `settings.fields`。
- 复杂管理界面（列 100 个应用逐行开关）继续用 `settings: "dist/settings.html"` 面板；`tool.panel: true` 只是给工具卡加一个「打开完整面板」入口。

## 三态与视觉规范（Apple 风格，必须遵守）

页面 100%×100% 自适应；底色透明或纯黑；**不画**外层圆角、边框、阴影、外层卡片 —— 胶囊外轮廓归宿主。不做 hover 缩放/位移。

| 状态 | 内容内边距 | 区块间距 | 放什么 |
|---|---|---|---|
| small（~40px 高） | 左右 14px | 8px | 只放 [身份图标 18px] + [数值 16px/650] |
| medium | 16px 20px | 12px | 一个主信息 + 一个主操作；卡片 padding 12–14px、圆角 12px |
| large | 24px 28px | 20–24px | 分组信息；危险操作弱化到底部 |

- small 段公式：**[身份标记] + [数值]**，别的全部不要 —— 不放文字标签、日期、副标题、滚动字幕
- 间距按 4/8px 阶梯（4/8/12/16/20/24/28），不要 6/7/9/11
- 图标用 Lucide 风格线性 SVG（24 viewBox、stroke="currentColor"、描边 1.7–1.8、round 端点），**禁止 Emoji 当图标**
- 数字一律 `font-variant-numeric: tabular-nums`；语义色只表达状态：蓝=主操作、绿=正常、橙=警告、红=错误
- CSS 变量用宿主注入的 `--island-ink / --island-ink-dim / --island-accent / --island-font / --island-radius`，不要硬编码黑白

## SDK（window.dynamicIsland，宿主 preload 注入）

```js
const island = window.dynamicIsland
await island.ready                                  // { contractVersion, hostVersion, capabilities, theme, settings }
island.ui.getMode() / island.ui.onModeChange(m => …)  // 'small' | 'medium' | 'large'
island.ui.expand() / island.ui.collapse() / island.ui.close()
island.ui.setPresence(true | false)                 // false = 我现在没内容，别占 mini 条
island.onVisibility(v => …)                         // { visible, reason, rendering }
island.every(1000, render)                          // rendering:false 自动暂停；隐藏不轮询
island.raf(dt => …)                                 // 动画循环，同样自动暂停
island.fitCanvas(canvas, draw)                      // 像素尺寸对齐 devicePixelRatio
island.alert({ key, level, ttl, color, width })     // 整条覆盖提醒，详见下节
island.focus({ view: 'medium' })                    // 请求独占展开 → onIntent 回执
island.events.on('notify', p => …)                  // 自己后台脚本的事件会发给自己
await island.storage.get/set(key, value)
island.media.command('previous'|'toggle'|'next')    // 全局媒体键，无需后台脚本
island.log.info / warn / error                      // 写日志，控制台可看
island.settings.all() / onChange(v => …)            // 读 settings.fields 的值
island.tools.set(toolId, { view, notice })          // 控制台「工具」页实时数据
island.tools.onAction(({ toolId, actionId }) => …)  // 控制台工具按钮点击
```

## 提醒（island.alert）规则

**提醒画面 = 你自己的 small 视图**。宿主只消费 key / level / ttl / color，传入的 title/content/message 一概不渲染 —— 必须在调 `island.alert` **之前**把标题和正文画进 small 视图 DOM，否则用户看到空胶囊。

标准顺序：收到事件 → ① 渲染 small（语义色状态点 + 标题 13px/600 + 正文 11px 用 --island-ink-dim）→ ② `island.alert({ key, level, ttl })` → ③ small 挂点击 → `island.ui.expand()`。

- level：info（完成/恢复，默认 4s）/ warn（偏低/卡住，6s）/ critical（失败/失效，9s）
- color：可选 #RGB/#RRGGBB/#RRGGBBAA 自定义光圈颜色
- width：可选，这条提醒需要的宽度（逻辑 px）。实际宽度 = max(清单 small.width, width)，按 miniScale 缩放并钳到岛最大宽；**不传就用清单声明的推荐宽度**。长通知在调 alert 前量好内容宽度传入，插件的 small 视图用 100% 布局自适应更宽的画布
- key：同 key 新提醒立即覆盖并重置计时；不同 key 排队（上限 3）。进度类滚动更新用固定 key
- 常见错误：只调 alert 不画内容；用"N 秒没收到 ready"判死活（ready 只发一次，热重载后收不到，必然误报）；denied 后无限重试

## 后台脚本（读本机数据 / 联网 / 系统 API）

- `plugin.json` 里**必须**写 `"background": { "entry": "resources/xxx.ps1" }`，不写根本不启动
- .ps1 用 Windows PowerShell 5.1（不是 pwsh 7，WinRT interop 只在 5.1 有）；.js 用 node 跑
- 宿主会把该插件当前参数以环境变量 `ISLAND_PLUGIN_SETTINGS`（JSON 字符串）注入后台进程；保存参数后宿主会重启后台脚本，所以脚本启动时读一次即可
- 宿主还注入 `ISLAND_PLUGIN_DATA`（插件 storage 目录）。**视图 → 后台没有现成通道（stdin 被丢弃），控制类需求用信箱模式**：视图 `island.storage.set('cmd', { seq, action, … })`，后台脚本每 400ms 轮询 `$env:ISLAND_PLUGIN_DATA\<id>.json`，执行后把结果 `{"type":"result",…}` 推回 stdout。要点：seq 由视图自增并持久化在 storage（热重载后视图 seq 会归零）；脚本启动时先读一次文件把已有 seq 记为基线，不执行旧命令
- stdout **每行一个 JSON**：`{"type":"state","title":"歌名"}` → 插件 `island.events.on('state', …)`
- 不是 JSON 的行进日志；stderr 进日志；不要往 stdout 打日志/进度条
- **不要往插件目录写文件**（会触发热重载死循环），落盘写 `$env:TEMP`
- stdin 不可用；控制类操作走 `island.media.command()`
- **PowerShell 数组返回**：调用方用 `@(函数名 参数)` 收集；函数内直接 `return $out`，不要 `return ,$out`（嵌套数组会变字符串 "System.Object[]"）
- **吞异常 = 静默丢数据**：空 catch 让故障完全不可见；兜底失败至少往 stderr 写一行原因

### .ps1 必须保存为 UTF-8 带 BOM（换电脑才会暴露的必踩坑）

Windows PowerShell 5.1 对**无 BOM** 的脚本按系统 ANSI 代码页解码，不是 UTF-8：

- 开发机若启用了「Beta: 使用 Unicode UTF-8」（ACP=65001），读写都正常；**发给普通中文 Windows（ACP=936/GBK）就解析失败**——脚本里中文字符串结尾的多字节序列会把结束引号一起吃掉。
- 症状：报 `ParserError: UnexpectedToken`，错误行号指向含中文的那几行（`…` 也算），进程以 exit 1 退出；后台没有数据，插件在岛上完全不出现，日志里只有一段 ANSI 乱码，**很容易误判成"listener.ps1 文件丢了"**。
- **规则：只要 `.ps1` 含有非 ASCII 字符（中文注释、提示语、`…` 都算），一律保存为 UTF-8 with BOM**。纯 ASCII 不受影响，也建议统一加，成本为零。
- 模型和编辑器默认写出的通常是无 BOM UTF-8，**不要依赖默认值**；生成后自查文件前 3 个字节是 `EF BB BF`，没有就转换：

```powershell
# 把无 BOM 的脚本转成 UTF-8 with BOM（改完记得重新安装/重新导出插件包：
# 宿主按字节复制，安装目录里的旧副本不会自动更新）
$p = 'resources/listener.ps1'
$text = [IO.File]::ReadAllText($p, [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText($p, $text, [Text.UTF8Encoding]::new($true))
```

- 建议在脚本开头设置 `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)`，否则 stderr 在非 UTF-8 系统上按 ANSI 输出，宿主日志里全是乱码，排障时看不到真正原因。

### 读取 Windows 通知中心的 WinRT 坑（通知监听类必读）

用 `UserNotificationListener` 读通知时，**不要用 `Visual.GetBinding(...)` 返回的对象调 `GetTextElements()`** —— 实测 PowerShell 5.1 下随机抛 "The object's type must not be a Windows Runtime type"，异常被吞后表现为"通知只剩应用名、没有标题正文"。正确写法是**遍历 `notification.Visual.Bindings` 集合**（实测稳定）：

1. 按 Template 优先选 `'ToastGeneric'` 的绑定，其次任何有文本的绑定
2. 每个绑定调 `GetTextElements()`，第一段文本 = 标题，其余拼接 = 正文
3. 逐元素 try/catch，单元素失败跳过，不要整条放弃
4. 访问状态：`GetAccessStatus()` 1=allowed / 2=denied / 0=unspecified；未授权时调 `RequestAccessAsync()`

## 交互规则（宿主不会代劳的事）

- **small 段的点击自己挂**：容器铺满整个视图（width/height 100%，子元素 pointer-events:none），`onclick → island.ui.expand()` 进中岛；中岛再点 → 大岛；大岛给 `island.ui.collapse()` 入口。漏了 = 用户点插件没反应
- 控制按钮 `stopPropagation()`；参数/日志界面归宿主，**不要**在岛上画设置弹窗
- "有内容才出现"的判断必须**事件驱动**（后台脚本推事件）——被摘下后 `every()` 会暂停，靠轮询醒不过来
- 不要做"点空白处收起"——鼠标移开小岛宿主自己会收

## 自检与安装

```powershell
# 自检（用户装了 Activity Island 时可用；检查宿主加载、运行期错误、日志）
pwsh -File <仓库>\scripts\plugin-smoke.ps1 -PluginDir <插件目录>
```

生成完成后告诉用户：
1. 打开 Activity Island 的「控制台管理 → 插件」页，点「添加插件 → 选择文件夹安装」选中本插件文件夹
2. 之后改文件自动热重载，无需重新安装
3. 分发：插件行右侧「⋯ → 导出插件包」生成 `.islandplugin`，对方在「插件 → 添加插件 → 导入插件包」直接装
