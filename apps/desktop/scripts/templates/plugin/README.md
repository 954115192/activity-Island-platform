# __NAME__

Activity Island 插件（由 `scripts/new-plugin.mjs` 从模板生成）。

## 开发

1. 直接在 `dist/` 里改 `index.html` / `app.js` / `style.css`（普通网页，想用框架自己加构建）。
2. 在「控制台管理 → 插件 → 添加插件 → 选择文件夹安装」装上 —— 宿主会记住源码目录，**之后改这里的文件会自动同步并热重载**。
3. 调试信息写到 `island.log.info/warn/error()`，在「控制台管理 → 插件 → ⋯ → 日志」里看。

## 打包与分发

```powershell
pwsh -File .\pack.ps1          # 生成 <id>-<version>.islandplugin
```

别人在「控制台管理 → 插件 → 导入插件包」里选这个文件即可安装。

## 契约要点（全文 docs/plugin-contract.md）

- 页面 `100% × 100%` 自适应；底色透明或纯黑，不要外层圆角/边框/阴影/外边距。
- hover 与展开动画由宿主负责，插件不要自己缩放或位移。
- 隐藏时不要轮询：用 `island.every()` / `island.raf()` / `island.fitCanvas()`。
- 颜色、圆角用 CSS 变量 `--island-*`。
- 提醒用 `island.alert({ key, level, ttl })`，独占展开用 `island.focus({ view })`，结果在 `island.onIntent()`。
