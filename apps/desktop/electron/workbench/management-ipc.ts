import type { InstalledArtifact } from '../plugins/package-installer'
import { app, dialog, ipcMain, type BrowserWindow } from 'electron'
import path from 'node:path'
import { WORKBENCH_TRUST_NOTICE } from './capabilities'
import { BUILTIN_WORKBENCH_ID, type WorkbenchManager } from './workbench-manager'
import type { createWorkbenchCoordinator } from './coordinator'
import type { createWorkbenchView } from './view'
import type { createWorkbenchAccess } from './access'
import type { createIslandController } from '../island/controller'
import type { SettingsStore } from '../settings/store'
import type { PluginLogger } from '../plugins/plugin-logger'

interface WorkbenchManagementOptions {
  readonly manager: WorkbenchManager | null
  readonly settingsWindow: BrowserWindow | null
  readonly logger: PluginLogger | null
  coordinator: ReturnType<typeof createWorkbenchCoordinator>
  runtime: ReturnType<typeof createWorkbenchView>
  access: ReturnType<typeof createWorkbenchAccess>
  island: ReturnType<typeof createIslandController>
  settings: SettingsStore
  sendHost(channel: string, payload?: unknown): void
  installPackage(filePath: string): Promise<InstalledArtifact>
}

/** Management console operations, separate from the workbench page's capability API. */
export function registerWorkbenchManagementIpc(ports: WorkbenchManagementOptions): void {

  // ---------------------------------------------------------------- 工作台管理（控制台「工作台」页用）
  ipcMain.handle('host:workbenches:list', () => ({ ok: true, trustNotice: WORKBENCH_TRUST_NOTICE, workbenches: ports.coordinator.list(), issues: ports.manager?.issues() ?? [] }))

  ipcMain.handle('host:workbenches:activate', (_event, id: string) => ports.coordinator.activate(id))

  ipcMain.handle('host:workbenches:acknowledge', (_event, id: string, capabilities: string[]) => ports.coordinator.acknowledge(id, Array.isArray(capabilities) ? capabilities : []))

  // 工作台参数：和插件同构，宿主在管理页渲染表单，页面用 window.workbench.settings 读同一份。
  ipcMain.handle('host:workbenches:settings', (_event, id: string) => ({ ok: true, values: ports.coordinator.settingsValues(id), schema: ports.manager?.get(id)?.manifest.settings ?? null }))

  ipcMain.handle('host:workbenches:settings:set', (_event, id: string, patch: Record<string, unknown>) => ({ ok: true, values: ports.coordinator.saveSettings(id, patch ?? {}) }))

  // 导出工作台包：和插件共用打包实现（内置那个随宿主分发，不给导出）。
  ipcMain.handle('host:workbenches:export-package', async (_event, id: string) => {
    const descriptor = ports.manager?.get(id)
    if (!descriptor) return { ok: false, error: '工作台不存在' }
    const options = {
      title: '导出工作台包',
      defaultPath: path.join(app.getPath('downloads'), `${descriptor.manifest.id}-${descriptor.manifest.version}.islandplugin`),
      filters: [{ name: '灵动岛插件包', extensions: ['islandplugin'] }],
    }
    const picked = ports.settingsWindow && !ports.settingsWindow.isDestroyed()
      ? await dialog.showSaveDialog(ports.settingsWindow, options)
      : await dialog.showSaveDialog(options)
    if (picked.canceled || !picked.filePath) return { ok: false, canceled: true }
    return await ports.coordinator.exportPackage(id, picked.filePath)
  })

  // 从插件包安装：包内是 workbench.json 就装成控制台，是 plugin.json 就装成插件。
  ipcMain.handle('host:workbenches:import-package', async () => {
    const picked = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: '灵动岛插件包', extensions: ['islandplugin', 'zip'] }] })
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true }
    try {
      const installed = await ports.installPackage(picked.filePaths[0])
      return { ok: true, ...installed }
    } catch (error) { return { ok: false, error: String((error as Error)?.message ?? error) } }
  })

  /**
   * 重载工作台：有开发目录就先同步一次（和插件热重载一致），再重新读清单 ——
   * 清单可能被改过（能力声明变了），所以重载后要按新声明刷新授权集。
   * 正在用的那个还要把视图重新加载，否则用户看不到改动。
   */
  ipcMain.handle('host:workbenches:reload', async (_event, id: string) => {
    if (!ports.manager?.get(id)) return { ok: false, error: '工作台不存在' }
    if (ports.manager.sourceOf(id)) ports.manager.syncFromSource(id)
    ports.manager.discover()
    const fresh = ports.manager.get(id)
    if (!fresh) return { ok: false, error: '重载后找不到这个工作台（workbench.json 可能被改坏了）' }
    if (ports.settings.value.activeWorkbench === id && ports.runtime.view && !ports.runtime.view.webContents.isDestroyed()) {
      await ports.runtime.reload(fresh)
    }
    ports.sendHost('host:workbenches-changed', ports.coordinator.list())
    return { ok: true, capabilities: fresh.capabilities }
  })

  ipcMain.handle('host:workbenches:install', async (_event, directory: string) => {    try {
      const descriptor = ports.manager!.installDirectory(directory)
      ports.logger?.append('_host', 'info', `已安装工作台「${descriptor.manifest.name}」（${descriptor.manifest.id}）`)
      ports.sendHost('host:workbenches-changed', ports.coordinator.list())
      return { ok: true, workbench: { id: descriptor.manifest.id, name: descriptor.manifest.name, version: descriptor.manifest.version, capabilities: descriptor.capabilities } }
    } catch (error) { return { ok: false, error: String((error as Error)?.message ?? error) } }
  })

  ipcMain.handle('host:workbenches:uninstall', (_event, id: string) => {
    try {
      ports.manager!.uninstall(id)
      // 卸掉的正是当前启用的那个 → 回落内置，**并且立刻把视图换过去**。
      // 只改设置不换视图的话，界面还停在已被删除的页面上，下一次切换还可能被它拖累。
      if (ports.settings.value.activeWorkbench === id) {
        ports.access.set(BUILTIN_WORKBENCH_ID, [])
        ports.settings.value.activeWorkbench = BUILTIN_WORKBENCH_ID
        ports.settings.save()
        ports.runtime.invalidate()
        if (ports.island.consoleVisible()) void ports.island.enterCustomMode()
      }
      const grants = { ...ports.settings.value.workbenchGrants }
      delete grants[id]
      ports.settings.value.workbenchGrants = grants
      ports.settings.save()
      ports.sendHost('host:workbenches-changed', ports.coordinator.list())
      return { ok: true }
    } catch (error) { return { ok: false, error: String((error as Error)?.message ?? error) } }
  })
}
