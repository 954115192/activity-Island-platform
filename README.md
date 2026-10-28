# Activity Island Platform

Activity Island Platform 是面向 Windows 电脑与手机的跨设备信息和操作平台。

产品以桌面灵动岛作为主要展示入口，让用户快速看到通知、设备状态、传输进度和任务结果，并完成简短操作。手机配套应用提供另一端的连接与交互；平台服务负责连接、权限、事件路由和传输可靠性；官方模块提供开箱即用的核心功能；扩展支持个人工作流与外部服务接入。

## 产品价值

用户无需打开大型应用，就能看到重要事件，并在灵动岛上完成常见的跨设备操作。

产品围绕五类职责组织：

- **桌面壳层**：呈现信息，管理交互优先级。
- **平台服务**：连接设备、保护数据，提供可靠的基础能力。
- **官方模块**：提供通知、设备和文件传输等默认体验。
- **扩展**：支持个性化服务接入与自动化。
- **工作台**：承接搜索、历史、配置和其他复杂任务。

## 仓库结构

```text
apps/
  desktop/                 Windows 桌面应用
  phone/                   手机配套应用
packages/
  desktop-shell/           灵动岛窗口与桌面交互运行时
  platform-services/      通知、设备、传输、权限与存储服务
  platform-contracts/     带版本的领域类型与服务契约
  official-modules/       官方功能模块
  extension-sdk/          公共扩展接口与开发工具
  shared-ui/              多种界面共用的视觉基础组件
tests/
  contracts/              契约与兼容性测试
  integration/            服务集成测试
  e2e/                    端到端用户流程测试
docs/                     产品与工程决策文档
tools/                    本地开发与发布工具
```

## 开发顺序

1. 定义契约、身份、权限和事件公共结构。
2. 实现桌面壳层和通知展示流程。
3. 实现设备配对与连接生命周期。
4. 实现可靠的局域网文件传输。
5. 完善官方模块和工作台流程。
6. 开放扩展能力、模拟器与自动化接口。
7. 增加其他手机同步功能。

首个完整功能流程是：**Windows 通知 → 灵动岛提醒 → 展开详情 → 执行来源操作**。

## 文档入口

- [产品定位与基础原则](docs/product-foundation.md)
- [系统架构](docs/system-architecture.md)
- [通知内置能力整合设计](docs/notification-integration-design.md)
- [内置 LocalSend 文件传输](docs/localsend-file-transfer.md)
- [功能职责与边界](docs/functional-boundaries.md)
- [开发路线与交付计划](docs/delivery-roadmap.md)
- [开发方法与完成标准](docs/development-method.md)
- [架构决策：产品形态与职责边界](docs/adr-0001-product-shape.md)

