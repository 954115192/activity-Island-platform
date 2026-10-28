# 通知内置能力整合设计

## 背景与目标

将两个通知来源从插件形态升级为软件内置能力，并调整通知的展示与历史归属：

1. **Windows 通知接入**：监听 Windows 通知中心，把系统内所有应用的通知转化为平台通知事件。
2. **本地触发接口**：在回环地址开放 HTTP 端口，本机脚本与程序可随时推送通知上岛。

两者都是内置功能的一部分，接入同一条"通知接入管道"，由通知服务统一管理，而不是各建一套。

展示按"轻展示、重管理"划分：

- **小岛**：预览。应用徽标 + 标题，点击进入中岛。
- **中岛**：详情。最新一条通知的完整内容、来源与操作。
- **大岛**：通知模块不再占用，不承载历史列表。
- **通知历史**：从灵动岛移出，由托盘菜单（状态栏通知区域图标右键）的"通知历史"管理器统一承载，所有来源的记录集中一处。

## 设计原则

1. **通知服务是唯一接入点**。所有来源（Windows、本地接口，将来的手机同步与扩展）产出同一种标准化事件，下游只认事件，不关心来源。
2. **灵动岛无状态**。去重、过滤、历史都在服务层完成，岛上只做展示。服务重启不牵连窗口，窗口重载不丢数据。
3. **历史写入与提醒分发分离**。每条到达管道的通知全量写入历史（受保留上限约束）；是否在岛上提醒由用户策略决定。静音、过滤、免打扰不影响历史记录。
4. **来源可插拔**。新增来源等于新增一个适配器，管道、契约、展示与历史均不需要改动。

## 领域模型与契约扩展

契约包（`platform-contracts`）新增：

```ts
export type NotificationSourceKind = 'windows' | 'local-trigger' | 'phone' | 'extension'

export interface NotificationPayload {
  sourceKind: NotificationSourceKind
  appId: string            // 来源应用或脚本标识
  appName: string          // 展示名
  title: string
  body: string
  level: 'info' | 'warn' | 'critical'
  group?: string
  icon?: string            // emoji 或 dataURL
  ttlSeconds?: number      // 提醒停留时长，缺省由策略决定
  dedupeKey?: string       // 同 key 在窗口期内合并
  actions?: NotificationAction[]   // id + label + 可选 url
  raw?: string             // 仅 sensitivity: sensitive 时保留的原始载荷
}
```

事件类型：

| 事件类型 | 含义 |
|---|---|
| `notification.received` | 新通知到达 |
| `notification.updated` | 内容更新（Windows 通知可被应用修改） |
| `notification.dismissed` | 通知被移除（用户清除或来源撤回） |
| `notification.actioned` | 用户触发了通知上的操作 |

契约同时扩展：

- `EventSource` 联合类型增加 `'external'`：本地接口的调用方不是安装进来的扩展，需要与 `extension` 区分。`subject` 字段存放 `appId`。
- 能力标识补充 `notifications.create:external`（本地接口使用）与 `notifications.manage:history`（历史管理器使用）。

`eventId` 由服务端生成，沿用 `DomainEvent` 按 `eventId` 幂等的既有约定；`dedupeKey` 由管道在合并窗口内折叠重复推送。

## 通知服务结构

```text
platform-services / notification
├─ IngestPipeline        唯一入口 ingest(event)
│   归一化 → eventId 幂等 → dedupeKey 合并 → 写入历史 → 按策略分发 EventRouter
├─ NotificationSource    来源适配器接口（start / stop / status / health）
├─ WindowsNotificationSource   伴生进程管理 + 协议解析
├─ LocalTriggerSource    请求 → 事件映射 + 响应构造（传输层注入，纯逻辑可测）
└─ HistoryStore          历史持久化与查询（PlatformStorage 实现）
```

来源适配器接口：

```ts
interface NotificationSource {
  readonly kind: NotificationSourceKind
  start(): Promise<void>
  stop(): Promise<void>
  status(): SourceStatus          // 含权限三态、健康状态，供界面展示
}
```

职责归属遵循既有边界文档：桌面壳层只接收状态事实与操作意图；业务逻辑在服务层；桌面应用入口（`apps/desktop`）负责组装。

## Windows 通知来源

Electron 主进程无法直接调用 WinRT，采用独立 C# 伴生进程：

- 实现为小型 .NET 程序（CsWinRT / Windows SDK projection），以 NativeAOT 单文件发布，源码位于 `tools/listener/`，构建产物随 `apps/desktop` 资源分发并签名。
- 通过 `UserNotificationListener` 访问通知中心：**订阅 `NotificationChanged` 事件实时推送**，轮询仅作降级路径；启动时执行一次存量回填。
- 与主进程之间用 stdin/stdout NDJSON 通信，沿用插件版已验证的事件协议：`status`（权限三态）/ `notify` / `updated` / `removed` / `tick`（心跳）。崩溃后指数退避自动重启。
- 权限：`RequestAccessAsync` 结果进入 `PermissionService`，界面上呈现"待授权 / 未授权 / 监听中"三态，被拒时提供系统设置跳转。应用需设置自身的 `appUserModelId`，保证授权归属清晰。
- 文本提取：读取 `Visual.Bindings` 的 `GetTextElements()`，优先 `ToastGeneric` 模板（首段标题、其余正文）；提取失败的降级为"应用名 + 摘要"。原始 XML 仅在 `sensitivity: sensitive` 时保留。
- 点击中岛的操作按钮可通过伴生进程 `ActivateAsync` 触发原通知的默认动作。
- Windows 不提供程序化隐藏其他应用横幅的能力。"接管"的呈现方式：设置页引导用户对选中的应用改为"仅显示在通知中心"，通知中心照收，岛照报，原生横幅不再出现。

## 本地触发来源

- 传输：主进程内 Node HTTP 服务，默认 `127.0.0.1:5720`，仅回环绑定，端口可配置；实际端口写入 `%APPDATA%\ActivityIsland\local-api.port` 供脚本发现。端口占用时产生 `conflict` 结构化错误并提供更换端口路径。
- 接口（v1）：

| 方法与路径 | 用途 | 认证 |
|---|---|---|
| `GET /api/v1/health` | 存活与端口发现 | 无（不返回数据） |
| `POST /api/v1/notifications` | 推送通知 | Bearer token |
| `DELETE /api/v1/notifications/{eventId}` | 撤回仍在展示的通知 | Bearer token |

  请求体沿用插件版验证过的宽松解析：支持 JSON / form / 纯文本 / 查询串兜底，字段别名（`title/name/subject`、`content/message/text/body`），可选 `level` / `ttl` / `color` 映射到统一载荷。

- 安全：默认回环绑定；Bearer token 用 `safeStorage` 存入系统凭据库，设置页可查看与重置；请求体上限 64 KB；按调用方限速；CORS 默认关闭。本地接口产生的通知在界面上带"本地接口"来源徽标，`critical` 级是否可越过勿扰由用户设置决定。
- 事件来源标记为 `source: 'external'`，与系统通知共用同一管道、同一过滤策略、同一历史。

## 灵动岛展示

通知模块在灵动岛上只占用小岛与中岛两态：

- **小岛（预览）**：提醒到达时短暂出现——应用徽标 + 标题（正文一行截断），按内容自适应宽度，停留后释放展示位。平时不占位。
- **中岛（详情）**：最新一条通知的完整视图——应用、时间、正文全文、操作按钮，以及监听状态（权限三态、暂停开关）。点击操作按钮触发对应动作。不再承载列表。
- **中岛收起**回到小岛；通知模块不进入大岛，大岛留给传输进度等复杂任务。
- 提醒分发策略在管道的 policy 阶段执行，模块只拿到"允许提醒"的事件：应用允许/忽略名单（两类来源共用一套）、免打扰时段、暂停开关、总开关。

## 通知历史管理器

历史是管理功能而非展示功能，从灵动岛移出：

- **入口**：托盘图标右键菜单的「通知历史」为主入口；设置页通知分区提供同一入口。
- **形态**：独立窗口（工作台面板），集中展示所有来源的通知记录：时间、来源、应用、标题、正文、级别。
- **能力**：按来源 / 应用 / 时间 / 级别筛选与搜索；单条删除与清空；跳转来源应用；按应用快速静音（写入过滤策略）。
- **清空范围**：清空前弹系统确认框，二选一——只清应用内历史，或同时清空 Windows 通知中心。两者是独立数据，Windows 侧失败不影响应用内清空。
- **Windows 侧清空实现**：`resources/notifications/clear.ps1`。实测本机 `ClearNotifications()` 抛 `0x80070490 (Element not found)`，而 `RemoveNotification(id)` 稳定可用，因此逐条删除（实测 41/41 成功）。
- **数据**：只读 `HistoryStore` 的查询接口（能力 `notifications.query:history`），渲染进程不直接接触存储。
- **保留策略**：默认上限 500 条或 30 天，可配置；`sensitive` 载荷不落历史，只保留摘要字段；清理随 PlatformStorage 的保留机制执行。

历史写入自管道上线第一天就生效（写入在 ingest 内完成），读取界面可以后置交付，这也是统一落盘的直接收益。

## 与插件实现的对照

| 插件版 | 内置版 |
|---|---|
| PowerShell 2 秒轮询 | C# 伴生进程事件驱动，毫秒级到达 |
| PS 5.1 WinRT 互操作随机错误 | CsWinRT，无互操作层 |
| HttpListener + URLACL / 管理员 / 主机名前缀问题 | Node HTTP 绑回环，无系统权限要求 |
| 端口无鉴权、管理员时全网卡 | Token + 仅回环 + 限速 |
| 每个插件独立历史，存于岛屿 storage | 统一 HistoryStore，窗口重载不丢，跨来源集中 |
| 历史挤占大岛 | 岛上轻展示，历史进托盘管理器 |
| `snapshot/notify/removed/status/tick` 协议 | 协议沿用，新增 `updated` 事件 |

## 里程碑与验收标准

按路线图顺序推进，全程使用模拟适配器开发（不依赖真实 Windows 通知状态即可开发壳层与界面）：

1. **M1（路线图 0.2 主体）**：契约扩展、IngestPipeline、LocalTriggerSource、模拟 Windows 源、小岛/中岛展示、HistoryStore 落盘。验收：`curl` 一条 POST 上岛并带来源徽标；同 `dedupeKey` 两条合并；历史已落盘可查询。
2. **M2**：WindowsNotificationSource 伴生进程、权限三态界面、按应用过滤与暂停。验收：真实 Windows 通知只展示一次、可看详情、可打开来源；通知中心删除后状态同步；不影响壳层稳定性。
3. **M3**：托盘通知历史管理器、设置整合、保留策略与清理。验收：两类来源的记录集中呈现，筛选与清空可用，敏感载荷未落盘。

错误路径验收贯穿各阶段：通知权限被拒、伴生进程崩溃、端口占用、请求格式非法，均产生结构化错误并提供恢复入口，不产生静默失败。

## 实现位置

| 职责 | 位置 |
|---|---|
| 通知管道、策略、历史 | `apps/desktop/electron/notifications/`（同步自 `packages/platform-services`） |
| Windows 通知监听 | `apps/desktop/electron/notifications/windows-source.ts` + `resources/notifications/listener.ps1` |
| 本地触发接口 | `apps/desktop/electron/notifications/local-trigger.ts`（Node HTTP，回环绑定） |
| 内置展示模块 | `apps/desktop/modules/system-notifications/`（小岛预览、中岛详情） |
| 通知历史管理器 | 托盘右键「通知历史」→ `modules/system-notifications/history.html` |
| 组装与 IPC | `apps/desktop/electron/main.ts`（内置模块根、设置同步、生命周期、托盘入口） |

两点维护约束：

1. **双份源码**。Electron 主进程编译为 CommonJS，无法直接消费 ESM 源码包，因此 `electron/notifications/` 是 `packages/platform-services/src/notification/` 的同步副本（文件头有标注）；`packages/` 那份是被测试覆盖的规范源，两边契约变更需同步。
2. **内置模块不是插件**。`modules/` 作为额外根目录注册进 `PluginManager`，发现后标记为内置：不可卸载、不可被用户目录同 id 覆盖、不参与源码热重载。它复用岛的视图运行时（三态布局、提醒仲裁、设置表单），但数据由主进程直接提供，不经过后台脚本。
3. **listener.ps1 必须在 asar 之外**。PowerShell 无法读取 asar 内文件，因此脚本走 `extraResources` 落到 `resources/notifications/`。

