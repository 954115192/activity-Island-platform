import { ipcMain, dialog, type WebContentsView } from 'electron'
import os from 'node:os'
import type { WorkbenchManager } from './workbench-manager'
import { BUILTIN_WORKBENCH_ID } from './workbench-manager'
import type { WorkbenchCapability } from './capabilities'
import type { PluginStorage } from '../plugins/plugin-storage'
import type { PluginLogger } from '../plugins/plugin-logger'
import { workbenchOpen, workbenchHttp, workbenchRun } from './operations'
import { cpuPercent, networkStatus } from './system-status'

const WORKBENCH_RESIZE_EPSILON = 4
export interface WorkbenchIpcContext {
  readonly workbenchView: WebContentsView | null
  readonly activeWorkbenchId: string
  readonly workbenchManager: WorkbenchManager | null
  readonly storage: PluginStorage | null
  readonly workbenchLaidOutOnce: boolean
  readonly pluginLogger: PluginLogger | null
  workbenchGuard(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent, capability: WorkbenchCapability | null): string | null
  workbenchCapabilities(): { id: string; capabilities: string[] }
  workbenchSettingsValues(id: string): Record<string, unknown>
  saveWorkbenchSettings(id: string, patch: Record<string, unknown>): Record<string, unknown>
  consoleVisible(): boolean
  workbenchStorageId(): string
  workbenchSize(): { width: number; height: number }
  applyWorkbenchSize(size: { width?: unknown; height?: unknown }): { width: number; height: number; clamped: boolean }
  enterCustomMode(): Promise<void>
  workbenchLogId(): string
  readShortcuts(): Array<{ id: string; name: string; path: string }>
  writeShortcuts(items: Array<{ id: string; name: string; path: string }>): void
}

export function registerWorkbenchIpc(ctx: WorkbenchIpcContext): void {
  // ---------------------------------------------------------------- 工作台能力通道
  // 全部经过 ctx.workbenchGuard：必须是工作台页面 + 声明过对应能力。
  ipcMain.handle('workbench:capabilities', event => {
    const denied = ctx.workbenchGuard(event, null)
    if (denied) return { ok: false, error: denied }
    return { ok: true, ...ctx.workbenchCapabilities() }
  })
  // 工作台参数（workbench.json 的 settings.fields）：页面读自己那一份，宿主在管理页渲染表单。
  ipcMain.handle('workbench:settings:get', event => {
    const denied = ctx.workbenchGuard(event, null)
    return denied ? { ok: false, error: denied } : { ok: true, values: ctx.workbenchSettingsValues(ctx.activeWorkbenchId), schema: ctx.workbenchManager?.get(ctx.activeWorkbenchId)?.manifest.settings ?? null }
  })
  ipcMain.handle('workbench:settings:set', (event, patch: Record<string, unknown>) => {
    const denied = ctx.workbenchGuard(event, null)
    return denied ? { ok: false, error: denied } : { ok: true, values: ctx.saveWorkbenchSettings(ctx.activeWorkbenchId, patch ?? {}) }
  })
  // 自己的身份：页面用它定位自己的 resources/（跑随包脚本时要绝对路径）。
  ipcMain.handle('workbench:self', event => {
    const denied = ctx.workbenchGuard(event, null)
    if (denied) return { ok: false, error: denied }
    const descriptor = ctx.workbenchManager?.get(ctx.activeWorkbenchId)
    return {
      ok: true,
      id: ctx.activeWorkbenchId,
      name: descriptor?.manifest.name ?? ctx.activeWorkbenchId,
      version: descriptor?.manifest.version ?? '0.0.0',
      rootDir: descriptor?.rootDir ?? '',
      builtin: descriptor?.builtin ?? ctx.activeWorkbenchId === BUILTIN_WORKBENCH_ID,
    }
  })
  ipcMain.handle('workbench:system:status', event => {
    const denied = ctx.workbenchGuard(event, 'system')
    if (denied) return { ok: false, error: denied }
    return { ok: true, time: Date.now(), cpuPercent: cpuPercent(), memoryPercent: Math.round((1 - os.freemem() / os.totalmem()) * 100), memoryUsed: os.totalmem() - os.freemem(), memoryTotal: os.totalmem(), uptime: os.uptime(), platform: process.platform }
  })
  ipcMain.handle('workbench:system:network', async event => {
    const denied = ctx.workbenchGuard(event, 'system')
    if (denied) return { ok: false, error: denied, downloadMbps: 0, uploadMbps: 0, latencyMs: null }
    // 工作台一直挂着但可能在屏外：屏外就别每 2 秒起一次 PowerShell。
    if (ctx.workbenchView?.webContents === event.sender && !ctx.consoleVisible()) return { ok: false, downloadMbps: 0, uploadMbps: 0, latencyMs: null }
    const network = await networkStatus()
    return { ok: true, downloadMbps: network.downloadMbps, uploadMbps: network.uploadMbps, latencyMs: network.latencyMs }
  })
  ipcMain.handle('workbench:open', async (event, target: string) => {
    const denied = ctx.workbenchGuard(event, 'open')
    return denied ? { ok: false, error: denied } : await workbenchOpen(target)
  })
  ipcMain.handle('workbench:http', async (event, url: string, options: Record<string, unknown>) => {
    const denied = ctx.workbenchGuard(event, 'http')
    return denied ? { ok: false, error: denied } : await workbenchHttp(url, options ?? {})
  })
  ipcMain.handle('workbench:run', async (event, command: string, args: string[], options: Record<string, unknown>) => {
    const denied = ctx.workbenchGuard(event, 'run')
    return denied ? { ok: false, error: denied, code: null, stdout: '', stderr: '' } : await workbenchRun(command, args, options ?? {})
  })
  ipcMain.handle('workbench:storage:get', (event, key: string) => {
    const denied = ctx.workbenchGuard(event, 'storage')
    return denied ? { ok: false, error: denied } : { ok: true, value: ctx.storage?.get(ctx.workbenchStorageId(), key) }
  })
  ipcMain.handle('workbench:storage:set', (event, key: string, value: unknown) => {
    const denied = ctx.workbenchGuard(event, 'storage')
    if (denied) return { ok: false, error: denied }
    ctx.storage?.set(ctx.workbenchStorageId(), key, value)
    return { ok: true }
  })
  ipcMain.handle('workbench:storage:delete', (event, key: string) => {
    const denied = ctx.workbenchGuard(event, 'storage')
    if (denied) return { ok: false, error: denied }
    ctx.storage?.delete(ctx.workbenchStorageId(), key)
    return { ok: true }
  })
  ipcMain.handle('workbench:storage:all', (event) => {
    const denied = ctx.workbenchGuard(event, 'storage')
    return denied ? { ok: false, error: denied } : { ok: true, values: ctx.storage?.all(ctx.workbenchStorageId()) ?? {} }
  })
  /**
   * 工作台请求改尺寸。
   *
   * 两道守卫，都是被同一个真实 bug 逼出来的（第一次打开工作台"先慢慢变宽、再突然变高"）：
   *  1. **还没被排布过就不接受**：回环的根源是页面**在宿主把它排布好之前**量到了垃圾尺寸
   *     （那时视图还没有尺寸），这个值一旦被记下就会把第一次打开的动画带偏，甚至污染下一次。
   *     排布过一次之后，页面量到的就是真实尺寸，它再显式请求就有意义了。
   *     ⚠️ 判据用"排布过"而不是"当前可见"：工作台可能刚好被命中检测收回去，
   *     但那不代表它量不到正确尺寸（它保持上次的 bounds）。
   *  2. **小于 4px 的变化丢掉**：那是"自适应回环"的特征 —— 页面量到自己 = 当前盒子，
   *     于是请求 +2px，宿主照做，页面又量到 +2…… 实测能刷出 163 次布局、尺寸一路爬到上限。
   *     有意的调整（例如收掉一个面板）远大于这个量级，不会被误伤。
   */
  ipcMain.handle('workbench:resize', async (event, size: { width?: unknown; height?: unknown }) => {
    const denied = ctx.workbenchGuard(event, 'resize')
    if (denied) return { ok: false, error: denied }
    const current = ctx.workbenchSize()
    if (!ctx.workbenchLaidOutOnce) return { ok: false, error: 'not-laid-out', ...current }
    const requestedWidth = Number(size?.width)
    const requestedHeight = Number(size?.height)
    const isFeedback = Number.isFinite(requestedWidth) && Number.isFinite(requestedHeight)
      && Math.abs(requestedWidth - current.width) < WORKBENCH_RESIZE_EPSILON
      && Math.abs(requestedHeight - current.height) < WORKBENCH_RESIZE_EPSILON
    if (isFeedback) return { ok: true, ...current, clamped: false, ignored: 'below-threshold' }
    const applied = ctx.applyWorkbenchSize(size)
    // 正在显示就立刻重新布局；否则只记下来，下次右键打开时生效。
    if (ctx.consoleVisible()) await ctx.enterCustomMode()
    return { ok: true, ...applied }
  })
  ipcMain.on('workbench:log', (event, level: string, message: unknown) => {
    if (ctx.workbenchGuard(event, null)) return
    ctx.pluginLogger?.append(ctx.workbenchLogId(), level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info', message)
  })

  ipcMain.handle('workbench:shortcuts:get', event => {
    const denied = ctx.workbenchGuard(event, 'shortcuts')
    return denied ? { ok: false, error: denied } : { ok: true, shortcuts: ctx.readShortcuts() }
  })
  ipcMain.handle('workbench:shortcuts:add', (event, name: string, target: string) => {
    const denied = ctx.workbenchGuard(event, 'shortcuts')
    if (denied) return { ok: false, error: denied }
    const cleanName = String(name ?? '').trim()
    const cleanTarget = String(target ?? '').trim()
    if (!cleanName || !cleanTarget) return { ok: false, error: '名称和路径都要填' }
    const items = ctx.readShortcuts()
    const item = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: cleanName, path: cleanTarget }
    items.push(item)
    ctx.writeShortcuts(items)
    return { ok: true, shortcut: item }
  })
  ipcMain.handle('workbench:shortcuts:update', (event, id: string, patch: { name?: string; path?: string }) => {
    const denied = ctx.workbenchGuard(event, 'shortcuts')
    if (denied) return { ok: false, error: denied }
    const items = ctx.readShortcuts()
    const item = items.find(value => value.id === id)
    if (!item) return { ok: false, error: '这条快捷启动已经不存在了' }
    Object.assign(item, patch)
    ctx.writeShortcuts(items)
    return { ok: true }
  })
  ipcMain.handle('workbench:shortcuts:remove', (event, id: string) => {
    const denied = ctx.workbenchGuard(event, 'shortcuts')
    if (denied) return { ok: false, error: denied }
    const items = ctx.readShortcuts()
    const next = items.filter(value => value.id !== id)
    ctx.writeShortcuts(next)
    return { ok: next.length !== items.length }
  })
  ipcMain.handle('workbench:pick-file', async () => { const result = await dialog.showOpenDialog({ properties: ['openFile'] }); return result.canceled ? null : result.filePaths[0] })
  ipcMain.handle('workbench:pick-directory', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })
  // ---------------------------------------------------------------- 插件安装（控制台「插件」页）
}
