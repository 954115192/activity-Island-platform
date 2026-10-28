---
name: island-workbench
description: 为 Activity Island（Windows 桌面灵动岛，Electron 应用）生成工作台（控制台面板）。当用户想给灵动岛做工作台（系统监控、快捷启动、用量面板、任务聚合页等，右键小岛打开的全屏面板）时使用：生成 workbench.json + dist/ 网页，声明能力、遵守外轮廓与失败上报规范，并指导用户在控制台安装启用。
---

# Activity Island 工作台生成

## 任务与产物

在用户指定的工作文件夹里创建工作台，产物就是一个普通网页工程：

```text
my-workbench/
├─ workbench.json       # 清单（唯一必填文件）
├─ dist/
│  ├─ index.html        # entry 指向它
│  ├─ app.js
│  └─ style.css
└─ preview.svg          # 可选：320×200 界面示意线框，管理页卡片缩略图
```

工作台与**插件是两种东西，不要混用**：插件常驻 mini 条（preload 是 `window.dynamicIsland`），工作台右键小岛打开、独占整屏（preload 是 `window.workbench`）。工作台**没有** `island.alert / every / raf / media` 那套 API，也不要生成 `plugin.json`。

安装方式：Activity Island 的「控制台管理 → 工作台 → 选择目录安装」；`.islandplugin` 包导入时宿主按包内清单（`workbench.json` / `plugin.json`）自动分流。**新装的工作台不自动启用**——用户要在详情里确认能力后点「启用」。

## workbench.json

```json
{
  "id": "my-workbench",
  "name": "我的工作台",
  "version": "0.1.0",
  "entry": "dist/index.html",
  "description": "一句话说明它干什么",
  "preview": "preview.svg",
  "size": { "width": 1040, "height": 700 },
  "capabilities": ["system", "storage"],
  "settings": { "fields": [ { "key": "refreshMs", "label": "刷新频率", "type": "select", "default": 2000, "options": [ { "value": 1000, "label": "1 秒" }, { "value": 2000, "label": "2 秒" } ] } ] }
}
```

- `id`：[a-z0-9_-]{1,64}，**不能叫 `builtin`**；`version`：x.y 或 x.y.z；`entry` 包内相对路径，禁止 `..` 和绝对路径
- `preview`：包内相对路径（svg/png/jpg/webp），≤512KB；越界或缺失只是不显示缩略图，不影响安装
- `settings.fields` 与插件同构（text / password / number / boolean / select / color / textarea），宿主在管理页渲染表单；**不要**在工作台页面里自己画设置界面

## 能力声明（必须诚实、最小化）

装一个工作台 = 装一个任意程序，所以 manifest 里声明了什么用户才被允许用什么。**未声明的能力调用直接失败**：`{ ok:false, error:'capability-not-declared:<名>' }`，不是静默失败。只声明页面真正用到的：

| 能力 | API | 说明（用户启用前会看到） |
|---|---|---|
| `system` | `workbench.system.status() / network()` | 读 CPU、内存、网络等系统信息 |
| `open` | `workbench.open(target)` | 打开程序、文件、文件夹、网址 |
| `http` | `workbench.http(url, options?)` | 访问网络（含本机 127.0.0.1） |
| `run` | `workbench.run(command, args?, options?)` | 执行本机命令与脚本 |
| `storage` | `workbench.storage.*` | 保存工作台自己的数据 |
| `shortcuts` | `workbench.shortcuts.*` | 读写跨工作台共享的「快捷启动」列表 |
| `resize` | `workbench.resize({ width, height })` | 改变工作台尺寸（宿主钳制） |

## SDK（window.workbench，宿主 preload 注入）

```js
const wb = window.workbench
wb.exit()                                    // 必须提供退出入口，绑到这个
wb.capabilities()                            // → { ok, id, capabilities } 页面据此自己降级
wb.self()                                    // → 自己的目录等信息（跑包内脚本要绝对路径）
wb.system.status() / wb.system.network()     // 能力 system
wb.open(target)                              // 能力 open：http(s)/mailto 走外部，其余按路径打开
wb.http(url, { method, headers, body, timeoutMs })  // 能力 http：主进程发出，无 CORS，可访问本机服务；响应上限 2MB
wb.run(command, args, { cwd, timeoutMs, shell })    // 能力 run：默认不经 shell；stdout/stderr 各 256KB 上限；默认 60s 超时
wb.storage.get/set/delete/all                // 能力 storage：明文 JSON，密钥类只写不回显
wb.shortcuts.list/add/update/remove          // 能力 shortcuts：宿主拥有的共享数据
wb.resize({ width, height })                 // 能力 resize：返回真实生效尺寸
wb.log.info / warn / error                   // 写日志（管理页「日志」可看）
wb.settings.all()/get()/set()/patch()/schema()/onChange()  // 读用户参数，宿主改了会推过来
wb.close()                                   // 关闭独立窗口模式下的控制台窗口
```

**返回值约定（必须依赖，不要猜）**：成功 `{ ok:true, … }`；失败 `{ ok:false, error:'给人看的中文原因' }`；未声明能力 `capability-not-declared:<名>`。

常见错误：
- **吞失败**：写 `.catch(() => {})` 或忽略 `{ok:false}` = 「点了没反应却像成功」。失败要显示到页面上
- **没用 capabilities() 降级**：没授权的能力对应 UI 应该隐藏（或置灰并说明原因），而不是摆着按钮等报错
- **拿 resize() 做内容自适应**：根元素 height:100% 量到的就是宿主盒子，照它请求永远不收敛（宿主有 <4px 回环守卫）。尺寸写进 `workbench.json` 的 `size`
- **忘了退出入口**：右上角或明显位置必须有「退出工作台」→ `wb.exit()`

## 视觉规范（外轮廓归宿主，必须遵守）

1. `html, body` 100%×100%、`overflow:hidden`，底色透明或纯黑
2. **禁止外层圆角卡片、边框、外阴影**：小岛胶囊是唯一外轮廓，宿主弹簧动画逐帧裁剪。页面背景用「从中心向四周衰减到纯黑」的径向渐变（`radial-gradient`），弹簧过冲时露出的边缘才不会出现一圈色差
3. 默认尺寸 1040×700，要改写进 `workbench.json`（运行时钳制 720×480 ~ 1280×860）；**不要**用 `window.resizeTo`（Electron 里是空操作）
4. 隐藏/关闭后不要再跑轮询；要频繁刷新就节流（刷新间隔可做成 `settings.fields` 偏好）
5. 密钥类数据存 `storage` 是明文 JSON：界面只显示「已配置」，**不要回填到输入框**

## preview.svg（强烈建议提供）

320×200 的界面示意线框（浅灰描边 + 深底色，画出主要区块布局即可，不追求像素级）。管理页卡片列表只有「名字 + 示例图」，用户就是看它决定装不装。

## 自检与安装

工作台没有开发目录自动热重载（与插件不同），改完文件后：

1. 「控制台管理 → 工作台」如果还没装：点「选择目录安装」选中本文件夹；已装过：详情里点「重载」
2. 详情里核对能力列表 → 点「启用」（有未确认能力会先弹确认框）
3. 右键小岛打开工作台验证；出问题用详情里的「日志」看 `wb.log` 与未捕获异常
4. 分发：详情里「导出插件包」生成 `.islandplugin`，对方在「控制台管理 → 工作台 → 从插件包导入」装（或「插件 → 导入插件包」，同一个入口自动分流）
