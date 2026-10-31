import type { InstalledArtifact } from './package-installer'
import { app, ipcMain, dialog, shell, type BrowserWindow, type WebContentsView } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { pruneOrder } from './plugin-order'
import type { PluginManager } from './plugin-manager'
import type { PluginViewManager } from './plugin-view-manager'
import type { PluginBackgroundManager } from './plugin-background-manager'
import type { PluginStorage } from './plugin-storage'
import type { PluginLogger } from './plugin-logger'
import type { createPluginCoordinator } from './coordinator'
import type { createIslandController } from '../island/controller'
import type { SettingsStore } from '../settings/store'

interface PluginIpcOptions {
  runtime: ReturnType<typeof createPluginCoordinator>
  island: ReturnType<typeof createIslandController>
  settings: SettingsStore
  services: {
    readonly manager: PluginManager | null
    readonly views: PluginViewManager | null
    readonly background: PluginBackgroundManager | null
    readonly storage: PluginStorage | null
    readonly logger: PluginLogger | null
  }
  readonly panel: { pluginId: string; view: WebContentsView } | null
  readonly settingsWindow: BrowserWindow | null
  openPanel(id: string): { ok: boolean; error?: string }
  closePanel(): void
  sendHost(channel: string, payload?: unknown): void
  installPackage(filePath: string): Promise<InstalledArtifact>
}

export function registerPluginIpc(ports: PluginIpcOptions): void {

  ipcMain.handle('host:plugins:list', () => ports.runtime.snapshot())

  ipcMain.handle('host:plugins:enabled:set', (_event, pluginId: string, enabled: boolean) => ports.runtime.setEnabled(pluginId, enabled))

  ipcMain.handle('host:plugins:mode:set', (_event, pluginId: string, mode: 'resident' | 'alert' | 'off') => {
    if (mode !== 'resident' && mode !== 'alert' && mode !== 'off') return { ok: false, error: '未知的上岛方式' }
    return ports.runtime.setMode(pluginId, mode)
  })

  // 工具按钮：宿主只转发 toolId/actionId，插件执行后自己推新数据（island.tools.set）。
  ipcMain.handle('host:plugins:tool:run', async (_event, pluginId: string, toolId: string, actionId: string) => {
    const plugin = ports.services.manager?.get(pluginId)
    if (!plugin) return { ok: false, error: '插件未加载' }
    if (!ports.runtime.enabled(pluginId)) return { ok: false, error: '插件已关闭，先打开插件' }
    const tool = plugin.manifest.tools?.find(item => item.id === toolId)
    const action = tool?.actions?.find(item => item.id === actionId)
    if (!tool || !action) return { ok: false, error: '工具或动作不存在' }
    let delivered = false
    try {
      if (ports.services.views) {
        await ports.services.views.ensure(plugin)
        ports.services.views.sendToPlugin(pluginId, 'host:tool-action', { toolId, actionId })
        delivered = true
      }
    } catch { /* 视图加载失败时继续尝试面板 */ }
    if (ports.panel?.pluginId === pluginId && !ports.panel.view.webContents.isDestroyed()) {
      ports.panel.view.webContents.send('host:tool-action', { toolId, actionId })
      delivered = true
    }
    ports.services.logger?.append(pluginId, 'info', `工具动作 ${tool.id}/${actionId}${delivered ? ' 已发送' : ' 未送达（没有运行视图）'}`)
    return delivered ? { ok: true } : { ok: false, error: '插件当前没有运行视图，先打开插件或重试' }
  })

  // 在资源管理器中定位插件目录。
  ipcMain.handle('host:plugins:reveal', (_event, pluginId: string) => {
    const plugin = ports.services.manager?.get(pluginId)
    if (!plugin) return { ok: false, error: '插件未加载' }
    shell.showItemInFolder(path.join(plugin.rootDir, 'plugin.json'))
    return { ok: true }
  })

  ipcMain.handle('host:plugins:open-dir', async () => {
    const directory = path.join(app.getPath('userData'), 'plugins')
    fs.mkdirSync(directory, { recursive: true })
    const error = await shell.openPath(directory)
    return error ? { ok: false, error } : { ok: true }
  })

  ipcMain.handle('host:logs:open-dir', async () => {
    const directory = path.join(app.getPath('userData'), 'island-plugins', 'logs')
    fs.mkdirSync(directory, { recursive: true })
    const error = await shell.openPath(directory)
    return error ? { ok: false, error } : { ok: true }
  })

  // 发现阶段的问题（以前是静默跳过）：控制台要能告诉作者"为什么没加载"。
  ipcMain.handle('host:plugins:issues', () => ports.runtime.issues())

  ipcMain.handle('host:plugins:logs', (_event, pluginId: string) => ({ ok: true, lines: ports.services.logger?.tail(pluginId) ?? [] }))

  ipcMain.handle('host:plugins:logs:clear', (_event, pluginId: string) => { ports.services.logger?.clear(pluginId); return { ok: true } })

  ipcMain.handle('host:plugins:reload', async (_event, pluginId: string) => {
    if (!ports.services.manager?.has(pluginId)) return { ok: false, error: '插件未加载' }
    await ports.runtime.reloader.reload(pluginId, ports.services.manager.sourceOf(pluginId) ? 'source' : 'installed')
    return { ok: true }
  })

  // 插件设置面板：控制台「插件」页的「面板」按钮；关闭由面板页自己发 panel:close。
  ipcMain.handle('settings:plugin-panel', (_event, pluginId: string) => ports.openPanel(pluginId))

  ipcMain.on('panel:close', (event) => { if (ports.panel && ports.panel.view.webContents === event.sender) ports.closePanel() })

  ipcMain.handle('host:plugins:install', async (_event, directory: string) => {
    try {
      const plugin = ports.services.manager!.installDirectory(directory)
      ports.services.logger?.append(plugin.manifest.id, 'info', `已安装 v${plugin.manifest.version}，源码目录 ${directory}`)
      ports.services.background?.start(plugin)
      ports.runtime.reloader.watch()
      await ports.island.showCompact()
      ports.sendHost('host:plugins-changed', ports.runtime.list().map(item => item.manifest))
      return { ok: true, plugin: plugin.manifest }
    } catch (error) { return { ok: false, error: String(error) } }
  })

  ipcMain.handle('host:plugins:uninstall', async (_event, pluginId: string) => {
    try {
      if (!ports.services.manager?.has(pluginId)) return { ok: false, error: '插件未加载' }
      ports.island.arbiter.interrupt()
      if (ports.panel?.pluginId === pluginId) ports.closePanel()
      ports.runtime.tools.clear(pluginId)
      ports.services.background?.stop(pluginId); ports.services.views?.destroy(pluginId); ports.services.manager!.uninstall(pluginId); ports.services.storage?.remove(pluginId)
      ports.settings.value.pluginOrder = pruneOrder(ports.settings.value.pluginOrder, ports.runtime.list().map(item => item.manifest.id))
      ports.settings.save()
      ports.runtime.reloader.watch()
      await ports.island.showCompact()
      ports.sendHost('host:plugins-changed', ports.runtime.list().map(item => item.manifest))
      return { ok: true }
    } catch (error) { return { ok: false, error: String(error) } }
  })

  ipcMain.handle('plugin:settings:get', (_event, pluginId: string) => ports.services.manager?.has(pluginId) ? ({ values: ports.runtime.settingsValues(pluginId), schema: ports.services.manager.get(pluginId)?.manifest.settings ?? null }) : ({ values: {}, schema: null }))

  ipcMain.handle('plugin:settings:set', (_event, pluginId: string, patch: Record<string, unknown>) => ports.services.manager?.has(pluginId) ? ({ values: ports.runtime.saveSettings(pluginId, patch ?? {}) }) : ({ values: {} }))

  ipcMain.handle('host:plugins:settings', (_event, pluginId: string) => ports.services.manager?.has(pluginId) ? ({ ok: true, values: ports.runtime.settingsValues(pluginId), schema: ports.services.manager.get(pluginId)?.manifest.settings ?? null }) : ({ ok: false, error: '插件未加载' }))

  ipcMain.handle('host:plugins:settings:set', (_event, pluginId: string, patch: Record<string, unknown>) => {
    if (!ports.services.manager?.has(pluginId)) return { ok: false, error: '插件未加载' }
    const values = ports.runtime.saveSettings(pluginId, patch ?? {})
    const target = ports.settingsWindow
    if (target && !target.isDestroyed()) target.webContents.send('settings:plugin-values', { pluginId, values })
    return { ok: true, values }
  })

  ipcMain.handle('plugin:storage:get', (_event, pluginId: string, key: string) => ports.services.manager?.has(pluginId) ? ports.services.storage?.get(pluginId, key) : undefined)

  ipcMain.handle('plugin:storage:set', (_event, pluginId: string, key: string, value: unknown) => { if (!ports.services.manager?.has(pluginId)) return { ok: false }; ports.services.storage?.set(pluginId, key, value); return { ok: true } })

  // 插件主动握手：它的脚本可能早于宿主推送 host:hello 运行。
  ipcMain.handle('plugin:hello', event => ports.services.views?.helloFor(event.sender) ?? null)

  // 插件自己的日志（island.log.* / 页面未捕获异常）。
  ipcMain.on('plugin:log', (_event, pluginId: string, level: string, message: unknown) => {
    if (typeof pluginId !== 'string') return
    ports.services.logger?.append(pluginId, level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info', message)
  })

  ipcMain.on('host:command', (_event, pluginId: string, command: string, args: unknown[] = []) => ports.island.handlePluginCommand(pluginId, command, args))

  ipcMain.on('host:event', (_event, pluginId: string, name: string, payload: unknown) => ports.runtime.emit(pluginId, name, payload))

  ipcMain.on('plugin:mode-ready', (event, pluginId: unknown, mode: unknown) => {
    if (typeof pluginId !== 'string' || (mode !== 'small' && mode !== 'medium' && mode !== 'large')) return
    const sender = event.sender
    const hello = ports.services.views?.helloFor(sender) as { pluginId?: string } | null
    if (hello?.pluginId !== pluginId) return
    ports.services.views?.modeReady(pluginId, mode)
  })

  ipcMain.handle('plugins:pick-directory', async () => { const result = await dialog.showOpenDialog({ properties: ['openDirectory'] }); return result.canceled ? null : result.filePaths[0] })

  ipcMain.handle('plugins:install', async (_event, directory: string) => {
    try {
      const plugin = ports.services.manager!.installDirectory(directory)
      ports.services.background?.start(plugin)
      await ports.island.showCompact()
      ports.sendHost('host:plugins-changed', ports.runtime.list().map(item => item.manifest))
      return { ok: true, plugin: plugin.manifest }
    } catch (error) { return { ok: false, error: String(error) } }
  })

  ipcMain.handle('plugins:pick-package', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: '灵动岛插件包', extensions: ['islandplugin', 'zip'] }] })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('plugins:install-package', async (_event, filePath: string) => {
    try {
      // 包内清单决定装成插件还是控制台 —— 这一个按钮两种都能装。
      const installed = await ports.installPackage(filePath)
      return { ok: true, kind: installed.kind, plugin: { id: installed.id, name: installed.name, version: installed.version }, capabilities: installed.capabilities }
    } catch (error) { return { ok: false, error: String(error) } }
  })

  // 导出插件包：宿主自己打包，不依赖插件目录里有没有 pack.ps1。
  ipcMain.handle('plugins:export-package', async (_event, pluginId: string) => {
    const plugin = ports.services.manager?.get(pluginId)
    if (!plugin) return { ok: false, error: '插件未加载' }
    const options = {
      title: '导出插件包',
      defaultPath: path.join(app.getPath('downloads'), `${plugin.manifest.id}-${plugin.manifest.version}.islandplugin`),
      filters: [{ name: '灵动岛插件包', extensions: ['islandplugin'] }],
    }
    const picked = ports.settingsWindow && !ports.settingsWindow.isDestroyed()
      ? await dialog.showSaveDialog(ports.settingsWindow, options)
      : await dialog.showSaveDialog(options)
    if (picked.canceled || !picked.filePath) return { ok: false, canceled: true }
    return await ports.runtime.exportPackage(pluginId, picked.filePath)
  })
}
