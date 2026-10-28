# 工作台契约（Workbench Contract）

> 状态说明：**第 1–8 节是当前已实现的真实行为**（写文档时逐条对着代码核过）；
> **第 9 节是目标设计（多工作台 + 独占启用 + 管理），尚未实现**（原「工坊 AI 开发」目标已随 AI 生成功能移除而取消）。
> 实现前不要把第 9 节当成可用接口。

---

## 1. 工作台是什么

工作台是**宿主自己的全屏面板**：右键小岛（或插件里请求控制台）后，小岛弹簧展开成一个大胶囊，里面是工作台页面。

它和插件的关系：

| | 插件 | 工作台 |
|---|---|---|
| 位置 | mini 条上的一段，可展开中岛/大岛 | 独占整个小岛，模式是 `custom` |
| preload | `window.dynamicIsland` | `window.workbench` |
| 生命周期 | 按需显示/隐藏，可多个同时 | 一次只有一个，打开时所有插件视图隐藏 |
| 尺寸 | 各模式声明 | 固定 1040 × 700 |
| 来源 | 用户安装，**宿主不内置** | **宿主内置**（`console-apps/workbench/`，打进 asar） |

内置实现在 `console-apps/workbench/{index.html, script.js}`，参考实现包含：系统指标（CPU / 内存 / 运行时间 / 平台）、快捷启动、DeepSeek 用量、网络速率、参数配置。

## 2. 进入与退出

```text
右键小岛 / 插件请求控制台
  → enterCustomMode()                       main.ts
  → arbiter.interrupt()                     提醒与独占都让位（排队的提醒保留）
  → ensureWorkbenchView()                   WebContentsView + workbench-preload
  → viewManager.adoptWorkbench(view)        挂进小岛的裁剪 viewport
  → islandState.mode = 'custom'
  → sendLayout('custom', …, clipPlugins=true)
  → 渲染层跑弹簧，逐帧回报 host:animation-frame
  → 原生裁剪面跟着长大，把工作台"揭"出来
```

- 尺寸默认 **1040 × 700**，但可以通过 `workbench.resize()` 改（宿主钳制到 720×480 ~ 1280×860）。`stageOrigin` 居中，`islandTop` 决定纵向位置。
- 工作台启动时**预热**（`void ensureWorkbenchView()`），第一次右键不会等冷加载。
- 退出：`window.workbench.exit()` → `workbench:exit` → `hideWorkbench()` → 回静止态。

## 3. preload 接口（`window.workbench`）✅ 已实现

**新页面一律用 `window.workbench`**（`electron/preload/workbench-preload.ts`）。这是"通用能力"，
不是按功能枚举的白名单 —— 后者正是内置工作台坏掉的原因（见 §7）。

```js
window.workbench = {
  exit(),                                    // 退出工作台，回小岛
  close(),                                   // 关闭控制台窗口（独立窗口模式）
  capabilities(),                            // → { ok, id, capabilities: string[] }

  system: { status(), network() },           // 能力 system
  open(target),                              // 能力 open：宿主按 scheme 分流（URL→openExternal，其余→openPath）
  http(url, options?),                       // 能力 http：{ method, headers, body, timeoutMs }
  run(command, args?, options?),             // 能力 run：{ cwd, timeoutMs, shell? } → { code, stdout, stderr }

  storage: { get(key), set(key, value), delete(key), all() },   // 能力 storage
  resize({ width, height }),                 // 能力 resize → 返回真正生效的尺寸与 clamped

  log: { info(), warn(), error() },          // 落到 __workbench__<id>.log
}
```

**返回值约定（必须遵守，也请页面依赖它）**

| 情况 | 返回 |
|---|---|
| 成功 | `{ ok: true, ... }` |
| 失败 | `{ ok: false, error: '给人看的中文原因' }` —— **不留静默失败** |
| 未声明能力 | `{ ok: false, error: 'capability-not-declared:<name>' }` |
| 非工作台页面调用 | `{ ok: false, error: 'not-a-workbench' }` |

行为细节：

- `open`：`http(s)://` 与 `mailto:` 走 `openExternal`，其余走 `openPath`。
  `openPath` 失败时**返回错误字符串而不是抛异常**，宿主会把它变成 `{ ok:false, error }`。
- `http`：只能 `http:`/`https:`；主进程发出所以**不受 CORS 限制**，可以访问 `127.0.0.1` 上的本地服务；
  响应体上限 2 MB（超出时 `truncated: true`）。
- `run`：默认**不经 shell**（`shell: true` 要显式开）；stdout/stderr 各上限 256 KB；默认超时 60 s。
- `resize`：宿主记录并钳制，返回**真实生效值**，页面据此知道有没有被截。两道守卫：
  1. **宿主还没排布过就拒绝**（`{ ok:false, error:'not-laid-out' }`）—— 页面在首次排布前量到的是垃圾值
     （视图还没有尺寸），照它改尺寸会把"第一次打开"的动画带偏（实测能刷出 163 次布局、
     尺寸从 720×480 一路爬）。判据是"排布过"而**不是**"当前可见"：工作台可能只是被命中检测收回去，
     它仍保持上次的 bounds，那时请求"下次打开生效"是合法用法。
  2. **小于 4 px 的变化当回环丢掉**（返回 `{ ok:true, ignored:'below-threshold' }`）—— 页面根元素是
     `height:100%` 时量到的就是宿主给的盒子，请求"盒子 +2px"永远不收敛。
  正在显示时立刻重排；不在显示时只记下来，**下次右键打开时生效**。
- `capabilities()`：页面应据此**自己降级**（把没授权的能力对应的 UI 隐藏），而不是等调用报错。
  内置工作台就是这么做的：`#deepseek-section` 在缺 `http`/`storage` 时隐藏、`#shortcut-section` 在缺 `shortcuts` 时隐藏。

> 旧的 `window.activityIsland`（方法白名单式 `api()`）**已删除**。没有第三方工作台依赖它，
> 留着只会让新页面继续照着白名单去写 —— 那正是「DeepSeek 用量」整块烂掉的原因
> （调了宿主不存在的 method，静默返回 `unknown-api`）。

## 4. 数据存储

分两类，**不要混**：

| 数据 | 位置 | 谁拥有 |
|---|---|---|
| 「快捷启动」列表 | `<userData>/workbench/shortcuts.json` → `[{ id, name, path }]` | **宿主**（跨工作台共享：换工作台时常用软件不丢） |
| 工作台自己的数据 | `<userData>/plugin-data/__workbench__<id>.json`（走 `workbench.storage`） | **工作台自己** |

- 页面偏好（刷新频率、主题色、是否显示网络面板）属于"某个页面的展示选择"，走 `workbench.storage`。
  **宿主不再为它开专用文件/接口** —— 以前那套 `workbench/settings.json` + `workbench:settings:get/set` 已删除。
- `storage` 是自由 KV（一个工作台一个命名空间），宿主不做模式校验，页面自己负责默认值与合法性回落。
- ⚠️ `storage` 是**明文 JSON**。内置工作台把 DeepSeek 令牌存在里面，所以它：
  - 只写入、**不回填到输入框**（界面只显示"已配置"）；
  - `%APPDATA%` 下的其它进程能读到 —— 需要更强保护的话是要单独做的事，当前**不做**加密。

## 5. 硬性规则（外轮廓归宿主）

和插件同源，但工作台是**整屏面板**，更要守：

1. `html, body` 必须 `width/height: 100%; overflow: hidden`，**底色透明或纯黑**。
2. **禁止外层圆角卡片、边框、外阴影**：小岛胶囊是唯一外轮廓，宿主在弹簧动画中逐帧裁剪。
   内置工作台用的是"从中心向四周衰减到纯黑"的径向渐变（`radial-gradient`），
   这样弹簧过冲时露出的边缘和面板边缘能对上，不会出现一圈色差。
3. 尺寸默认 1040 × 700；要别的尺寸用 `workbench.resize()` 请求（宿主钳制到 720×480 ~ 1280×860）。**不要**用 `window.resizeTo`（在 Electron 里是空操作）。
   **更不要**拿 `resize()` 做"按内容自适应"：你的根元素是 `height:100%`，量到的就是宿主给的盒子，
   照它去请求永远不收敛（这个回环真发生过）。宿主因此有两道守卫：首次排布前拒绝（`not-laid-out`）、
   小于 4 px 的变化丢掉（`ignored:'below-threshold'`）。尺寸该在 `workbench.json` 里声明。
4. 必须提供**退出入口**（内置的是右上角「退出工作台」）。
5. 隐藏/关闭后不要继续跑轮询；要频繁刷新就自己节流（内置工作台把间隔做成可配的偏好）。
6. **失败要显示出来**：所有能力调用都可能返回 `{ ok:false, error }`，
   不要写 `.catch(() => {})` 把它吞掉 —— 那正是"点了没反应却像成功"的来源。

## 6. 当前的安全边界

`window.workbench` 比插件用的 `dynamicIsland` **特权大得多**：

- `open(target)`：能打开任意程序、文件、网址（URL 走 `openExternal`）。
- `run(command, args)`：能执行本机命令与脚本。
- `http(url)`：主进程发出的任意 http/https 请求（不受 CORS 限制，能访问本机服务）。
- `shortcuts.*`：读写跨工作台共享的快捷启动列表。
- `system.*`：读 CPU / 内存 / 网络等机器信息。

所以工作台属于**受信任的宿主扩展**：装上就能对你的机器做上面这些事。
**安装工作台 = 信任它**，因此能力声明（§9.2）是必需的、且在启用前就要展示。

## 7. 曾经坏掉的地方（都已修，留作教训）

| 项 | 状态 |
|---|---|
| `resize()` 是空操作 | ✅ 已修：改为宿主尺寸通道（`workbench:resize`），钳制后返回真实生效值。旧实现是 `window.resizeTo`。 |
| 网址快捷启动打不开 | ✅ 已修：`open` 按 scheme 分流（URL→`openExternal`）。旧实现只调 `openPath`（开不了网址）**并恒定返回 `{ok:true}`**，所以失败也显示成功。 |
| 「DeepSeek 用量」整块死掉 | ✅ 已修：以前调 `api('deepseek.setToken')` / `api('deepseek.usage')` / 读 `settings.deepseekConfigured` / 监听 `activity-island:deepseek-refresh`，宿主**一个都没有**。现在页面用 `http` + `storage` 自己实现（对接官方 `/user/balance`）。 |
| `api()` 方法白名单 | ✅ 已删：`window.activityIsland` 整个移除。白名单逼着每个功能都去改宿主，而"接口没跟上"就静默死一块 —— 上面那条就是这么来的。 |
| 宿主为单个页面存偏好 | ✅ 已删：`workbench/settings.json` 与 `workbench:settings:*` 移除，页面偏好走 `workbench.storage`。宿主不该知道某个页面的 `refreshMs/accent`。 |
| 错误被吞 | ✅ 已修：页面不再写 `.catch(() => {})`，失败会在页脚说出来；测试专门断言这条。 |
| 测试覆盖 | ✅ 已补：`npm run test:workbench`（API 27 项 + 页面 21 项）。此前为 **0**。 |
| 文档 | 本文件之前，`docs/` 里"工作台"出现 0 次。 |

> 这些不是几个独立 bug，是**同一个病的症状**：作者写页面时不知道宿主有什么、宿主也不知道作者要什么，
> 写完了没有契约也没有测试。**这就是"补契约 + 补测试"要排在"加新能力"前面的原因** ——
> 否则新能力只会原样重复这个模式。

## 8. 交付前自检（当前可用的手段）

没有自动化测试，只能人工：

1. `npm run dev`，右键小岛 → 工作台展开，四张指标卡有数字。
2. 快捷启动：加一条 → 重启应用 → 还在（`%APPDATA%\dynamic-island-host\workbench\shortcuts.json`）。
3. 参数配置改刷新频率/主题色 → 立即生效 → 重启后保留。
4. 点「退出工作台」→ 回到小岛原状态。
5. 控制台 `F12` 看有没有 `unknown-api` —— 出现就说明调了不存在的接口。

---

## 9. 目标设计：多工作台、独占启用、可管理、可完全自定义

> 以下为**设计**。已确认的决定见 9.0，其余为待实现。

### 9.0 已确认的设计决定

| # | 决定 | 理由 |
|---|---|---|
| 1 | **工作台与插件是两种反向的东西，必须分开** | 插件＝环境信息（常驻、极简、越多越好，独占小岛是**成本**）；工作台＝任务聚合（按需、密集、一屏装下、用完就走，独占小岛是**目的**）。触发方式也不同：点段＝我要看这个；右键＝我要开始干活。 |
| 2 | **内容模型选 B：工作台是一整页 HTML** | 作者想画什么画什么，宿主只给**能力与数据**。不做"标准区块"模型 —— 内置工作台本身就是一整页手写页面，区块化会限制它，且聚合的价值在页面而不在拼装。 |
| 3 | **能力面走"完全档"** | 用户要求工作台**既能访问外部请求，又能控制本机**（跑脚本、开程序），否则达不到"干活"的目的。见 9.1。 |
| 4 | **不做沙箱，但要做声明与告知** | 完全档能力 + 沙箱是自相矛盾的。改为 manifest 声明所需能力，启用时在管理页列出，由用户知情选择。 |
| 5 | ~~`kind: "workbench"` 塞进插件体系~~ **（已否决）** | 该方案需要一张 9 行的"行为差异表"（不进 mini 条 / 忽略 priority / 忽略 presence / 忽略 alert / 忽略 focus / 尺寸不同 / preload 不同…）。**一张长长的差异表说明抽象错了**：共享的应该是**机制**（沙箱、安装目录、日志、热重载、打包），而不是"插件"这个**概念**。改用**独立目录**：`<userData>/workbenches/<id>/`，让"工作台不是插件"成为结构性事实，而不是每处都要记得判断的条件。 |

### 9.1 能力面（完全档）

工作台要能"干活"，就必须拿到这些。设计原则是**给通用能力，不给专用接口**：

```js
window.workbench = {
  exit(),                                  // 退出工作台

  // 只读系统信息（"持续刷新的信息"）
  system: { status(), network() },

  // 打开：URL / 程序 / 文件 / 文件夹，宿主自己判定 scheme
  open(target),                            // URL → openExternal，其余 → openPath（修掉现在的网址 bug）

  // 跑东西（"一些脚本"、"控制电脑内的事件"）
  run(command, args?, options?),           // 一次性执行，返回 { code, stdout, stderr }
  spawn(command, args?, options?),         // 长驻进程，返回可 kill 的句柄

  // 外部请求（"访问外部请求"）
  http(url, options?),                     // 主进程发出，不受 CORS 限制，可访问 127.0.0.1 上的本地服务

  // 存储
  storage: { get(key), set(key, value), delete(key), all() },

  // 尺寸（真正实现 + 宿主钳制）
  resize(width, height),

  log: { info, warn, error },
}
```

**三条必须守住的设计原则**（全部来自现有 bug 的教训）：

1. **失败必须如实上报。** 现在的 `workbench:launch` 忽略 `shell.openPath` 的返回值、恒返回 `{ok:true}`，
   于是"网址点不动"却显示成功。新能力一律返回真实结果（`run` 必须给 `code`，`open` 必须给错误原因）。
2. **不许专用接口。** 内置「DeepSeek 用量」当初要求宿主为它写 `deepseek.*`，宿主没写就整块死掉。
   有 `http` + `storage` 之后，这类账号面板**工作台自己能实现**，宿主不必介入，
   也不会再出现"接口没跟上于是一整块功能静默失效"。
3. **能力要能被验证。** 这层现在**零测试**，所以坏了两处都没人知道。加能力必须同时加测试
   （参照 `scripts/tests/` 的写法：隐藏窗口 + 独立 `userData` + 桩 IPC；**注意**必须用独立 profile，
   且不要每页 create→destroy 窗口）。

### 9.2 已确认：工作台是**可分发应用**

决定：工作台可以被别人写、被别人装，所以能力告知是**必需**的，不是可选装饰。

**完全档能力 + 可分发 = 装一个工作台等于装一个任意程序。** 因此告知必须做成**可执行的校验**，
不能只是一句提示文字 —— 否则那句提示就是在骗用户。

#### 能力声明（manifest）

```jsonc
// <userData>/workbenches/<id>/workbench.json
{
  "id": "my-console",
  "name": "我的控制台",
  "version": "1.0.0",
  "entry": "dist/index.html",
  "size": { "width": 1040, "height": 700 },
  "capabilities": ["system", "open", "http", "run", "storage"]
}
```

| 能力 | 包含 | 用户能看懂的说明 |
|---|---|---|
| `system` | `system.status()` / `system.network()` | 读取 CPU、内存、网络等系统信息 |
| `open` | `open(target)` | 打开程序、文件、文件夹、网址 |
| `http` | `http(url, options)` | 访问网络（含本机 `127.0.0.1` 上的服务） |
| `run` | `run(command, args)` | 执行本机命令与脚本 |
| `storage` | `storage.*` | 保存这个工作台自己的数据 |
| `resize` | `resize(w, h)` | 改变工作台尺寸（宿主会钳制） |

#### 强制规则（宿主在 IPC 边界上执行）

1. **没声明就调不通**：未声明能力的调用返回 `{ ok:false, error:'capability-not-declared:<name>' }`，
   **不是静默失败、也不是警告**。这样"声明"和"实际能做"永远一致。
2. **内置工作台视为声明全部**（它随宿主分发，本来就是受信任的）。
3. **管理页必须展示声明的能力**（用上表的人话版本），并且在**启用前**就能看到。
4. **修改声明要重新确认**：工作台升级后若新增了能力，宿主应再次提示，而不是静默继承授权。
5. `http` 只允许 `http:` / `https:`；`run` 默认**不经 shell**（显式选项才开）。

> ⚠️ 这不是沙箱 —— 声明通过之后，工作台拿到的就是真实能力。
> 它的作用是让用户在**启用之前**知道自己要装的是什么，而不是阻止已经同意的事。

### 9.3 工作台 ≠ 插件的边界（落地时不要漏）

| 行为 | 插件 | 工作台 |
|---|---|---|
| mini 条 | 参与 | 完全不参与（**独立目录，天然不会被捞到**） |
| `priority` / 用户排序 | 生效 | 忽略 |
| presence / alert / focus | 生效 | 忽略 |
| 同时存在 | 多个 | 多个**安装**，只有一个**启用** |
| preload | `dynamicIsland` | `workbench` |

### 9.4 独占启用

宿主设置新增 `activeWorkbench`（id 或 `"builtin"`，缺省 `"builtin"`）：

- 内置工作台是列表里**不可卸载**的一项（id 固定 `builtin`）。
- `enterCustomMode()` 按它决定加载哪个入口。
- **新安装的工作台不自动启用**（否则"装完就把用户的工作台换掉了"）。
- 卸载/禁用 active 时**自动回落 `builtin`**（否则右键会打开一个不存在的入口）。

### 9.5 管理页（控制台管理 →「工作台」）✅ 已实现

**形态：列表克制，详情才展开。** 列表里每项**只有「名字 + 示例图」**（外加"使用中/内置"标记），
点卡片进详情 —— 不在列表里堆能力标签和一堆按钮。

**卡片缩略图（示例图）**

- `workbench.json` 可声明 `"preview": "preview.svg"`（包内相对路径，支持 svg/png/jpg/webp）。
- 宿主把它读成 **data URL** 交给管理页：设置页自己也是 `file://` 页面，直接 `<img src="file://…">`
  会被 Chromium 的 file 源策略挡住，读成 data URL 最稳；超过 512 KB 或路径越界就当作没有。
- 作者没提供（或指向的文件不存在）→ 页面用**名字首字占位**，不假装有截图。
- AI 生成时简报会要求它顺手画一张 `preview.svg`（320×200 的界面示意线框）——
  示例图是这个页面的主要信息，用户就是看它决定要不要装。

**详情里有什么**

- 示例图（大图）、描述、状态（正在使用/未启用）、版本、标识、源码目录。
- **能力逐条用人话列出**；碰机器与网络的（`run`/`http`/`open`）**标红**，未确认的再标一层。
- 操作：**启用**（有未确认能力时是「确认并启用」）/ **参数**（声明了 `settings.fields` 才显示）/
  **日志** / **重载** / **导出插件包** / **卸载**（两步确认）。内置工作台没有导出与卸载。
- 未确认能力时点启用**先弹宿主自己的确认框**（不是原生 `confirm`），**取消则既不启用也不记录确认**。

**打包分发（和插件同一套）**

- 详情里「导出插件包」把工作台打成 `.islandplugin`（和插件**共用同一个打包实现**，
  只是清单文件名不同）。内置工作台不给导出（它随宿主分发）。
- 「从插件包导入」（工作台页）/「导入插件包」（插件页）**一个入口两种都能装**：宿主按包内清单自动分流
  （`workbench.json` → 控制台，`plugin.json` → 插件）。
- 导入的控制台**不自动启用**，能力仍需确认。

**参数**

- `workbench.json` 的 `settings.fields` 和插件的 `plugin.json` **同构**，宿主在详情里渲染表单。
- 值存在工作台自己的 storage（保留键 `__settings`），页面用 `window.workbench.settings.*` 读同一份，
  用户在管理页改了会推 `host:settings` 给页面。
- 保存时**只接受声明过的键**（未知键丢掉）——和插件一致。
- 页面**不要**自己再画一套设置界面。

**其它**

- 顶部固定信任提示：「工作台能访问网络并执行本机程序与脚本，启用等于信任它。」
- 「重载」会先同步开发目录再重读清单；**重载新增的能力仍需确认**才允许启用。
- 没加载起来的工作台（坏 JSON、入口缺失）单独列出原因。

### 9.6 实施顺序与进度

| 步骤 | 状态 |
|---|---|
| ① 能力面（`system` / `open` / `http` / `run` / `storage` / `shortcuts` / `resize`）+ IPC 边界的声明校验 + 测试 | ✅ **已完成**（`workbench-api-e2e` 27 项） |
| ② 内置工作台迁移到 `window.workbench`；删掉白名单式 `api()`；用 `http` + `storage` 重写「DeepSeek 用量」；修掉网址打不开与错误被吞 | ✅ **已完成**（`workbench-page-e2e` 21 项） |
| ③ 工作台独立目录 `<userData>/workbenches/<id>/` + 注册表 + `activeWorkbench` 独占启用 + 与插件隔离 | ✅ **已完成**（`workbench-registry-e2e` 31 项） |
| ④ 控制台「工作台」管理页（卡片列表：名字 + 示例图 → 点击进详情；详情里有启用单选 + **能力告知** + 参数 + 日志 + 重载 + 导出插件包 + 卸载） | ✅ **已完成**（`workbench-ui` 32 项 + `workbench-registry-e2e` 里的打包/参数 15 项） |
| ⑤ 工坊 AI 支持工作台目标类型（brief、manifest 骨架、重载） | ❌ **已随 AI 生成功能移除**（2026-10） |

### 9.7 工坊 AI 生成工作台（❌ 已随 AI 生成功能移除，2026-10）

> 以下为移除前的行为记录，仅作历史参考。

**流程和插件完全一样**（选文件夹 → 讨论 → 实现 → 安装 → 调试），只多一个「插件 / 工作台」切换器：

| | 插件 | 工作台 |
|---|---|---|
| 注入的简报 | `PLUGIN_CONTRACT_BRIEF` | `WORKBENCH_CONTRACT_BRIEF`（教 `window.workbench`、能力声明、失败上报、退出入口） |
| 清单文件 | `plugin.json` | `workbench.json` |
| 文件白名单 | `ALLOWED_PLUGIN_FILE` | `ALLOWED_WORKBENCH_FILE`（多 `workbench.json`，少 `pack.ps1`） |
| 归一化 | `normalizePlugin` | `normalizeWorkbench`（校验能力白名单、code 里用了没声明的能力会**提前警告**、id 叫 `builtin` 会改名） |
| 安装落点 | `<userData>/plugins/` | `<userData>/workbenches/` |
| 完成后 | 刷新「已安装」列表 | 提示去「控制台管理 → 工作台」确认能力并启用 |

- 会话带 `target` 字段并**持久化**：重开一个工作台会话时，切换器会回到「工作台」。
- **同一个文件夹 + 不同目标 = 两个会话**（`ensureSession` 按 devRoot + target 匹配），
  否则"改成做工作台"会拿插件的会话继续、注入的还是插件简报。
- 老会话没有 `target` 字段 → 一律按插件处理（向后兼容）。
- 归一化会**检测"代码用了 run/http/open/storage 但清单没声明"**并给出可读提示 ——
  不声明到用户那儿就是直接失败，提前说比事后排查省事。
- 重载：管理页「重载」会先同步开发目录再重读清单；**重载新增的能力仍需用户确认**才允许启用。

第 ③ 步已就位的东西（管理页直接可用）：

- `host:workbenches:list` → `{ trustNotice, workbenches[], issues[] }`；
  每项含 `id / name / version / description / builtin / active / capabilities[{capability,label}] / unacknowledged[]`。
- `host:workbenches:activate(id)` → 未确认能力时返回 `{ ok:false, error:'capabilities-not-acknowledged', missing[] }`。
- `host:workbenches:acknowledge(id, capabilities)` → 记录用户确认（只接受该工作台真的声明了的能力）。
- `host:workbenches:install(directory)` / `host:workbenches:uninstall(id)`。
- settings preload 已暴露：`workbenches / activateWorkbench / acknowledgeWorkbench / installWorkbench / uninstallWorkbench`。

行为保证（都有测试）：

- **与插件结构性隔离**：工作台在 `<userData>/workbenches/`，插件的任何代码路径都看不到它们，
  所以不需要在 mini 条 / priority / presence 里加任何过滤。
- **独占**：设置里只存一个 `activeWorkbench`；切换是替换不是并列。
- **卸载 active 回落内置**，并把视图一起换过去（不然界面停在已删除的页面上）。
- **新装的工作台不自动启用**，且能力默认未确认。
- **升级新增能力必须重新确认** —— 否则那份能力告知就是空的。
- 内置工作台不可卸载；设置指向不存在的工作台时回落内置并写回日志。

每步都要断言四条最容易写错的行为：**不进 mini 条**、**同时只有一个 active**、
**卸载 active 回落内置**、**安装后不自动启用**。

