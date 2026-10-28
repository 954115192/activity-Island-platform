# 把当前插件目录打成 .islandplugin（本质是 zip：plugin.json + dist/ + 可选 resources/、README.md）。
# 用法：pwsh -File .\pack.ps1 [-Out <输出文件>]
param([string]$Out)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$manifestPath = Join-Path $root 'plugin.json'
if (-not (Test-Path $manifestPath)) { throw "当前目录没有 plugin.json：$root" }
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
if (-not $manifest.id -or -not $manifest.version) { throw 'plugin.json 缺少 id / version' }
if (-not $Out) { $Out = Join-Path (Split-Path $root -Parent) "$($manifest.id)-$($manifest.version).islandplugin" }

$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("island-pack-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
  foreach ($item in @('plugin.json', 'dist', 'resources', 'README.md')) {
    $source = Join-Path $root $item
    if (Test-Path $source) { Copy-Item $source -Destination $stage -Recurse -Force }
  }
  if (Test-Path $Out) { Remove-Item $Out -Force }
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $Out -Force
  $size = [Math]::Round((Get-Item $Out).Length / 1KB, 1)
  Write-Output "已打包：$Out（$size KB）"
} finally {
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}
