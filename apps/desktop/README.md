# activity-Island-platform 桌面端

当前可运行的产品是 Windows Electron 桌面应用。功能概览、手机 HTTP 通知接入步骤和源码运行方式见[仓库首页](../../README.md)。目前没有配套手机应用。

桌面端内置 Windows 通知、HTTP 触发通知、LocalSend 兼容文件/文本传输，以及系统状态和快捷启动工作台；网页插件用于扩展功能。插件本身需要自行安装。

## 开发与构建

从仓库根目录执行：

```powershell
npm install
npm run dev
npm run build
npm run start --workspace @activity-island-platform/desktop
```

原生通知监听器使用 .NET 10。安装相应 SDK 后执行：

```powershell
npm run build:listener --workspace @activity-island-platform/desktop
```

监听器缺失时，应用回退到 PowerShell 轮询。打包命令会先构建原生监听器：

```powershell
npm run dist --workspace @activity-island-platform/desktop
npm run dist:portable --workspace @activity-island-platform/desktop
```

输出目录为 `apps/desktop/release/`，文件名使用 `activity-Island-platform`。

## 主要模块

| 目录 | 职责 |
| --- | --- |
| `electron/island/` | 岛的状态、布局、提醒仲裁、鼠标交互与过渡 |
| `electron/notifications/` | Windows 通知接入与共享通知服务适配 |
| `electron/transfers/` | LocalSend 兼容服务与传输面板 |
| `electron/plugins/` | 插件安装、视图、后台脚本、日志与热重载 |
| `electron/workbench/` | 工作台管理、授权及页面 API |
| `electron/settings/` | 设置存储、生效和设置窗口 |
| `src/host/` | 透明窗口内的岛壳、动画与交互 |
| `console-apps/` | 设置管理页面与内置工作台 |
| `modules/` | 内置通知和文件传输界面 |
| `scripts/` | 构建、脚手架与测试 |

模块之间的依赖与状态归属见[主进程导航](../../docs/main-process-structure.md)。

## 插件和工作台

- 「控制台管理 → 插件」支持从目录或 `.islandplugin` 包安装，管理启停、排序、模式、参数和日志。
- 插件使用独立网页，通过 SDK 请求提醒、展开和尺寸变更；岛的外轮廓和动画由宿主管理。
- 开发目录改动可同步到安装目录并热重载。
- 工作台独立管理，安装后需要确认声明的能力并启用；右键小岛或从托盘打开。
- 生成规范：[插件](skills/island-plugin/SKILL.md)、[工作台](skills/island-workbench/SKILL.md)。

## 验证

从仓库根目录执行：

```powershell
npm run typecheck
npm test
npm run test:desktop
npm run test:settings --workspace @activity-island-platform/desktop
npm run test:workbench --workspace @activity-island-platform/desktop
npm run test:transfer-ui --workspace @activity-island-platform/desktop
npm run test:shutdown --workspace @activity-island-platform/desktop
```

这些测试覆盖类型、平台服务、IPC 契约、插件管理、界面、工作台、传输和退出流程。它们不代替不同电脑的 Windows 通知编码、通知授权和手机实机互传验证。

## 名称与用户数据

产品名为 `activity-Island-platform`，npm 包名为 `@activity-island-platform/desktop`。为兼容旧安装，数据目录继续使用 `%APPDATA%\dynamic-island-host\`，Windows AppUserModelID 保持 `com.activity-island.host`。

卸载时可选择保留或删除用户数据。保留数据后，重新安装可继续读取原有设置、插件和工作台。

