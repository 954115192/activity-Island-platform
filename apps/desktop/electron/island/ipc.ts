import { ipcMain, type BrowserWindow } from 'electron'
import type { createIslandController } from './controller'

interface IslandIpcOptions {
  island: ReturnType<typeof createIslandController>
  readonly window: BrowserWindow | null
}
export function registerIslandIpc(ports: IslandIpcOptions): void {

  ipcMain.handle('host:state:get', () => ports.island.islandState.value)

  ipcMain.on('host:animation-frame', (event, frame: { width?: number; height?: number; top?: number; radius?: number }) => {
    if (event.sender !== ports.window?.webContents) return
    if (![frame.width, frame.height, frame.top, frame.radius].every(value => Number.isFinite(value))) return
    ports.island.updatePluginAnimationFrame({ width: Number(frame.width), height: Number(frame.height), top: Number(frame.top), radius: Number(frame.radius) })
  })
}
