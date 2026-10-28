# 新版插件架构

## 目标

Dynamic Island Host 是独立插件 Web App 的统一显示终端，而不是插件组件库。

## View 模型

每个启用插件默认拥有一个 `WebContentsView`：

- Small：多个插件 View 横向排列；
- Medium / Large：只显示 Active Plugin 的 View；
- 同一个 View 通过 `host:mode` 消息切换内部界面。

## 边界

```text
Host: window / bounds / mode / layout / lifecycle
Plugin: page / data / internal animation / business logic
```

Host 的窗口动画模块与插件内容动画模块分离。插件不直接操作 Host 窗口。

## 裁剪

小岛外轮廓由 Host 独占负责。动画期间 Host 每帧把一个原生父 `View` 调整为外壳的弹性矩形（矩形裁剪），同时给每个插件 `WebContentsView` 施加圆角裁剪，半径按插件相对小岛边缘的内缩量递减。

父 `View` 的 `setBorderRadius` 只裁剪它自己的绘制，不会裁剪子 `WebContentsView`；真正裁掉插件页面方角的是插件 View 自身的圆角。插件因此不需要绘制小岛底色，透明页面即可（详见 `docs/plugin-requirements.md`）。

## 插件来源与安装

灵动岛**不内置任何插件**：只发现 `<userData>/plugins/<id>/`（`%APPDATA%\dynamic-island-host\plugins`）。开发目录默认是仓库同级的 `island-plugin/<plugin-id>/`（安装时自选），通过控制台管理「插件 → 添加插件 → 选择文件夹安装」（`plugins:install` IPC）走 `PluginManager.installDirectory` 复制安装，卸载即删除该目录。

## 插件契约

宿主与插件之间的消息/命令/仲裁规则见 `docs/plugin-contract.md`（当前契约版本 2）。插件通过宿主注入的 `window.dynamicIsland` 使用 SDK：握手、可见性、真实尺寸/缩放、主题 token，以及 `every()/raf()/fitCanvas()` 这类"默认就守约"的助手。

## 工作台

工作台是宿主自己的全屏面板：右键小岛后小岛弹簧展开成大胶囊，里面是工作台页面（模式 `custom`）。它**不是插件**——走 `custom` 模式、用独立的 `window.workbench` preload（通用能力面 `system`/`open`/`http`/`run`/`storage`/`shortcuts`/`resize`，按声明放行）、打开时隐藏所有插件视图。尺寸默认 1040 × 700，可用 `resize()` 请求。

**它和插件是两种反向的东西**：插件＝环境信息（常驻、极简、越多越好，独占小岛是成本）；工作台＝任务聚合（按需、密集、一屏装下、用完就走，独占小岛是目的）。触发方式也不同：点段＝我要看这个，右键＝我要开始干活。

当前是**单个内置实现**（`console-apps/workbench/`，打进 asar）**外加可安装的多个工作台**（`<userData>/workbenches/<id>/`）。目标是**可多个安装、独占启用、可在控制台管理**；做法是**独立目录 + 复用插件的底层机制**（沙箱、安装、日志、热重载、打包），但**不共用"插件"这个类别**——把工作台塞进插件体系需要在每一处过滤（mini 条 / priority / presence / alert / focus），漏一处工作台就会出现在岛上。独立目录让"不是插件"成为**结构性事实**。

- 工作台清单：`workbench.json`（`id / name / version / entry / capabilities / size`）。内置的 id 固定为 `builtin`，始终存在、不可卸载（右键是宿主的入口，一个都没装时也必须能打开东西）。
- 独占：宿主 `settings.json` 的 `activeWorkbench`（一次只有一个）。新装的不自动启用；卸载 active 会回落内置。
- 能力声明：**因为工作台可分发，声明是必需的而不是装饰** —— 未声明就调不通（`capability-not-declared:<name>`），新增能力还要重新确认才允许启用。

- 契约与现状对照：`docs/workbench-contract.md`
- 工作台开发规范：`build-island-workbench` skill
- ⚠️ 工作台比插件特权大得多：`open`（启动任意程序）、`run`（执行命令）、`http`（任意请求）。
  **它是"可分发应用"，所以能力声明是必需的，不是装饰** —— 装一个工作台等于装一个任意程序。

## 当前阶段

采用受信任插件模型：先实现功能闭环，不做权限、审计、签名和在线市场。插件异常、View 销毁和目录校验只作为运行稳定性基础设施。
