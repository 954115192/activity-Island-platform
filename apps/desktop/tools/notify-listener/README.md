# notify-listener · Windows 通知监听器

事件驱动的 Windows 通知中心监听器，替代 `resources/notifications/listener.ps1`。

## 为什么需要它

PowerShell 5.1 的 WinRT 互操作层订阅 `UserNotificationListener.NotificationChanged` 时稳定抛出
`0x80070490 (Element not found)`，只能退化成 2 秒轮询，通知上岛有明显延迟。

C# 版本把轮询间隔压到 120ms（`GetNotificationsAsync` 单次约 0.5–1.5s，间隔只决定检测窗口），
实测检测开销约 200ms。事件订阅在本机（非 MSIX 打包应用）同样失败 `0x80070490`，
所以代码里保留了订阅路径：将来若以 MSIX 分发，会自动切到事件驱动。

## 协议

与 `listener.ps1` 完全一致，主进程无需区分来源。stdout 每行一条 JSON：

| 事件 | 说明 |
|---|---|
| `status` | 权限三态（allowed / denied / unspecified / unavailable）+ 提示文本 |
| `snapshot` | 启动时的存量通知（只进历史，不提醒） |
| `notify` | 新通知：`id` / `app` / `title` / `content` / `ts` |
| `removed` | 通知中心里被删除的 `ids` |
| `tick` | 15 秒心跳，供主进程判断进程是否卡死 |

stderr 只写日志。

## 构建

```bash
cd apps/desktop
npm run build:listener
```

产物 `notify-listener.exe`（自包含单文件，约 11MB）会覆盖到 `resources/notifications/`。
需要 .NET 10 SDK。若在无网络环境构建失败，可加 `-p:SelfContained=false` 先验证代码可编译。

二进制不入库（见 `.gitignore`）；打包前必须执行一次构建，否则应用会回退到 PowerShell 监听器。
