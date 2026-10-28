# 阶段 C 端到端验收：真实应用 + 临时 profile + 沙箱里的插件副本。
# 验证：插件日志落盘、页面异常自动进日志、改开发目录自动同步并热重载。
# 不会碰开发目录里的原始文件（用的是沙箱副本）。
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$devSource = if ($env:ISLAND_DEV_PLUGIN) { $env:ISLAND_DEV_PLUGIN } else { Join-Path (Split-Path $repo -Parent) 'island-plugin\contract-probe' }
$sandbox = Join-Path $env:TEMP 'island-phase-c-e2e'
$devCopy = Join-Path $sandbox 'dev\contract-probe'
$profile = Join-Path $sandbox 'profile'
$userPlugins = Join-Path $profile 'plugins'
$logFile = Join-Path $profile 'island-plugins\logs\contract-probe.log'
$storageFile = Join-Path $profile 'plugin-data\contract-probe.json'
$checks = [System.Collections.Generic.List[object]]::new()
function Check([string]$name, [bool]$ok, [string]$detail = '') { $checks.Add([pscustomobject]@{ name = $name; ok = $ok; detail = $detail }) }

Remove-Item -Recurse -Force $sandbox -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $devCopy -Force | Out-Null
New-Item -ItemType Directory -Path $profile -Force | Out-Null
Copy-Item (Join-Path $devSource '*') -Destination $devCopy -Recurse -Force
'{"idleMode":"collapsed","islandTop":5,"miniScale":1,"pluginOrder":[]}' | Set-Content -Encoding UTF8 (Join-Path $profile 'settings.json')

# 故意制造一条日志 + 一个未捕获异常，验证 SDK 自动转发与宿主落盘
$marker = 'phase-c-hot-reload'
Add-Content -Encoding UTF8 (Join-Path $devCopy 'dist\app.js') "`nwindow.dynamicIsland?.log?.info('phase-c-log-line')`nsetTimeout(() => { throw new Error('phase-c-boom') }, 2500)`n"

# 用正常安装路径装进临时 profile（记录源码目录 → 可热重载）
$installer = Join-Path $sandbox 'install.js'
@'
const path = require('node:path')
const { PluginManager } = require(path.join(process.argv[2], 'dist-electron', 'plugins', 'plugin-manager.js'))
const root = process.argv[3]
const manager = new PluginManager([root], root)
manager.discover()
manager.installDirectory(process.argv[4])
console.log('installed:', manager.list().map(p => p.manifest.id).join(','), 'source:', manager.sourceOf('contract-probe'))
'@ | Set-Content -Encoding UTF8 $installer
node $installer $repo $userPlugins $devCopy

$exe = Join-Path $repo 'node_modules\electron\dist\electron.exe'
$proc = Start-Process -FilePath $exe -ArgumentList '.', "--user-data-dir=$profile" -WorkingDirectory $repo -PassThru
try {
  Start-Sleep -Seconds 6
  $log = if (Test-Path $logFile) { Get-Content $logFile -Raw } else { '' }
  $storage = if (Test-Path $storageFile) { Get-Content $storageFile -Raw | ConvertFrom-Json } else { $null }
  Check '插件日志文件已生成' (Test-Path $logFile) $logFile
  Check 'island.log.info 落盘' ($log -match 'phase-c-log-line')
  Check '页面未捕获异常自动进日志' ($log -match 'phase-c-boom')
  Check '插件握手/初始化日志' ($log -match '已安装 v|init|boot' -or $log -match '\[info\]')
  $firstBoot = $storage.boot.at
  Check '插件 storage 可读（拿到握手时间戳）' ([bool]$firstBoot) "boot.at=$firstBoot"

  # 改开发目录 → 应该自动同步 + 热重载
  Start-Sleep -Milliseconds 500
  Add-Content -Encoding UTF8 (Join-Path $devCopy 'dist\app.js') "`n// $marker`n"
  Start-Sleep -Seconds 4
  $log2 = Get-Content $logFile -Raw
  $installedApp = Get-Content (Join-Path $userPlugins 'contract-probe\dist\app.js') -Raw
  $storage2 = Get-Content $storageFile -Raw | ConvertFrom-Json
  Check '开发目录改动已同步到安装目录' ($installedApp -match $marker)
  Check '日志记录了热重载' ($log2 -match '热重载')
  Check '热重载后插件重新加载（boot 时间戳更新）' ($storage2.boot.at -ne $firstBoot) "$firstBoot -> $($storage2.boot.at)"
} finally {
  Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*island-phase-c-e2e*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 600
}

Write-Output '=== 阶段 C 端到端验收 ==='
$failed = 0
foreach ($item in $checks) { if (-not $item.ok) { $failed++ }; Write-Output ("{0}  {1}{2}" -f ($(if ($item.ok) { 'PASS' } else { 'FAIL' })), $item.name, $(if ($item.detail) { "   [$($item.detail)]" } else { '' })) }
Write-Output "`n$($checks.Count - $failed)/$($checks.Count) 通过"
if ($failed) {
  Write-Output '--- 日志尾部 ---'
  if (Test-Path $logFile) { Get-Content $logFile -Tail 25 }
}
Remove-Item -Recurse -Force $sandbox -ErrorAction SilentlyContinue
exit $failed
