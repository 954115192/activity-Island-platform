# 把当前插件目录打成 .islandplugin（本质是 zip：plugin.json + dist/ + 可选 resources/、README.md）。
# 用法：pwsh -File .\pack.ps1 [-Out <输出文件>]
param([string]$Out)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$manifestPath = Join-Path $root 'plugin.json'
if (-not (Test-Path $manifestPath)) { throw "当前目录没有 plugin.json：$root" }
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
if (-not $manifest.id -or -not $manifest.version) { throw 'plugin.json 缺少 id / version' }
if (-not $manifest.entry -or -not (Test-Path -LiteralPath (Join-Path $root $manifest.entry) -PathType Leaf)) { throw '插件入口不存在，请确认 plugin.json 中的 entry 和网页文件' }
if (-not $Out) { $Out = Join-Path (Split-Path $root -Parent) "$($manifest.id)-$($manifest.version).islandplugin" }

$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("island-pack-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
  foreach ($item in @('plugin.json', 'dist', 'resources', 'README.md')) {
    $source = Join-Path $root $item
    if (Test-Path $source) { Copy-Item $source -Destination $stage -Recurse -Force }
  }
  # Compress-Archive 只接受 .zip 后缀；先生成临时 zip，再改名为插件包。
  $archive = Join-Path ([System.IO.Path]::GetTempPath()) ("island-pack-" + [guid]::NewGuid().ToString('N') + '.zip')
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $archive -Force
  Move-Item -LiteralPath $archive -Destination $Out -Force
  $size = [Math]::Round((Get-Item $Out).Length / 1KB, 1)
  Write-Output "已打包：$Out（$size KB）"
} finally {
  if ($archive -and (Test-Path -LiteralPath $archive)) { Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue }
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}
