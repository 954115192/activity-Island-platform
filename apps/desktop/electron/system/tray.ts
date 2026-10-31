import { app, Menu, nativeImage, Tray } from 'electron'
import path from 'node:path'

interface TrayOptions {
  iconPath: string
  log(level: 'info' | 'warn', message: string): void
  openSettings(): void
  quit(): void
}

export function createTray(options: TrayOptions): Tray {
  // 免得 Windows 把空图标整个隐藏掉、用户以为程序没在跑。
  let icon = nativeImage.createFromPath(options.iconPath)
  if (icon.isEmpty()) {
    options.log('warn', `托盘图标读取失败（空图）：${options.iconPath}`)
    icon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAKElEQVR42mNkYPj/n4GBgYGBgQH+////PwMDAwMDAwMAAAAwAAH6C9D0AAAAASUVORK5CYII=')
  }
  const tray = new Tray(icon)
  tray.setToolTip('Activity Island')
  options.log('info', `已启动 v${app.getVersion()}${app.isPackaged ? '（安装版）' : '（源码运行）'} · assets=${path.dirname(options.iconPath)}`)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开控制台管理', click: () => { options.openSettings() } },
    { type: 'separator' },
    { label: '退出', click: () => { options.quit() } },
  ]))
  return tray
}
