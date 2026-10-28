# 阶段 B 端到端验收：用真实应用 + 临时 profile 跑 contract-probe 的意图时间线。
# 不移动鼠标、不截屏；应用窗口会短暂出现在屏幕顶部（在后台）。
# 用法：npm run build 之后，pwsh -File scripts/tests/contract-e2e.ps1
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$devPlugin = if ($env:ISLAND_DEV_PLUGIN) { $env:ISLAND_DEV_PLUGIN } else { Join-Path (Split-Path $repo -Parent) 'island-plugin\contract-probe' }
$tmp = Join-Path $env:TEMP 'island-phase-b'

Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $tmp | Out-Null
'{"idleMode":"collapsed","islandTop":5,"miniScale":1,"pluginOrder":[]}' | Set-Content -Encoding UTF8 (Join-Path $tmp 'settings.json')

# 1) 用正常安装路径把自检插件装进这个临时 profile（PluginManager 不依赖 Electron，直接 node 调）
$installer = @'
const path = require('node:path')
const { PluginManager } = require(path.join(process.argv[2], 'dist-electron', 'plugins', 'plugin-manager.js'))
const root = process.argv[3]
const manager = new PluginManager([root], root)
manager.discover()
manager.installDirectory(process.argv[4])
console.log('installed:', manager.list().map(p => p.manifest.id).join(','))
'@
$installerPath = Join-Path $tmp 'install.js'
Set-Content -Encoding UTF8 -Path $installerPath -Value $installer
node $installerPath $repo (Join-Path $tmp 'plugins') $devPlugin

# 2) 启动真实应用（隔离 profile），跑完时间线后杀掉
$exe = Join-Path $repo 'node_modules\electron\dist\electron.exe'
$proc = Start-Process -FilePath $exe -ArgumentList '.', "--user-data-dir=$tmp" -WorkingDirectory $repo -PassThru
Write-Output "app pid=$($proc.Id)，等待 14s 让时间线跑完…"
Start-Sleep -Seconds 14

Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*island-phase-b*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 800

# 3) 读插件 storage 里的时间线并断言
$report = Join-Path $tmp 'plugin-data\contract-probe.json'
if (-not (Test-Path $report)) { throw "没有拿到自检上报：$report" }
node (Join-Path $repo 'scripts\tests\contract-e2e-assert.cjs') $report
$exit = $LASTEXITCODE
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
exit $exit
