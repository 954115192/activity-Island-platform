import { ipcMain, clipboard, Menu, dialog, shell, type BrowserWindow, type WebContentsView } from 'electron'
import { BUILTIN_WORKBENCH_ID } from '../workbench/workbench-manager'
import type { PluginViewManager } from '../plugins/plugin-view-manager'
import type { IntentArbiter } from '../island/intent-arbiter'
import type { LocalSendService } from './service'
import type { IslandMode, PluginMode } from '../plugins/types'

export interface TransferIpcContext {
  readonly transferView: WebContentsView | null
  readonly mainWindow: BrowserWindow | null
  readonly workbenchView: WebContentsView | null
  readonly viewManager: PluginViewManager | null
  readonly activeWorkbenchId: string
  transferDragTimer: NodeJS.Timeout | null
  transferDragging: boolean
  readonly transferPanelOpen: boolean
  interruptTransition(): void
  readonly transferService: LocalSendService | null
  transferPanelSize: { width: number; height: number }
  readonly arbiter: IntentArbiter
  openTransferPanel(request?: { mode: 'files' | 'text'; text?: string }): Promise<void>
  createNotificationHistoryWindow(): BrowserWindow
  cancelCollapse(): void
  stageOrigin(width: number, height: number, top?: number): { x: number; y: number; width: number; height: number }
  stageHitRegion(stage: { x: number; y: number; width: number; height: number }, radius: number): { x: number; y: number; width: number; height: number; radius: number }
  setHitRegion(region: { x: number; y: number; width: number; height: number; radius?: number; interactive?: boolean }, refresh?: boolean): void
  sendLayout(mode: IslandMode, pluginMode?: PluginMode, separators?: number[], collapsed?: boolean, size?: { width: number; height: number }, top?: number, placements?: Array<{ pluginId: string; x: number; width: number; height: number }>, contentSize?: { width: number; height: number; top?: number }, clipPlugins?: boolean, showClock?: boolean, syncPlugins?: boolean): void
  sendHost(channel: string, payload?: unknown): void
  showHost(): void
  showRest(hovered?: boolean): Promise<void>
  hideTransferPanel(): void
}

export function registerTransferIpc(ctx: TransferIpcContext): void {
  const isTransferView = (event: Electron.IpcMainInvokeEvent) => ctx.transferView?.webContents === event.sender
  const isDropSurface = (event: Electron.IpcMainEvent) => event.sender === ctx.mainWindow?.webContents
    || event.sender === ctx.transferView?.webContents || event.sender === ctx.workbenchView?.webContents
    || !!ctx.viewManager?.helloFor(event.sender)
  ipcMain.on('transfers:open', (event, mode?: unknown) => {
    if (event.sender !== ctx.mainWindow?.webContents && !(event.sender === ctx.workbenchView?.webContents && ctx.activeWorkbenchId === BUILTIN_WORKBENCH_ID)) return
    if (mode === 'text') void ctx.openTransferPanel({ mode: 'text', text: clipboard.readText() })
    else if (mode === 'files') void ctx.openTransferPanel({ mode: 'files' })
    else void ctx.openTransferPanel()
  })
  ipcMain.on('host:quick-actions', event => {
    if (event.sender !== ctx.mainWindow?.webContents || !ctx.mainWindow || ctx.mainWindow.isDestroyed()) return
    Menu.buildFromTemplate([
      { label: '分享剪贴板文字/链接', click: () => { void ctx.openTransferPanel({ mode: 'text', text: clipboard.readText() }) } },
      { label: '文件传输', click: () => { void ctx.openTransferPanel({ mode: 'files' }) } },
      { type: 'separator' },
      { label: '通知历史', click: () => { ctx.createNotificationHistoryWindow() } },
    ]).popup({ window: ctx.mainWindow })
  })
  ipcMain.on('transfers:drag', (event, entered: boolean) => {
    if (!isDropSurface(event)) return
    if (ctx.transferDragTimer) clearTimeout(ctx.transferDragTimer)
    if (entered) {
      const alreadyDragging = ctx.transferDragging
      ctx.transferDragging = true
      // 保持原来的原生拖放目标直至 drop；只扩大宿主外壳，防止更换 WebContents 吞掉拖放。
      if (!ctx.transferPanelOpen && !alreadyDragging) {
        ctx.cancelCollapse()
        ctx.arbiter.interrupt()
        ctx.interruptTransition()
        const size = { width: 420, height: 110 }
        const stage = ctx.stageOrigin(size.width, size.height)
        ctx.setHitRegion(ctx.stageHitRegion(stage, 28), false)
        ctx.sendLayout('expanded', undefined, [], false, size, stage.y, [], size, false, false, false)
        ctx.sendHost('transfers:drag-preview', true)
        ctx.showHost()
      }
      ctx.transferDragTimer = setTimeout(() => { ctx.transferDragging = false; ctx.sendHost('transfers:drag-preview', false); if (!ctx.transferPanelOpen) void ctx.showRest() }, 15000)
    } else {
      ctx.transferDragTimer = setTimeout(() => { ctx.transferDragging = false; ctx.sendHost('transfers:drag-preview', false); if (!ctx.transferPanelOpen) void ctx.showRest() }, 250)
    }
  })
  ipcMain.on('transfers:drop', (event, paths: unknown) => {
    if (!isDropSurface(event)) return
    if (ctx.transferDragTimer) clearTimeout(ctx.transferDragTimer)
    ctx.transferDragging = false
    ctx.sendHost('transfers:drag-preview', false)
    void (async () => {
      await ctx.openTransferPanel()
      try { await ctx.transferService?.selectDroppedPaths(paths as string[]) }
      catch (error) { ctx.transferView?.webContents.send('transfers:error', String((error as Error).message || error)) }
    })()
  })
  ipcMain.handle('transfers:call', async (event, method: string, value: unknown) => {
    if (!isTransferView(event) || !ctx.transferService) return { ok: false, error: '没有文件传输访问权限' }
    try {
      switch (method) {
        case 'snapshot': return { ok: true, snapshot: ctx.transferService.snapshot() }
        case 'layout': {
          const size = value === 'text' ? { width: 640, height: 580 } : value === 'task' ? { width: 640, height: 560 } : value === 'connect' ? { width: 680, height: 700 } : { width: 680, height: 620 }
          if (size.width === ctx.transferPanelSize.width && size.height === ctx.transferPanelSize.height) break
          ctx.transferPanelSize = size
          if (ctx.transferPanelOpen && ctx.viewManager) {
            const stage = ctx.stageOrigin(size.width, size.height)
            ctx.setHitRegion(ctx.stageHitRegion(stage, 28), false)
            ctx.viewManager.setTransferStage(stage)
            ctx.sendLayout('custom', undefined, [], false, size, stage.y, [], size, true)
          }
          break
        }
        case 'refresh': ctx.transferService.announce(); break
        case 'retry': await ctx.transferService.start(); break
        case 'connect': await ctx.transferService.connect(String(value ?? '')); break
        case 'configure': await ctx.transferService.configure({ alias: String(value ?? '') }); break
        case 'choose': {
          const picked = await dialog.showOpenDialog(ctx.mainWindow!, { title: '选择要发送的文件', properties: ['openFile', 'multiSelections'] })
          if (!picked.canceled) await ctx.transferService.selectFiles(picked.filePaths, true)
          break
        }
        case 'choose-folder': {
          const picked = await dialog.showOpenDialog(ctx.mainWindow!, { title: '选择要发送的文件夹', properties: ['openDirectory', 'multiSelections'] })
          if (!picked.canceled) await ctx.transferService.selectFolders(picked.filePaths)
          break
        }
        case 'directory': {
          const picked = await dialog.showOpenDialog(ctx.mainWindow!, { title: '选择接收目录', defaultPath: ctx.transferService.snapshot().saveDirectory, properties: ['openDirectory', 'createDirectory'] })
          if (!picked.canceled && picked.filePaths[0]) await ctx.transferService.configure({ saveDirectory: picked.filePaths[0] })
          break
        }
        case 'send': {
          const input = value as { id?: unknown; pin?: unknown }
          await ctx.transferService.send(String(input?.id ?? ''), typeof input?.pin === 'string' ? input.pin : undefined)
          break
        }
        case 'send-text': {
          const input = value as { id?: unknown; text?: unknown; pin?: unknown }
          if (typeof input?.text !== 'string') throw new Error('请输入文本')
          await ctx.transferService.sendText(String(input.id ?? ''), input.text, typeof input.pin === 'string' ? input.pin : undefined)
          break
        }
        case 'retry-send': {
          const input = value as { id?: unknown; pin?: unknown }
          await ctx.transferService.retrySend(String(input?.id ?? ''), typeof input?.pin === 'string' ? input.pin : undefined)
          break
        }
        case 'copy-text': clipboard.writeText(ctx.transferService.textForCopy(String(value))); break
        case 'open-text': {
          const text = ctx.transferService.textForCopy(String(value)).trim()
          const url = new URL(text)
          if (!['https:', 'http:'].includes(url.protocol)) throw new Error('仅支持打开网页链接')
          await shell.openExternal(url.href)
          break
        }
        case 'accept': ctx.transferService.accept(String(value)); break
        case 'reject': ctx.transferService.reject(String(value)); break
        case 'cancel': ctx.transferService.cancel(String(value)); break
        case 'clear': ctx.transferService.clearDraft(); break
        case 'clear-history': await ctx.transferService.clearHistory(); break
        case 'remove': ctx.transferService.removeDraftFile(String(value)); break
        case 'reveal-file': {
          const input = value as { id?: unknown; fileId?: unknown }
          const target = await ctx.transferService.locationFor(String(input?.id ?? ''), typeof input?.fileId === 'string' ? input.fileId : undefined)
          shell.showItemInFolder(target)
          break
        }
        case 'folder': await shell.openPath(ctx.transferService.snapshot().saveDirectory); break
        case 'close': ctx.hideTransferPanel(); await ctx.showRest(); break
        default: return { ok: false, error: '未知文件传输操作' }
      }
      return { ok: true, snapshot: ctx.transferService.snapshot() }
    } catch (error) { return { ok: false, error: String((error as Error).message || error) } }
  })
}

