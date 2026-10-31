import { BrowserWindow, ipcMain, shell } from 'electron'
import type { createSettingsWindows } from '../settings/windows'
import type { createWorkbenchView } from '../workbench/view'
import type { createIslandController } from '../island/controller'

interface WindowIpcOptions {
  settings: ReturnType<typeof createSettingsWindows>
  workbench: ReturnType<typeof createWorkbenchView>
  island: ReturnType<typeof createIslandController>
}
export function registerWindowIpc(ports: WindowIpcOptions): void {

  // 说明页里的外链：只放行 https 和 Windows 设置页，别的一律拒绝。
  ipcMain.handle('settings:open-external', (_event, url: unknown) => {
    const text = String(url ?? '')
    let parsed: URL
    try { parsed = new URL(text) } catch { return { ok: false, error: '链接格式不正确' } }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'ms-settings:') return { ok: false, error: '只允许打开 https 或系统设置链接' }
    void shell.openExternal(text)
    return { ok: true }
  })

  ipcMain.handle('console:open', (_event, kind: 'settings', tab?: string) => {
    if (kind === 'settings') ports.settings.open(tab).show()
    return { ok: true }
  })

  ipcMain.on('console:close', event => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })

  ipcMain.on('workbench:exit', event => {
    if (ports.workbench.view?.webContents === event.sender) void ports.island.showCompact()
    else BrowserWindow.fromWebContents(event.sender)?.close()
  })

  ipcMain.on('host:open-workbench', () => { void ports.island.enterCustomMode() })

  ipcMain.on('host:open-settings', () => { ports.settings.open().show() })
}
