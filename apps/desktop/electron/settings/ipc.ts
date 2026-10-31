import { ipcMain } from 'electron'
import type { SettingsController } from './controller'
import type { IslandSettings } from './store'
import type { PluginManifest } from '../plugins/types'
import type { UpdateStatus } from '../updates/checker'

interface SettingsIpcOptions {
  controller: SettingsController
  snapshot(): IslandSettings & { appVersion: string; plugins: PluginManifest[] }
  updateStatus(): Partial<UpdateStatus> & { currentVersion: string; checkedAt: number; checkUpdatesOnLaunch: boolean }
  checkUpdates(): Promise<UpdateStatus>
}

export function registerSettingsIpc(options: SettingsIpcOptions): void {
  const controller = options.controller
  ipcMain.handle('settings:get', () => options.snapshot())
  ipcMain.handle('app:update-status', () => options.updateStatus())
  ipcMain.handle('app:check-updates', () => options.checkUpdates())
  ipcMain.handle('settings:set-check-updates', (_event, enabled: boolean) => controller.setCheckUpdates(enabled))
  ipcMain.handle('settings:set-launch-at-login', (_event, enabled: boolean) => controller.setLaunchAtLogin(enabled))
  ipcMain.handle('settings:set-idle-mode', (_event, mode: 'float' | 'collapsed') => controller.setIdleMode(mode))
  ipcMain.handle('settings:set-island-top', (_event, top: number) => controller.setTop(top))
  ipcMain.handle('settings:set-mini-scale', (_event, scale: number) => controller.setScale(scale))
  ipcMain.handle('settings:set-plugin-order', (_event, ids: string[]) => controller.setPluginOrder(ids))
}
