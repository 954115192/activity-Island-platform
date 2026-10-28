# 插件自检：把某个插件装进临时 profile，用真实应用加载一遍，然后报告
#   - 宿主是否成功加载（未加载原因）
#   - 插件日志（island.log / console.error / 未捕获异常 / 热重载）
#   - 页面是否真的起来了（storage 里有没有握手痕迹）
# 不碰你的正式 profile，不移动鼠标、不截屏。适合 AI 生成插件后自查。
#
# 用法：pwsh -File scripts/plugin-smoke.ps1 -PluginDir ..\island-plugin\my-plugin [-Seconds 8]
param(
  [Parameter(Mandatory = $true)][string]$PluginDir,
  [int]$Seconds = 8
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path (Join-Path $PluginDir 'plugin.json'))) { throw "不是插件目录（缺 plugin.json）：$PluginDir" }
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$manifest = Get-Content (Join-Path $PluginDir 'plugin.json') -Raw | ConvertFrom-Json
$id = $manifest.id
$sandbox = Join-Path $env:TEMP ("island-smoke-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$profile = Join-Path $sandbox 'profile'
$userPlugins = Join-Path $profile 'plugins'
$logFile = Join-Path $profile "island-plugins\logs\$id.log"
$storageFile = Join-Path $profile "plugin-data\$id.json"

New-Item -ItemType Directory -Path $profile -Force | Out-Null
'{"idleMode":"collapsed","islandTop":5,"miniScale":1,"pluginOrder":[]}' | Set-Content -Encoding UTF8 (Join-Path $profile 'settings.json')

# 用正常安装路径装进临时 profile（记录源码目录，便于热重载）
$installer = Join-Path $sandbox 'install.js'
@'
const path = require('node:path')
const { PluginManager } = require(path.join(process.argv[2], 'dist-electron', 'plugins', 'plugin-manager.js'))
const root = process.argv[3]
const manager = new PluginManager([root], root)
manager.discover()
try { manager.installDirectory(process.argv[4]) } catch (error) { console.error('INSTALL-FAILED: ' + error.message); process.exit(2) }
console.log(JSON.stringify(manager.list().map(p => p.manifest.id)))
'@ | Set-Content -Encoding UTF8 $installer
$installed = node $installer $repo $userPlugins $PluginDir
if ($LASTEXITCODE -ne 0) { Write-Output "安装失败：$installed"; Remove-Item -Recurse -Force $sandbox -ErrorAction SilentlyContinue; exit 2 }

$exe = Join-Path $repo 'node_modules\electron\dist\electron.exe'
$proc = Start-Process -FilePath $exe -ArgumentList '.', "--user-data-dir=$profile" -WorkingDirectory $repo -PassThru
try {
  Start-Sleep -Seconds $Seconds

  # 未加载原因要重新问一遍宿主（应用启动后 discover 的结果）
  $issuesScript = Join-Path $sandbox 'issues.js'
  @'
const path = require('node:path')
const { PluginManager } = require(path.join(process.argv[2], 'dist-electron', 'plugins', 'plugin-manager.js'))
const root = process.argv[3]
const manager = new PluginManager([root], root)
const loaded = manager.discover().map(p => p.manifest.id)
console.log(JSON.stringify({ loaded, issues: manager.issues() }))
'@ | Set-Content -Encoding UTF8 $issuesScript
  $scan = node $issuesScript $repo $userPlugins | ConvertFrom-Json

  $log = if (Test-Path $logFile) { @(Get-Content $logFile) } else { @() }
  $hasStorage = Test-Path $storageFile
  $errors = @($log | Where-Object { $_ -match '\[error\]' })
  $loadedOk = $scan.loaded -contains $id
  $myIssues = @($scan.issues | Where-Object { $_.id -eq $id -or $_.directory -like "*$id" })

  Write-Output "=== 插件自检：$id ==="
  Write-Output ("宿主加载          : " + $(if ($loadedOk) { 'PASS' } else { 'FAIL' }))
  if ($myIssues.Count) { foreach ($issue in $myIssues) { Write-Output ("  未加载原因      : " + $issue.reason + "  (" + $issue.directory + ")") } }
  Write-Output ("插件日志          : " + $(if ($log.Count) { "$($log.Count) 行" } else { '（无）' }))
  Write-Output ("运行期 error 行   : " + $(if ($errors.Count) { "FAIL（$($errors.Count) 条）" } else { 'PASS（0 条）' }))
  Write-Output ("插件写过 storage  : " + $(if ($hasStorage) { 'PASS' } else { '（无，插件可能没用到 storage）' }))
  if ($log.Count) { Write-Output '--- 日志尾部 ---'; $log | Select-Object -Last 20 | ForEach-Object { Write-Output "  $_" } }
  else { Write-Output '（插件没有任何日志输出；建议在关键节点调用 island.log.info 便于自查）' }

  $failed = (-not $loadedOk) -or ($myIssues.Count -gt 0) -or ($errors.Count -gt 0)
} finally {
  Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like "*$($sandbox -replace '\\','\\')*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 500
  Remove-Item -Recurse -Force $sandbox -ErrorAction SilentlyContinue
}
exit $(if ($failed) { 1 } else { 0 })
