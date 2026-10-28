
# 清空 Windows 通知中心。
# 实测：本机 Windows 上 ClearNotifications() 抛 0x80070490(Element not found)，
# 而 RemoveNotification(id) 稳定可用，所以这里逐条删除。
# 输出一行 JSON：{"ok":true,"removed":N,"failed":N} / {"ok":false,"reason":"..."}

$ErrorActionPreference = 'Continue'

try {
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [Console]::OutputEncoding = $utf8
} catch { }

function Write-Result {
  param([hashtable]$Data)
  try { [Console]::Out.WriteLine(($Data | ConvertTo-Json -Compress)) } catch { }
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
  [Windows.UI.Notifications.UserNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.UI.Notifications.NotificationKinds, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.UI.Notifications.Management.UserNotificationListener, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null

  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
  if ($null -eq $asTaskGeneric) { Write-Result @{ ok = $false; reason = 'as-task-unavailable' }; exit 1 }

  $listener = [Windows.UI.Notifications.Management.UserNotificationListener]::Current
  if ($null -eq $listener) { Write-Result @{ ok = $false; reason = 'unavailable' }; exit 1 }

  $access = 0
  try { $access = [int]$listener.GetAccessStatus() } catch { $access = 0 }
  if ($access -ne 1) {
    Write-Result @{ ok = $false; reason = 'access-denied'; access = $access }
    exit 2
  }

  $op = $listener.GetNotificationsAsync([Windows.UI.Notifications.NotificationKinds]::Toast)
  $method = $asTaskGeneric.MakeGenericMethod([System.Collections.Generic.IReadOnlyList[Windows.UI.Notifications.UserNotification]])
  $task = $method.Invoke($null, @($op))
  if (-not $task.Wait(8000)) { Write-Result @{ ok = $false; reason = 'timeout' }; exit 3 }

  $items = $task.Result
  $ids = @()
  if ($null -ne $items) {
    foreach ($item in $items) {
      try { $ids += [uint32]$item.Id } catch { }
    }
  }

  $removed = 0
  $failed = 0
  foreach ($id in $ids) {
    try { $listener.RemoveNotification($id); $removed++ }
    catch { $failed++ }
  }

  Write-Result @{ ok = ($failed -eq 0); removed = $removed; failed = $failed; total = $ids.Count }
  if ($failed -gt 0) { exit 4 }
  exit 0
} catch {
  Write-Result @{ ok = $false; reason = 'error'; message = $_.Exception.Message }
  exit 5
}
