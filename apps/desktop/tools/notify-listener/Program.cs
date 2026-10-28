// Windows 通知监听器（事件驱动）
//
// 为什么是 C# 而不是 PowerShell 5.1：
//   PS 5.1 的 WinRT 互操作层订阅 UserNotificationListener.NotificationChanged 时
//   稳定抛 0x80070490 (Element not found)，实测无法订阅，只能退化成 2 秒轮询。
//   C# + CsWinRT 可以直接 += 订阅，通知到达即回调，延迟从 ~1s 降到毫秒级。
//
// 协议：stdout 每行一条 JSON，与 resources/notifications/listener.ps1 完全一致，
// 主进程（electron/notifications/windows-source.ts）无需区分来源。
//   {"type":"status","access":"allowed|denied|unspecified|unavailable","message":"..."}
//   {"type":"snapshot","items":[{id,app,title,content,ts}, ...]}
//   {"type":"notify","id":"...","app":"...","title":"...","content":"...","ts":0}
//   {"type":"removed","ids":["..."]}
//   {"type":"tick","ts":0,"count":0}
// stderr 只写日志，不参与协议。

using System.Runtime.InteropServices;
using System.Text;
using Windows.UI.Notifications;
using Windows.UI.Notifications.Management;

namespace NotifyListener;

internal static class Program
{
    private const int TickSeconds = 15;
    /// <summary>
    /// 事件订阅在本机（非 MSIX 打包）稳定失败，实际靠轮询。
    /// GetNotificationsAsync 单次约 0.5–1.5s，所以轮询间隔压得很短：
    /// 延迟 ≈ 间隔 + 单次耗时。订阅成功时事件是主路径，轮询只做兜底。
    /// </summary>
    private const int PollGapWhenSubscribedMs = 1500;
    private const int PollGapWhenPollingOnlyMs = 120;
    private const int SnapshotLimit = 25;

    private static readonly object WriteLock = new();
    private static volatile bool stopping;
    private static volatile int activeCount;

    [STAThread]
    private static int Main()
    {
        // 关键：UserNotificationListener.NotificationChanged 的事件订阅要求进程有
        // 显式设置的 AppUserModelID，否则 add_NotificationChanged 抛 0x80070490
        // (Element not found)。与宿主应用保持同一个 AUMID。
        try { SetCurrentProcessExplicitAppUserModelID("com.activity-island.host"); }
        catch (Exception ex) { Log("设置 AUMID 失败：" + ex.Message); }

        try
        {
            return Run();
        }
        catch (Exception ex)
        {
            EmitStatus("unavailable", "监听器异常：" + ex.Message);
            Log(ex.ToString());
            return 1;
        }
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SetCurrentProcessExplicitAppUserModelID(string appId);

    private static int Run()
    {
        UserNotificationListener? listener;
        try
        {
            listener = UserNotificationListener.Current;
        }
        catch (Exception ex)
        {
            EmitStatus("unavailable", "无法创建通知监听器：" + ex.Message);
            return 2;
        }

        if (listener is null)
        {
            EmitStatus("unavailable", "当前系统不支持读取通知中心");
            return 2;
        }

        var access = EnsureAccess(listener);
        EmitStatus(AccessName(access), AccessMessage(access));

        // 权限被拒时低频轮询，等用户在系统设置里打开后自动继续。
        while (access != UserNotificationListenerAccessStatus.Allowed && !stopping)
        {
            Thread.Sleep(3000);
            access = ReadAccess(listener);
            if (access == UserNotificationListenerAccessStatus.Allowed)
                EmitStatus("allowed", "已连接到通知中心");
        }

        if (stopping) return 0;

        var known = new HashSet<uint>();
        var dedupe = new Dictionary<uint, string>();

        // 首次快照：只放历史，不提醒（主进程按 snapshot 事件处理）。
        try
        {
            var existing = FetchAll(listener);
            var items = existing
                .OrderByDescending(n => SafeCreationTime(n))
                .Take(SnapshotLimit)
                .Select(n => Convert(n, dedupe))
                .Where(x => x is not null)
                .Select(x => x!)
                .ToList();

            foreach (var n in existing) known.Add(n.Id);
            WriteEvent(new Dictionary<string, object?> { ["type"] = "snapshot", ["items"] = items });
            activeCount = existing.Count;
            Log($"初始快照 {items.Count} 条（通知中心共 {existing.Count} 条）");
        }
        catch (Exception ex)
        {
            Log("读取初始通知失败：" + ex.Message);
        }

        // 事件订阅：失败则完全依赖轮询。
        var subscribed = false;
        try
        {
            listener.NotificationChanged += (_, args) => OnChanged(listener, args, known, dedupe);
            subscribed = true;
            Log("已订阅 NotificationChanged（事件驱动）");
        }
        catch (Exception ex)
        {
            Log($"订阅事件失败（{ex.GetType().FullName}, HRESULT=0x{ex.HResult:X8}）：{ex.Message}");
        }

        StartBackgroundTimers(listener, known, dedupe, subscribed);

        // WinRT 事件需要 COM 消息泵才会派发；控制台程序必须自己跑一个。
        RunMessageLoop();
        return 0;
    }

    private static void StartBackgroundTimers(
        UserNotificationListener listener,
        HashSet<uint> known,
        Dictionary<uint, string> dedupe,
        bool subscribed)
    {
        // 心跳：主进程用它判断监听器是否卡死。
        var tick = new Thread(() =>
        {
            while (!stopping)
            {
                Thread.Sleep(TickSeconds * 1000);
                if (stopping) break;
                WriteEvent(new Dictionary<string, object?>
                {
                    ["type"] = "tick",
                    ["ts"] = NowMs(),
                    ["count"] = activeCount,
                });
            }
        }) { IsBackground = true, Name = "tick" };
        tick.Start();

        // 兜底轮询：订阅成功时只是保险；订阅失败时它就是唯一来源，所以间隔压到最短。
        var poll = new Thread(() =>
        {
            var gap = subscribed ? PollGapWhenSubscribedMs : PollGapWhenPollingOnlyMs;
            while (!stopping)
            {
                Thread.Sleep(gap);
                if (stopping) break;
                try
                {
                    Reconcile(listener, known, dedupe);
                }
                catch (Exception ex)
                {
                    Log("轮询失败：" + ex.Message);
                }
            }
        }) { IsBackground = true, Name = "poll" };
        poll.Start();
    }

    private static void OnChanged(
        UserNotificationListener listener,
        UserNotificationChangedEventArgs args,
        HashSet<uint> known,
        Dictionary<uint, string> dedupe)
    {
        try
        {
            var id = args.UserNotificationId;
            if (args.ChangeKind == UserNotificationChangedKind.Added)
            {
                // 从事件到详情再取一次；注意本机 WinRT 投影只有同步的 GetNotification(uint)，
                // 没有文档里的 GetNotificationAsync。取不到就交给兜底轮询。
                UserNotification? notification = null;
                try
                {
                    notification = listener.GetNotification(id);
                }
                catch (Exception ex)
                {
                    Log($"取通知 {id} 详情失败：{ex.Message}");
                }

                if (notification is not null)
                {
                    known.Add(id);
                    var item = Convert(notification, dedupe);
                    if (item is not null)
                    {
                        WriteEvent(new Dictionary<string, object?>
                        {
                            ["type"] = "notify",
                            ["id"] = item.Id,
                            ["app"] = item.App,
                            ["title"] = item.Title,
                            ["content"] = item.Content,
                            ["ts"] = item.Ts,
                        });
                        activeCount = known.Count;
                    }
                }
            }
            else if (args.ChangeKind == UserNotificationChangedKind.Removed)
            {
                known.Remove(id);
                if (dedupe.Remove(id, out var platformId))
                {
                    WriteEvent(new Dictionary<string, object?>
                    {
                        ["type"] = "removed",
                        ["ids"] = new[] { platformId },
                    });
                }
                activeCount = known.Count;
            }
        }
        catch (Exception ex)
        {
            Log("处理通知变化失败：" + ex.Message);
        }
    }

    /// <summary>兜底：对比当前通知中心与已知集合，补发漏掉的增删。</summary>
    private static void Reconcile(UserNotificationListener listener, HashSet<uint> known, Dictionary<uint, string> dedupe)
    {
        var current = FetchAll(listener);
        var currentIds = new HashSet<uint>(current.Select(n => n.Id));

        foreach (var notification in current)
        {
            if (known.Contains(notification.Id)) continue;
            known.Add(notification.Id);
            var item = Convert(notification, dedupe);
            if (item is null) continue;
            WriteEvent(new Dictionary<string, object?>
            {
                ["type"] = "notify",
                ["id"] = item.Id,
                ["app"] = item.App,
                ["title"] = item.Title,
                ["content"] = item.Content,
                ["ts"] = item.Ts,
            });
        }

        var gone = known.Where(id => !currentIds.Contains(id)).ToList();
        if (gone.Count > 0)
        {
            var removed = new List<string>();
            foreach (var id in gone)
            {
                known.Remove(id);
                if (dedupe.Remove(id, out var platformId)) removed.Add(platformId);
            }
            if (removed.Count > 0)
            {
                WriteEvent(new Dictionary<string, object?>
                {
                    ["type"] = "removed",
                    ["ids"] = removed.ToArray(),
                });
            }
        }

        activeCount = current.Count;
    }

    private sealed record Item(string Id, string App, string Title, string Content, long Ts);

    private static Item? Convert(UserNotification notification, Dictionary<uint, string> dedupe)
    {
        try
        {
            var ts = SafeCreationTime(notification);
            var app = SafeAppName(notification);
            var texts = SafeTexts(notification);

            var title = texts.Count > 0 ? texts[0] : app;
            var content = texts.Count > 1 ? string.Join(" ", texts.Skip(1)) : string.Empty;

            if (title.Length > 160) title = title[..160];
            if (content.Length > 300) content = content[..300];

            var platformId = $"{notification.Id}@{ts}";
            dedupe[notification.Id] = platformId;
            return new Item(platformId, app, title, content, ts);
        }
        catch (Exception ex)
        {
            Log("转换通知失败：" + ex.Message);
            return null;
        }
    }

    private static List<string> SafeTexts(UserNotification notification)
    {
        var result = new List<string>();
        try
        {
            var bindings = notification.Notification?.Visual?.Bindings;
            if (bindings is null) return result;

            // 优先标准模板（首段=标题、其余=正文），其余模板兜底。
            var ordered = bindings
                .OrderBy(b => SafeTemplate(b) == "ToastGeneric" ? 0 : 1)
                .ToList();

            foreach (var binding in ordered)
            {
                var texts = new List<string>();
                try
                {
                    foreach (var element in binding.GetTextElements())
                    {
                        var text = element?.Text?.Trim();
                        if (!string.IsNullOrWhiteSpace(text)) texts.Add(text);
                    }
                }
                catch { /* 个别模板取不到文本就跳过 */ }

                if (texts.Count > 0) return texts;
            }
        }
        catch { /* 结构异常时按无文本处理 */ }
        return result;
    }

    private static string SafeTemplate(NotificationBinding binding)
    {
        try { return binding.Template ?? string.Empty; } catch { return string.Empty; }
    }

    private static string SafeAppName(UserNotification notification)
    {
        try
        {
            var name = notification.AppInfo?.DisplayInfo?.DisplayName;
            if (!string.IsNullOrWhiteSpace(name)) return name.Trim();
        }
        catch { }
        try
        {
            var aumid = notification.AppInfo?.AppUserModelId;
            if (!string.IsNullOrWhiteSpace(aumid)) return aumid.Trim();
        }
        catch { }
        return "系统";
    }

    private static long SafeCreationTime(UserNotification notification)
    {
        try { return notification.CreationTime.ToUnixTimeMilliseconds(); }
        catch { return NowMs(); }
    }

    private static List<UserNotification> FetchAll(UserNotificationListener listener)
    {
        var op = listener.GetNotificationsAsync(NotificationKinds.Toast);
        var list = op.AsTask().GetAwaiter().GetResult();
        return list?.ToList() ?? new List<UserNotification>();
    }

    private static UserNotificationListenerAccessStatus EnsureAccess(UserNotificationListener listener)
    {
        var access = ReadAccess(listener);
        if (access != UserNotificationListenerAccessStatus.Unspecified) return access;
        try
        {
            listener.RequestAccessAsync().AsTask().Wait(TimeSpan.FromSeconds(10));
        }
        catch (Exception ex)
        {
            Log("请求通知访问权限失败：" + ex.Message);
        }
        return ReadAccess(listener);
    }

    private static UserNotificationListenerAccessStatus ReadAccess(UserNotificationListener listener)
    {
        try { return listener.GetAccessStatus(); }
        catch { return UserNotificationListenerAccessStatus.Unspecified; }
    }

    private static string AccessName(UserNotificationListenerAccessStatus access) => access switch
    {
        UserNotificationListenerAccessStatus.Allowed => "allowed",
        UserNotificationListenerAccessStatus.Denied => "denied",
        _ => "unspecified",
    };

    private static string AccessMessage(UserNotificationListenerAccessStatus access) => access switch
    {
        UserNotificationListenerAccessStatus.Allowed => "已连接到通知中心（事件驱动）",
        UserNotificationListenerAccessStatus.Denied => "通知访问被拒绝，请在系统设置中允许",
        _ => "尚未授权访问通知，请在系统设置中允许",
    };

    // ---------------- 输出 ----------------

    private static void EmitStatus(string access, string message)
    {
        WriteEvent(new Dictionary<string, object?>
        {
            ["type"] = "status",
            ["access"] = access,
            ["message"] = message,
        });
    }

    private static void WriteEvent(Dictionary<string, object?> payload)
    {
        try
        {
            // 手写序列化：载荷是扁平结构，避免引入 System.Text.Json（它带 RequiresUnreferencedCode，
            // 与 PublishTrimmed 冲突，且会把体积撑大几 MB）。
            var line = BuildJson(payload);
            lock (WriteLock)
            {
                Console.Out.WriteLine(line);
                Console.Out.Flush();
            }
        }
        catch (Exception ex)
        {
            Log("写事件失败：" + ex.Message);
        }
    }

    private static string BuildJson(Dictionary<string, object?> payload)
    {
        var sb = new StringBuilder(256);
        sb.Append('{');
        var first = true;
        foreach (var (key, value) in payload)
        {
            if (value is null) continue;
            if (!first) sb.Append(',');
            first = false;
            sb.Append('"').Append(EscapeJson(key)).Append("\":");
            AppendValue(sb, value);
        }
        sb.Append('}');
        return sb.ToString();
    }

    private static void AppendValue(StringBuilder sb, object value)
    {
        switch (value)
        {
            case string text:
                sb.Append('"').Append(EscapeJson(text)).Append('"');
                break;
            case bool flag:
                sb.Append(flag ? "true" : "false");
                break;
            case int or long or double or float or decimal:
                sb.Append(System.Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture));
                break;
            case IEnumerable<Item> items:
                sb.Append('[');
                var firstItem = true;
                foreach (var item in items)
                {
                    if (!firstItem) sb.Append(',');
                    firstItem = false;
                    sb.Append("{\"id\":\"").Append(EscapeJson(item.Id))
                      .Append("\",\"app\":\"").Append(EscapeJson(item.App))
                      .Append("\",\"title\":\"").Append(EscapeJson(item.Title))
                      .Append("\",\"content\":\"").Append(EscapeJson(item.Content))
                      .Append("\",\"ts\":").Append(item.Ts).Append('}');
                }
                sb.Append(']');
                break;
            case IEnumerable<string> strings:
                sb.Append('[');
                var firstString = true;
                foreach (var text in strings)
                {
                    if (!firstString) sb.Append(',');
                    firstString = false;
                    sb.Append('"').Append(EscapeJson(text)).Append('"');
                }
                sb.Append(']');
                break;
            default:
                sb.Append('"').Append(EscapeJson(value.ToString() ?? string.Empty)).Append('"');
                break;
        }
    }

    private static string EscapeJson(string text)
    {
        var sb = new StringBuilder(text.Length + 8);
        foreach (var ch in text)
        {
            switch (ch)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                default:
                    if (ch < 0x20) sb.Append("\\u").Append(((int)ch).ToString("x4"));
                    else sb.Append(ch);
                    break;
            }
        }
        return sb.ToString();
    }

    private static void Log(string message)
    {
        try
        {
            lock (WriteLock)
            {
                Console.Error.WriteLine($"[{DateTimeOffset.Now:HH:mm:ss}] {message}");
                Console.Error.Flush();
            }
        }
        catch { }
    }

    private static long NowMs() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    // ---------------- 消息泵 ----------------

    [StructLayout(LayoutKind.Sequential)]
    private struct Msg
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int ptX;
        public int ptY;
    }

    [DllImport("user32.dll")]
    private static extern int GetMessage(out Msg lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref Msg lpMsg);

    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref Msg lpMsg);

    [DllImport("user32.dll")]
    private static extern bool PostThreadMessage(uint idThread, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    private const uint WM_QUIT = 0x0012;

    private static void RunMessageLoop()
    {
        var threadId = GetCurrentThreadId();
        Console.CancelKeyPress += (_, e) =>
        {
            e.Cancel = true;
            stopping = true;
            PostThreadMessage(threadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
        };
        AppDomain.CurrentDomain.ProcessExit += (_, _) =>
        {
            stopping = true;
            PostThreadMessage(threadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
        };

        while (GetMessage(out var msg, IntPtr.Zero, 0, 0) > 0)
        {
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }
        stopping = true;
    }
}
