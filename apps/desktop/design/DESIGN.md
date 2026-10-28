# DESIGN.md — 灵动岛 Activity Island

> Windows 桌面信息岛：四容器 + 插件驱动 + 工作台 + AI 开发。  
> 本文件是品牌侧视觉/交互规范，跨界面复用；具体产品结构见 `docs/PRODUCT.md`。

## Identity

Product UI Designer — 先问「用户 90% 时间看到的是哪个状态」，再谈风格。

## Grounding

已有三张真实截图（小岛余额胶囊 / 中岛 DeepSeek 明细 / 系统工作台），信号充足。  
假设：延续现有「近黑悬浮岛 + 冰蓝数据点 + 玻璃卡片」语言，把它系统化为可扩展的插件容器体系；不重做品牌色。  
刻意搁置：Figma 源文件落地（本机 Figma MCP 未连接）。

---

## 1. Objective

任何交付物都应让人感觉到：**信息被收进一个安静的桌面器官里，需要时才说话。**  
质量线：在 0.3 秒扫读中仍能回答「现在什么在岛上、值不值得展开」。

## 2. Product Context

- **What the product does:** 用插件把关键状态/消息收进 Windows 顶栏式灵动岛（小/中/大）与右键工作台，支持长期占岛与临时突出。
- **Who it's for:** 同时挂着 API 余额、系统负载、下载/会议/协作通知的开发者与效率用户；习惯多任务、讨厌被通知中心打断。
- **Adjacent brands (feel like these):** Apple Dynamic Island / iOS Live Activities · Raycast 的紧凑命令面板 · Notion Calendar 的安静日程条
- **Distant brand (do not feel like this):** Windows 通知中心磁贴堆叠 — 信息量大但无层级，全是平等方块。
- **Cultural register:** technical-calm（技术冷静）。像仪表，不像社交动态流。

## 3. Visual Foundations

### 3a. Color

从现有截图反推并固化：

| Token | Value | Usage |
|---|---|---|
| `--island-bg` | `#000000` | 小/中岛主体，全不透明或 92% + blur |
| `--panel-bg` | `#0C0C0E` | 大岛 / 工作台 / 设置底 |
| `--surface-1` | `#18181B` | 容器内卡片 |
| `--surface-2` | `#222226` | 次级面板、输入框 |
| `--stroke` | `#2E2E33` | 1px 分隔与描边 |
| `--ink` | `#F4F4F5` | 主数字/标题 |
| `--ink-muted` | `#A1A1AA` | 标签、时间戳 |
| `--ink-faint` | `#71717A` | 脚注、禁用 |
| `--accent` | `#3B82F6` | 状态点、主操作、焦点 |
| `--accent-soft` | `#3B82F61F` | 选中底、光晕 |
| `--success` | `#22C55E` | 正常/在线 |
| `--warning` | `#F59E0B` | 额度偏低、提醒 |
| `--danger` | `#EF4444` | 失败、额度耗尽 |
| `--temp-glow` | `#60A5FA` | 临时消息突出时的岛缘光晕 |

**Usage rules**

- 强调色 **一屏只承载一个「当前事实」**：余额点、主按钮、焦点环——不作大面积背景。
- 岛体永远近黑；颜色来自插件数据语义，不来自装饰渐变。
- 临时消息可给岛体加 `box-shadow: 0 0 0 1px var(--temp-glow), 0 0 24px #3B82F640`，持续 2–6s 后回落。
- 禁止紫蓝青彩虹渐变英雄图；禁止给每个卡片上不同主题色。

### 3b. Typography

- **Display / 数据:** `"Segoe UI Variable Display", "MiSans", "PingFang SC", system-ui, sans-serif` — 权重 600–700，用于金额、百分比、主标题
- **Body:** `"Segoe UI", "MiSans", "Microsoft YaHei", system-ui, sans-serif` — 400–500
- **Mono / 时间戳 / 命令:** `"Cascadia Code", "SF Mono", Consolas, monospace` — 400
- **Fallback stack:** 同上逐级回退；布局不依赖网络字体
- **Type scale (px):** `11 / 12 / 13 / 14 / 16 / 20 / 28 / 36`
  - 小岛标签 12–13，主数值 14–16
  - 中岛卡片标签 12，数值 22–28
  - 工作台模块标题 13–14，KPI 数值 24–28
- **Weight discipline:** 正文 ≤500；数字与标题可用 600/700；不用斜体表示状态。

### 3c. Spacing & rhythm

- **Base unit:** `4px`
- **Scale:** `4 · 8 · 12 · 16 · 20 · 24 · 32 · 40 · 48`
- **岛屿密度（高）:** 小岛内边距 `8–12`，元素间距 `8`；中岛 `12–16`
- **工作台密度（中高）:** 卡片间距 `12`，模块间距 `20–24`，页边 `24`
- **「留白充足」在本产品中的含义:** 工作台模块之间 ≥20px；小岛绝不塞超过 4 个插件槽（第 5 个进溢出）

### 3d. Component seeds

| Component | Spec |
|---|---|
| **小岛胶囊** | height 36–44px，radius 999，`--island-bg`，水平 flex，插件槽用 8px 间隔 + 6px 状态点 |
| **中岛容器** | min-width 320，radius 24，padding 16，内部 1–2 列 metric card |
| **大岛容器** | min-width 420–560，radius 24–28，可滚动模块栈 |
| **工作台** | ~920×560 浮层，radius 20，顶栏 + 网格模块 + 参数底栏 |
| **Metric Card** | `--surface-1`，radius 12，标签 12 muted，数值 display，可选副文案 |
| **Button** | primary=`--accent` 文字白；ghost=透明 + stroke；radius 8–10；高度 28–32（岛内）/ 36（工作台） |
| **Toggle** | 开=`--accent`，关=`--surface-2`；胶囊 36×20 |
| **Status Dot** | 6–8px；成功绿/警告琥珀/危险红/主强调蓝 |
| **插件槽 Chip** | 图标/首字 + 短标签，点选展开中岛 |
| **Iconography** | 线性 1.5–2px 描边（Lucide 风格），不混 emoji 作 UI 图标 |

**岛屿圆角阶梯（签名几何）**

```
小岛  ████████████  r=999  (pill)
中岛  ████████████  r=24
大岛  ████████████  r=28
工作台 ████████████ r=20
卡片  ████████████  r=12
```

## 4. Accessibility

- **Text contrast:** body ≥4.5:1（`#A1A1AA` on `#000` / `#18181B` 已达标）；大数字 ≥3:1
- **Motion:** 临时消息脉冲 ≤3Hz；`prefers-reduced-motion: reduce` 时改为边框色切换，无缩放/脉冲
- **Focus indicators:** `outline: 2px solid var(--accent); outline-offset: 2px`；岛内键盘焦点同样适用
- **Alt / 语义:** 插件图标若含信息需旁路可读标签（`aria-label`）；纯装饰光晕 `aria-hidden`
- **触达:** 岛内可点目标 ≥28px（鼠标）；工作台 ≥36px
- **状态不只靠颜色:** 余额过低同时显示文字「偏低」，不仅靠红点

## 5. Voice & Tone

- **Register:** 技术冷静、短句、可执行
- **Sentence rhythm:** 标签 2–6 字；说明 1 行；错误信息写清原因与下一步
- **Words this brand uses:** 占岛 · 突出 · 工作台 · 插件 · 同步 · 余额 · 槽位 · 启动
- **Words this brand refuses:** 赋能 · 一站式 · 极致体验 · 智能生态 · 强强联合 · 打造闭环
- **Address:** 默认「你」；系统状态用无人称陈述（「额度偏低」）

## 6. Implementation Practices

- **Token format:** CSS custom properties（`--island-*`），可同时映射 Figma Variables
- **Component library:** 自绘宿主壳 + 插件贡献 UI（Webview/HTML 片段）；公共控件走 token，不各自 hex
- **Image treatment:** 默认无摄影；插件图标 SVG/单色；工作台图表用代码绘制（sparkline / bar）
- **Grid system:** 小岛横向槽位流；中岛 2 列 metric；工作台 4+2+2 模块网格（见 PRODUCT.md）
- **Motion rules:**
  - 岛态切换：`180–240ms`，`cubic-bezier(0.22, 1, 0.36, 1)`
  - 临时突出：进入 160ms scale/y，停留 2–6s，退出 200ms
  - 工作台开合：从右键锚点 200ms fade+scale(0.98→1)
  - 禁止：无限闪烁、大幅弹跳、整岛持续呼吸光
- **Window shell:** 无边框、点击穿透关闭工作台、岛默认贴屏幕短边中心或用户锚点；DPI 感知 100–200%

## 7. Anti-Patterns

- **No 通知中心复刻。** 平等磁贴网格抹掉优先级，与「岛」的层级承诺冲突。
- **No 多主题色插件皮肤。** 插件可换数据与图标，不可换宿主圆角/底色，否则岛不再是一体。
- **No 工作台多开。** 同时只允许一个工作台实例，避免桌面变成多窗口仪表盘。
- **No emoji 当状态图标。** 桌面专业场景下 emoji 拉低系统感；用线性图标 + 文案。
- **No 装饰性数据。** 工作台每个模块必须能回答一个用户问题；答不出的模块默认折叠或删除。
- **No 小岛无限插件。** 槽位有限 + 溢出计数；塞满会破坏「一眼可读」。

## 8. Decision-Making

冲突时按此优先级：

1. **可读性 > 美观。** 文字糊、对比不够时先改字色/字号，再谈氛围。
2. **一层一个答案。** 小岛只回答「发生了什么」，中岛答「细节是什么」，工作台答「系统/插件全景」。
3. **插件服从宿主。** 插件想要的颜色/动效若破坏岛语言，宿主否决。
4. **临时优先于长期。** 临时消息可打断长期占岛展示，但必须自动回落，不可永久霸占。
5. **工作台独占、插件并行。** 资源紧张时先保岛的渲染，再保后台插件刷新。
6. **设置可逆。** 所有开关即时生效可回滚；破坏性操作二次确认。

## 9. Workflow

1. 读本 DESIGN.md + `docs/PRODUCT.md`（结构与插件契约）
2. 确认交付容器：小岛 / 中岛 / 大岛 / 工作台 / 设置 / AI 聊天
3. 列出该界面「90% 时间状态」与临时打断态
4. 用 token 填色与字号，不引入新 hex
5. 排 IA：先主数字/主操作，再元数据
6. 画状态：空 / 载入 / 正常 / 异常 / 临时突出
7. 自检 Anti-Patterns §7 与 contrast
8. 若进 Figma：Variables 对齐 §3，组件用圆角阶梯 §3d；当前会话无 Figma MCP 时以 HTML showcase 为准

---

## Decision Trace（关键选择）

```json
[
  {
    "decision": "延续近黑岛体 + #3B82F6 强调，而非另起品牌色",
    "reason": "用户三张截图已建立心智；重做色板会切断现有产品连续性",
    "alternatives": ["冷紫未来感", "高对比霓虹绿", "浅色毛玻璃岛"],
    "tradeoff": "视觉冲击力弱于霓虹方案，更依赖排版与状态层次"
  },
  {
    "decision": "四容器职责严格分层：岛=扫读，工作台=全景，设置=管理",
    "reason": "产品信息架构是四个容器而非多窗口应用；层级错位会让人打开工作台找余额",
    "alternatives": ["中岛承担全部操作", "设置塞进右键菜单全量项"],
    "tradeoff": "少数高级配置多一次点击到设置页"
  },
  {
    "decision": "小岛槽位有限 + 临时消息优先插入",
    "reason": "截图显示小岛是胶囊扫读件；多插件并行展示需要硬槽位纪律",
    "alternatives": ["小岛可无限横向滚动", "只允许单插件占岛"],
    "tradeoff": "超过槽位的插件只能溢出或被用户手动置换"
  },
  {
    "decision": "工作台全局单例，插件运行时多例并行",
    "reason": "用户明确约束；也符合「全景仪表盘只看一份」的认知模型",
    "alternatives": ["多工作台分屏", "工作台内嵌多实例 Tab"],
    "tradeoff": "深度对比两个插件面板需来回切换工作台内容"
  },
  {
    "decision": "圆角阶梯 pill/24/28/20/12 作为签名几何",
    "reason": "三张截图已形成「小岛更圆、工作台更方」的隐含规律，固化后插件 UI 可预期",
    "alternatives": ["全界面统一 16px", "完全直角工业风"],
    "tradeoff": "实现时需多套 radius token，不能一个变量打天下"
  },
  {
    "decision": "AI 聊天作为一等公民能力，而非设置里的附属链接",
    "reason": "产品核心差异是「内容由插件驱动且可被 AI 开发」；聊天是生产工具不是帮助文档",
    "alternatives": ["仅文档 + 模板市场", "独立 IDE 窗口"],
    "tradeoff": "需要维护提示词、代码预览与安装确认链路"
  }
]
```

## Anti-slop self-check

clean — 未采用渐变英雄、emoji 功能墙、等权卡片九宫格；余额/系统模块沿用截图中已验证的数据卡片，而非通用 SaaS 统计三件套。
