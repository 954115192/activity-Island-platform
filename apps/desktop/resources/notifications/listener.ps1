

# 系统通知监听：读取 Windows 通知中心的通知，逐行输出 JSON 事件
# 事件：status / snapshot / notify / removed / tick
# notify / snapshot 的每条记录固定带 id / app / title / content / ts 五个字段

$ErrorActionPreference = 'Continue'

try {
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [Console]::OutputEncoding = $utf8
  $OutputEncoding = $utf8
} catch { }

function Write-Event {
  param([hashtable]$Data)
  try {
    $line = $Data | ConvertTo-Json -Compress -Depth 6
    [Console]::Out.WriteLine($line)
    [Console]::Out.Flush()
  } catch { }
}

function Write-Log {
  param([string]$Message)
  try { [Console]::Error.WriteLine($Message) } catch { }
}

$script:AsTaskGeneric = $null
$script:Listener = $null

function Initialize-WinRT {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

  [Windows.UI.Notifications.UserNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.UI.Notifications.NotificationKinds, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.UI.Notifications.KnownNotificationBindings, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.UI.Notifications.Management.UserNotificationListener, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null

  $script:AsTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]

  if ($null -eq $script:AsTaskGeneric) { throw 'AsTask 反射失败' }

  $script:Listener = [Windows.UI.Notifications.Management.UserNotificationListener]::Current
  if ($null -eq $script:Listener) { throw 'UserNotificationListener 不可用' }
}

function Await-Op {
  param($Operation, [Type]$ResultType, [int]$TimeoutMs = 6000)
  if ($null -eq $Operation) { return $null }
  $method = $script:AsTaskGeneric.MakeGenericMethod($ResultType)
  $task = $method.Invoke($null, @($Operation))
  if (-not $task.Wait($TimeoutMs)) { throw 'WinRT 调用超时' }
  return $task.Result
}

function Get-AccessState {
  try {
    $s = [int]$script:Listener.GetAccessStatus()
    if ($s -eq 1) { return 'allowed' }
    if ($s -eq 2) { return 'denied' }
    if ($s -eq 0) { return 'unspecified' }
    return 'unknown'
  } catch {
    return 'error'
  }
}

function Get-Notifications {
  $result = $null
  $op = $script:Listener.GetNotificationsAsync([Windows.UI.Notifications.NotificationKinds]::Toast)
  $result = Await-Op $op ([System.Collections.Generic.IReadOnlyList[Windows.UI.Notifications.UserNotification]]) 8000

  $list = New-Object System.Collections.ArrayList
  if ($null -eq $result) { return $list }

  $count = 0
  try { $count = [int]$result.Count } catch { $count = 0 }

  if ($count -gt 0) {
    for ($i = 0; $i -lt $count; $i++) {
      try { [void]$list.Add($result[$i]) } catch { }
    }
  } else {
    try { foreach ($x in $result) { [void]$list.Add($x) } } catch { }
  }
  return $list
}

function Get-AppName {
  param($UserNotification)
  $name = ''
  try { $name = [string]$UserNotification.AppInfo.DisplayInfo.DisplayName } catch { }
  if ([string]::IsNullOrWhiteSpace($name)) {
    try { $name = [string]$UserNotification.AppInfo.AppUserModelId } catch { }
  }
  if ([string]::IsNullOrWhiteSpace($name)) { $name = '系统' }
  return $name.Trim()
}

function Read-BindingTexts {
  param($Binding)
  $out = @()
  try {
    $elements = @($Binding.GetTextElements())
    foreach ($e in $elements) {
      $t = ''
      try { $t = [string]$e.Text } catch { }
      if (-not [string]::IsNullOrWhiteSpace($t)) { $out += $t.Trim() }
    }
  } catch { }
  return @($out)
}

function Get-TextElements {
  param($UserNotification)
  # 只遍历 Visual.Bindings 取文本。不要用 Visual.GetBinding()：它返回的互操作对象
  # 上调用 GetTextElements() 会随机抛 "The object's type must not be a Windows Runtime
  # type"（实测 PS 5.1 两次运行两种结果），导致整条通知只剩应用名。Bindings 集合稳定。
  $texts = @()
  try {
    $visual = $null
    try { $visual = $UserNotification.Notification.Visual } catch { }
    if ($null -ne $visual) {
      $bindings = $null
      try { $bindings = $visual.Bindings } catch { }
      if ($null -ne $bindings) {
        # 优先标准模板（首段=标题、其余=正文），再退其它模板
        $generic = @()
        $others = @()
        foreach ($b in $bindings) {
          $name = ''
          try { $name = [string]$b.Template } catch { }
          if ($name -eq 'ToastGeneric') { $generic += $b } else { $others += $b }
        }
        foreach ($b in @($generic + $others)) {
          $t = @(Read-BindingTexts $b)
          if ($t.Count -gt 0) { $texts = @($t); break }
        }
      }
    }
  } catch { }
  return @($texts)
}

function Convert-Notification {
  param($UserNotification)

  $rawId = ''
  try { $rawId = [string]$UserNotification.Id } catch { }
  if ([string]::IsNullOrWhiteSpace($rawId)) { return $null }

  # ---- app ----
  $app = Get-AppName $UserNotification

  # ---- ts ----
  $ts = 0
  try {
    $ts = [long]([DateTimeOffset]$UserNotification.CreationTime).ToUnixTimeMilliseconds()
  } catch { $ts = 0 }
  if ($ts -le 0) {
    try { $ts = [long]([DateTime]::UtcNow - [DateTime]'1970-01-01').TotalMilliseconds } catch { $ts = 0 }
  }

  # ---- title（首段文本）/ content（其余全部文本）----
  $texts = @(Get-TextElements $UserNotification)
  $title = ''
  $content = ''
  if ($texts.Count -gt 0) { $title = [string]$texts[0] }
  if ($texts.Count -gt 1) {
    $rest = @()
    for ($i = 1; $i -lt $texts.Count; $i++) { $rest += [string]$texts[$i] }
    $content = ($rest -join ' ').Trim()
  }
  # 有些应用只给一段文本：把这一段既当标题也在正文里备用
  if ([string]::IsNullOrWhiteSpace($title)) { $title = $app }
  if ([string]::IsNullOrWhiteSpace($content)) { $content = '' }

  if ($title.Length -gt 160) { $title = $title.Substring(0, 160) }
  if ($content.Length -gt 300) { $content = $content.Substring(0, 300) }

  return @{
    id      = ($rawId + '@' + $ts)
    app     = [string]$app
    title   = [string]$title
    content = [string]$content
    ts      = [long]$ts
  }
}

# ---------------- 主循环 ----------------

$seen = @{}
$lastActiveIds = @()
$firstScanDone = $false
$access = 'unknown'
$accessRequested = $false
$lastTick = [DateTime]::UtcNow
$pollMs = 2000

while ($true) {
  if ($null -eq $script:Listener) {
    try {
      Initialize-WinRT
      Write-Event @{ type = 'status'; access = 'starting'; message = '通知监听初始化完成' }
    } catch {
      Write-Event @{ type = 'status'; access = 'error'; message = ("初始化失败：" + $_.Exception.Message) }
      Start-Sleep -Seconds 20
      continue
    }
  }

  $current = Get-AccessState

  if ($current -eq 'unspecified' -and -not $accessRequested) {
    $accessRequested = $true
    try {
      $op = $script:Listener.RequestAccessAsync()
      $null = Await-Op $op ([Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus]) 10000
      $current = Get-AccessState
    } catch {
      Write-Log ("请求通知访问权限失败：" + $_.Exception.Message)
      $current = Get-AccessState
    }
  }

  if ($current -ne $access) {
    $access = $current
    $msg = switch ($access) {
      'allowed' { '已连接到通知中心' }
      'denied' { '通知访问被拒绝，请在系统设置中允许' }
      'unspecified' { '尚未授权访问通知，请在系统设置中允许' }
      'error' { '无法读取通知访问状态' }
      default { '通知访问状态未知' }
    }
    Write-Event @{ type = 'status'; access = $access; message = $msg }
  }

  if ($access -ne 'allowed') {
    Start-Sleep -Milliseconds 3000
    continue
  }

  $items = $null
  try {
    $items = Get-Notifications
  } catch {
    Write-Log ("读取通知失败：" + $_.Exception.Message)
    Start-Sleep -Milliseconds 3000
    continue
  }

  $activeIds = @{}
  $activeItems = @()
  $fresh = @()

  foreach ($n in $items) {
    $obj = $null
    try { $obj = Convert-Notification $n } catch { $obj = $null }
    if ($null -eq $obj) { continue }

    $oid = [string]$obj.id
    $activeIds[$oid] = $true
    $activeItems += $obj

    if (-not $seen.ContainsKey($oid)) {
      $seen[$oid] = $true
      $fresh += $obj
    }
  }

  if (-not $firstScanDone) {
    $firstScanDone = $true
    $sorted = @($activeItems | Sort-Object -Property @{ Expression = { [long]$_.ts }; Descending = $true } | Select-Object -First 25)
    $snapshotItems = @()
    foreach ($obj in $sorted) {
      $snapshotItems += @{
        id      = [string]$obj.id
        app     = [string]$obj.app
        title   = [string]$obj.title
        content = [string]$obj.content
        ts      = [long]$obj.ts
      }
    }
    Write-Event @{ type = 'snapshot'; items = @($snapshotItems) }
  } else {
    foreach ($obj in $fresh) {
      Write-Event @{
        type    = 'notify'
        id      = [string]$obj.id
        app     = [string]$obj.app
        title   = [string]$obj.title
        content = [string]$obj.content
        ts      = [long]$obj.ts
      }
    }

    $removed = @()
    foreach ($old in $lastActiveIds) {
      if (-not $activeIds.ContainsKey([string]$old)) { $removed += [string]$old }
    }
    if ($removed.Count -gt 0) {
      Write-Event @{ type = 'removed'; ids = $removed }
    }
  }

  $lastActiveIds = @($activeIds.Keys)

  if ($seen.Count -gt 800) {
    $keep = @{}
    foreach ($k in $activeIds.Keys) { $keep[$k] = $true }
    $seen = $keep
  }

  if (([DateTime]::UtcNow - $lastTick).TotalSeconds -ge 15) {
    $lastTick = [DateTime]::UtcNow
    $nowMs = 0
    try { $nowMs = [long]([DateTime]::UtcNow - [DateTime]'1970-01-01').TotalMilliseconds } catch { $nowMs = 0 }
    Write-Event @{ type = 'tick'; ts = $nowMs; count = $activeItems.Count }
  }

  Start-Sleep -Milliseconds $pollMs
}
