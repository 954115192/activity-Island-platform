# activity-Island-platform

一个运行在 Windows 上的桌面灵动岛，用来展示通知、运行网页插件，并在岛内处理文件传输和工作台操作。

**目前只有 Windows 桌面应用，没有配套的 Android 或 iOS 应用。** 手机接入通知的方式是：由手机上的自动化工具或其他能够发送 HTTP 请求的程序，调用电脑开放的通知接口。这需要自行配置请求，不会自动同步手机的全部通知。

![桌面灵动岛](apps/desktop/docs/images/03-minibar.png)

## 现在能做什么

| 功能 | 当前能力 |
| --- | --- |
| 桌面灵动岛 | 浮动或贴顶收起、悬停展开、插件小/中/大视图、提醒光圈和展开收起动画；可调整顶部距离与缩放 |
| Windows 通知 | 读取 Windows 通知并在岛上提醒，查看和清理通知历史；可配置来源过滤、免打扰和提醒停留时间，需要 Windows 通知访问权限 |
| HTTP 端口通知 | 本机脚本、其他程序或局域网设备通过 HTTP 请求推送通知，支持标题、正文、级别和停留时间，使用访问令牌鉴权 |
| 文件与文本传输 | 内置 LocalSend v2 兼容服务，支持局域网设备发现、文件/文件夹发送、文本与链接收发、接收确认、进度、取消和传输记录 |
| 工作台 | 右键小岛或从托盘打开；内置系统状态与快捷启动面板，也可安装自定义工作台，并按其声明确认能力授权 |
| 网页插件 | 从本地目录或 `.islandplugin` 包安装，支持启停、排序、常驻/提醒模式、参数设置、日志、导出与开发热重载 |
| 桌面管理 | 托盘入口、设置窗口、开机启动设置，以及全屏时隐藏小岛 |

通知、文件传输和内置工作台随桌面应用提供，不需要另外安装插件。其他插件需要自行安装或开发；文档中的插件示例不代表安装后自带这些插件。

## 手机如何触发通知

手机通过通知 HTTP 接口向电脑发请求，电脑收到后在灵动岛上显示提醒。

1. 在电脑端打开「控制台管理 → 通知」，启用触发接口。
2. 将可访问范围从「仅本机」改为「局域网内所有设备」，保存并确认。
3. 复制页面显示的实际端点和访问令牌。默认端口是 `5720`，以页面显示为准。
4. 手机与电脑连接到可互相访问的局域网，并在 Windows 防火墙中允许应用的专用网络访问。
5. 在手机的自动化工具或 HTTP 请求工具中配置以下请求。

```http
POST http://<电脑局域网IP>:5720/api/v1/notifications
Authorization: Bearer <通知页中的令牌>
Content-Type: application/json; charset=utf-8

{
  "title": "手机提醒",
  "content": "这是一条通过端口发送的通知",
  "level": "info",
  "ttl": 6
}
```

请求正文使用 UTF-8。`level` 可选 `info`、`warn`、`critical`，`ttl` 表示停留秒数。手机端不能填写 `127.0.0.1`，应使用电脑的局域网地址；接口默认仅允许本机访问，需要按上述步骤开放局域网范围。

也可以在电脑上用 PowerShell 测试，以下示例显式按 UTF-8 发送中文：

```powershell
$token = '替换为通知页中的令牌'
$payload = @{ title = '测试通知'; content = '中文通知测试'; level = 'info'; ttl = 6 } | ConvertTo-Json
Invoke-RestMethod -Method Post `
  -Uri 'http://127.0.0.1:5720/api/v1/notifications' `
  -Headers @{ Authorization = "Bearer $token" } `
  -ContentType 'application/json; charset=utf-8' `
  -Body ([System.Text.Encoding]::UTF8.GetBytes($payload))
```

该接口负责接收调用方发送的内容，不会主动读取手机通知。当前没有设备配对、账户登录或云端通知中继；不要把通知端口直接暴露到公网，也不要公开访问令牌。

## 局域网传输

从托盘的「文件传输 · LocalSend」、内置工作台或向小岛拖入文件打开传输面板。

- 发送文件或文件夹，追加、移除文件，选择目标设备后发起传输。
- 发送文本与链接；接收文本后可预览、复制或打开 HTTP/HTTPS 链接。
- 接收方确认后才开始文件传输，面板收起后任务继续运行。
- 可查看进度、取消任务、查看历史，并修改设备名称与接收目录。

这是桌面端内置的 LocalSend 兼容能力。手机如需传文件，可使用第三方 LocalSend 客户端；这与通过 HTTP 端口推送通知是两套独立功能。当前没有断点续传或公网传输中继；手机实机兼容性仍需按具体设备验证。

## 源码运行

需要 Windows、Node.js 22 或更高版本及 npm。

```powershell
git clone https://github.com/954115192/activity-Island-platform.git
cd activity-Island-platform
npm install
npm run dev
```

开发模式下，如需使用原生 Windows 通知监听器，先安装 .NET 10 SDK 并构建：

```powershell
npm run build:listener --workspace @activity-island-platform/desktop
```

监听器未构建时会回退到 PowerShell 通知监听，延迟较高。Windows 通知功能仍取决于系统版本、通知访问授权与来源应用。

构建与运行生产代码：

```powershell
npm run build
npm run start --workspace @activity-island-platform/desktop
```

生成安装包或便携版（需要 .NET SDK 构建通知监听器）：

```powershell
npm run dist --workspace @activity-island-platform/desktop
npm run dist:portable --workspace @activity-island-platform/desktop
```

产物位于 `apps/desktop/release/`。已有安装的数据目录继续使用 `%APPDATA%\dynamic-island-host\`，保留设置、插件、工作台及历史数据。

## 代码与文档

```text
apps/desktop/                 当前可运行的 Windows 桌面应用
  electron/                   主进程、通知接入、传输、插件与窗口管理
  src/host/                   灵动岛渲染层
  console-apps/               设置与内置工作台
  modules/                    内置通知、文件传输界面
  scripts/                    构建、插件脚手架与测试
  skills/                     插件和工作台生成规范
packages/platform-contracts/  共享类型与服务契约
packages/platform-services/   共享通知服务与存储等实现
tests/                        平台契约与服务集成测试
docs/                         工程说明与设计文档
```

`apps/phone/` 等目录目前是规划占位，不是可安装或运行的手机产品。设计文档中的路线图也不代表当前版本已实现。

- [桌面开发说明](apps/desktop/README.md)
- [主进程模块导航](docs/main-process-structure.md)
- [LocalSend 传输实现说明](docs/localsend-file-transfer.md)
- [插件生成规范](apps/desktop/skills/island-plugin/SKILL.md)
- [工作台生成规范](apps/desktop/skills/island-workbench/SKILL.md)

## 验证

```powershell
npm run typecheck
npm test
npm run test:desktop
npm run test:settings --workspace @activity-island-platform/desktop
npm run test:shutdown --workspace @activity-island-platform/desktop
```

桌面包的许可证声明为 `CC-BY-NC-4.0`。
