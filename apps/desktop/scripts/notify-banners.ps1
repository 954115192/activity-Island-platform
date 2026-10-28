<#
.SYNOPSIS
  一键关闭 / 恢复 Windows 每个应用的"显示通知横幅"开关。

.DESCRIPTION
  原理：Windows 把每个应用的通知开关存在
  HKCU\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\<AppUserModelID>
  下的 ShowBanner / Enabled / ShowInActionCenter（DWORD）。没有这些值 = 默认开启。

  off   先把所有应用当前的开关状态 + 全局 ToastEnabled 备份到 JSON，再把横幅全部关掉。
        关闭策略：ShowBanner=0（通知仍进通知中心，只是不弹横幅）；
        全局 ToastEnabled=0 兜底覆盖注册表里还没有键的应用；
        没有 ShowBanner 值的键记录为 "missing"，恢复时删掉该值还原默认。
  on    从备份 JSON 恢复原状。
  status 只列出当前每个应用的横幅开关状态，不改动。

.NOTES
  只写 HKCU，不需要管理员权限。备份文件：
  %LOCALAPPDATA%\notify-banner-helper\banner-backup.json
  全程使用 .NET Registry API 而不是 PowerShell 路径提供器，
  因为 Edge 等 AUMID 含 "/" 或 "\"（如 ...!https://hamibot.cn/），会被当成路径分隔符。
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('off', 'on', 'status')]
  [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'

$SubKeyPath  = 'Software\Microsoft\Windows\CurrentVersion\Notifications\Settings'
$PushKeyPath = 'Software\Microsoft\Windows\CurrentVersion\PushNotifications'
$GlobalValue = 'ToastEnabled'   # 不存在 = 全局通知开启
$BackupDir   = Join-Path $env:LOCALAPPDATA 'notify-banner-helper'
$BackupFile  = Join-Path $BackupDir 'banner-backup.json'

# 我们认得的三类开关值；备份/恢复只动这三个，不碰 LastNotificationAddedTime 之类的遥测值
$SwitchNames = @('Enabled', 'ShowBanner', 'ShowInActionCenter')

function Get-SettingsRoot([switch]$Writable) {
  return [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($SubKeyPath, [bool]$Writable)
}

function Get-AppStates {
  $states = @()
  $root = Get-SettingsRoot
  try {
    foreach ($name in $root.GetSubKeyNames()) {
      $sub = $root.OpenSubKey($name)
      try {
        $valueNames = $sub.GetValueNames()
        $values = [ordered]@{}
        $missing = @()
        foreach ($sw in $SwitchNames) {
          if ($valueNames -contains $sw) {
            $values[$sw] = [int]$sub.GetValue($sw)
          } else {
            $missing += $sw
          }
        }
        $states += [pscustomobject]@{ appId = $name; values = $values; missing = $missing }
      } finally { $sub.Close() }
    }
  } finally { $root.Close() }
  return $states
}

function Get-GlobalState {
  $root = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($PushKeyPath, $false)
  if ($null -eq $root) { return @{ exists = $false } }
  try {
    if ($root.GetValueNames() -contains $GlobalValue) {
      return @{ exists = $true; value = [int]$root.GetValue($GlobalValue) }
    }
    return @{ exists = $false }
  } finally { $root.Close() }
}

function Set-GlobalValue([int]$Value) {
  $root = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($PushKeyPath, $true)
  if ($null -eq $root) {
    $root = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($PushKeyPath, $true)
  }
  try { $root.SetValue($GlobalValue, $Value, [Microsoft.Win32.RegistryValueKind]::DWord) }
  finally { $root.Close() }
}

function Remove-GlobalValue {
  $root = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($PushKeyPath, $true)
  if ($null -eq $root) { return }
  try { if ($root.GetValueNames() -contains $GlobalValue) { $root.DeleteValue($GlobalValue) } }
  finally { $root.Close() }
}

function Set-AppValue([string]$AppId, [string]$Name, [int]$Value) {
  $root = Get-SettingsRoot -Writable
  try {
    $sub = $root.OpenSubKey($AppId, $true)
    if ($null -eq $sub) { $sub = $root.CreateSubKey($AppId, $true) }
    try { $sub.SetValue($Name, $Value, [Microsoft.Win32.RegistryValueKind]::DWord) }
    finally { $sub.Close() }
  } finally { $root.Close() }
}

function Remove-AppValue([string]$AppId, [string]$Name) {
  $root = Get-SettingsRoot -Writable
  try {
    $sub = $root.OpenSubKey($AppId, $true)
    if ($null -eq $sub) { return }
    try { if ($sub.GetValueNames() -contains $Name) { $sub.DeleteValue($Name) } }
    finally { $sub.Close() }
  } finally { $root.Close() }
}

switch ($Action) {

  'status' {
    $global = Get-GlobalState
    $globalText = if ($global.exists) { "$($global.value)" } else { '1 (默认, 值不存在)' }
    Write-Host ("全局 ToastEnabled: {0}" -f $globalText)
    Write-Host ("备份文件: {0}" -f ($(if (Test-Path $BackupFile) { "$BackupFile  [存在]" } else { '无' })))
    Write-Host ""
    Write-Host ("{0,-70} {1}" -f '应用 (AppUserModelID)', '横幅')
    Write-Host ("{0,-70} {1}" -f ('-' * 68), '-----')
    foreach ($app in (Get-AppStates)) {
      if ($app.values.PSObject.Properties['ShowBanner']) {
        $banner = if ($app.values.ShowBanner -eq 0) { '关' } else { '开' }
      } elseif ($app.values.PSObject.Properties['Enabled'] -and $app.values.Enabled -eq 0) {
        $banner = '(整个通知已关)'
      } else {
        $banner = '开 (默认)'
      }
      Write-Host ("{0,-70} {1}" -f $app.appId, $banner)
    }
  }

  'off' {
    if (Test-Path $BackupFile) {
      Write-Warning "已存在备份 $BackupFile，为防覆盖，本次不执行。如确认要重新备份，先删除该文件。"
      exit 1
    }

    $backup = [ordered]@{
      createdAt = (Get-Date -Format 'o')
      global    = Get-GlobalState
      apps      = Get-AppStates
    }

    if (-not (Test-Path $BackupDir)) { New-Item -ItemType Directory -Path $BackupDir | Out-Null }
    $backup | ConvertTo-Json -Depth 5 | Set-Content -Path $BackupFile -Encoding UTF8

    # 1) 全局总开关关掉：兜底覆盖所有应用（包括注册表里还没有键的）
    Set-GlobalValue 0

    # 2) 每个已知应用 ShowBanner=0（通知仍进通知中心）
    foreach ($app in $backup.apps) {
      Set-AppValue $app.appId 'ShowBanner' 0
    }

    Write-Host "已关闭 $(($backup.apps).Count + 1) 处横幅开关（$($backup.apps.Count) 个应用 + 全局总开关）。"
    Write-Host "原状态已备份到 $BackupFile，执行 on 恢复。"
  }

  'on' {
    if (-not (Test-Path $BackupFile)) {
      throw "找不到备份文件 $BackupFile，请先执行 off 生成备份。"
    }
    $backup = Get-Content $BackupFile -Raw | ConvertFrom-Json

    # 1) 恢复全局 ToastEnabled
    if ($backup.global.exists) {
      Set-GlobalValue ([int]$backup.global.value)
    } else {
      Remove-GlobalValue
    }

    # 2) 逐应用恢复三个开关值：原本存在的写回原值，原本不存在的删掉
    foreach ($app in $backup.apps) {
      foreach ($name in $SwitchNames) {
        if ($app.values.PSObject.Properties[$name]) {
          Set-AppValue $app.appId $name ([int]$app.values.$name)
        } else {
          Remove-AppValue $app.appId $name
        }
      }
    }

    # 备份已消费，删掉以防下次 off 前误把旧状态当新状态恢复
    Remove-Item -Path $BackupFile -Force

    Write-Host "已从 $BackupFile 恢复 $(($backup.apps).Count) 个应用 + 全局开关的原始状态，备份文件已删除。"
  }
}
