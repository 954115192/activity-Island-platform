import { WebContentsView, type BrowserWindow } from 'electron'
import path from 'node:path'
import { registerTransferIpc } from './ipc'
import type { LocalSendService } from './service'
import type { PluginViewManager } from '../plugins/plugin-view-manager'
import type { createIslandController } from '../island/controller'
import type { createWorkbenchView } from '../workbench/view'
import type { createWorkbenchAccess } from '../workbench/access'
import type { createWindowLayer } from '../window/window-layer'
import type { createNotificationWindows } from '../notifications/windows'

interface TransferPanelOptions {
  preloadPath: string
  readonly hostWindow: BrowserWindow | null
  readonly views: PluginViewManager | null
  readonly service: LocalSendService | null
  readonly workbench: ReturnType<typeof createWorkbenchView>
  readonly access: ReturnType<typeof createWorkbenchAccess>
  readonly island: ReturnType<typeof createIslandController>
  readonly layer: ReturnType<typeof createWindowLayer>
  readonly notifications: ReturnType<typeof createNotificationWindows>
  appRoot(): string
  sendHost(channel: string, payload?: unknown): void
  reportError(message: string): void
}

/** Owns transfer panel loading, drag state and the compact progress presentation. */
export function createTransferPanel(options: TransferPanelOptions) {

  let transferView: WebContentsView | null = null

  let transferViewLoading: Promise<WebContentsView | null> | null = null
  let viewReady = false
  let disposed = false
  let generation = 0
  let opening: { generation: number; promise: Promise<void> } | null = null
  let pendingRequest: TransferOpenRequest | undefined

  let transferPanelOpen = false

  let transferDragging = false

  let transferProgressVisible = false

  let transferDragTimer: NodeJS.Timeout | null = null

  let transferPanelSize = { width: 680, height: 620 }

  function hideTransferPanel(): void {
    ++generation
    opening = null
    pendingRequest = undefined
    transferPanelOpen = false
    transferDragging = false
    if (transferDragTimer) clearTimeout(transferDragTimer)
    transferDragTimer = null
    options.views?.setTransferStage(null)
  }

  function showTransferProgress(): boolean {
    if (!options.service || !options.views || transferPanelOpen || transferDragging || options.island.alertActive) return false
    const tasks = options.service.snapshot().sessions.filter(s => !['completed', 'failed', 'cancelled', 'rejected'].includes(s.state))
    if (!tasks.length) {
      if (transferProgressVisible) options.sendHost('transfers:progress', null)
      transferProgressVisible = false
      return false
    }
    const task = tasks[0]
    const progress = task.total ? Math.min(100, Math.floor((task.state === 'verifying' ? task.preparedBytes ?? 0 : task.bytes) / task.total * 100)) : 0
    const text = task.state === 'waiting' ? (task.direction === 'incoming' ? '有文件等待接收' : `等待 ${task.peer} 接受`)
      : task.state === 'verifying' ? `准备文件 · ${progress}%` : `${task.direction === 'incoming' ? '接收' : '发送'}文件 · ${progress}%`
    if (transferProgressVisible) {
      options.sendHost('transfers:progress', { text, progress })
      return true
    }
    options.island.clearPendingMiniReveal()
    options.island.cancelCollapse()
    options.island.hideWorkbench()
    const size = { width: 260, height: 40 }
    const stage = options.island.stageOrigin(size.width, size.height)
    transferProgressVisible = true
    options.island.islandState.patch({ mode: 'compact', activePluginId: null, visiblePluginIds: [], sticky: true })
    options.island.setHitRegion(options.island.stageHitRegion(stage, 20), false)
    options.island.sendLayout('compact', undefined, [], false, size, stage.y, [], size, false)
    options.sendHost('transfers:progress', { text, progress })
    options.layer.show()
    return true
  }

  type TransferOpenRequest = { mode: 'files' | 'text'; text?: string }

  function releaseView(view: WebContentsView): void {
    if (transferView !== view) return
    transferView = null
    viewReady = false
    if (options.hostWindow && !options.hostWindow.isDestroyed()) options.views?.adoptTransfer(null)
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }

  function ensureView(): Promise<WebContentsView | null> {
    if (transferViewLoading) return transferViewLoading
    if (transferView && viewReady && !transferView.webContents.isDestroyed()) return Promise.resolve(transferView)
    const view = new WebContentsView({ webPreferences: {
      preload: options.preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: false,
    } })
    transferView = view
    viewReady = false
    view.setBackgroundColor('#00000000')
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    view.webContents.on('will-navigate', event => event.preventDefault())
    options.views?.adoptTransfer(view)
    const loading = Promise.resolve().then(async () => {
      try {
        if (disposed || transferView !== view || view.webContents.isDestroyed()) return null
        await view.webContents.loadFile(path.join(options.appRoot(), 'modules', 'file-transfer', 'index.html'))
        if (disposed || transferView !== view || view.webContents.isDestroyed()) return null
        viewReady = true
        return view
      } catch (error) {
        releaseView(view)
        throw error
      } finally {
        if (transferViewLoading === loading) transferViewLoading = null
      }
    })
    transferViewLoading = loading
    return loading
  }

  function sendOpenMode(view: WebContentsView): void {
    if (!pendingRequest) return
    view.webContents.send('transfers:open-mode', pendingRequest)
    pendingRequest = undefined
  }

  function openTransferPanel(request?: TransferOpenRequest): Promise<void> {
    if (disposed || !options.hostWindow || options.hostWindow.isDestroyed() || !options.views) return Promise.resolve()
    if (request) pendingRequest = request
    if (opening && transferPanelOpen) return opening.promise
    if (transferPanelOpen && transferView && viewReady && !transferView.webContents.isDestroyed()) {
      transferView.webContents.send('transfers:change', options.service?.snapshot())
      sendOpenMode(transferView)
      return Promise.resolve()
    }
    transferPanelOpen = true
    transferProgressVisible = false
    options.sendHost('transfers:progress', null)
    options.island.cancelCollapse()
    options.island.arbiter.interrupt()
    options.island.clearPendingMiniReveal()
    options.island.clearAlertCarry()
    options.island.sendAlert(null)
    options.island.hideWorkbench()
    const serial = options.island.beginTransition()
    const token = ++generation
    const promise = Promise.resolve().then(async () => {
      try {
        const view = await ensureView()
        if (!view || disposed || !transferPanelOpen || token !== generation || serial !== options.island.transitionSerial) return
        const size = transferPanelSize
        const stage = options.island.stageOrigin(size.width, size.height)
        options.island.islandState.patch({ mode: 'custom', activePluginId: null, visiblePluginIds: [], sticky: true })
        options.island.setHitRegion(options.island.stageHitRegion(stage, 28), false)
        options.views?.setTransferStage(stage)
        options.island.sendLayout('custom', undefined, [], false, size, stage.y, [], size, true)
        view.webContents.send('transfers:change', options.service?.snapshot())
        sendOpenMode(view)
        options.layer.show()
      } catch (error) {
        if (disposed || token !== generation) return
        transferPanelOpen = false
        pendingRequest = undefined
        options.reportError(`文件传输面板加载失败：${String(error)}`)
        await options.island.showRest()
      } finally {
        if (opening?.generation === token) opening = null
      }
    })
    opening = { generation: token, promise }
    return promise
  }

  function installTransferIpc(): void {
    registerTransferIpc({
      get transferView() { return transferView },
      get mainWindow() { return options.hostWindow },
      get workbenchView() { return options.workbench.view },
      get viewManager() { return options.views },
      get activeWorkbenchId() { return options.access.id },
      get transferDragTimer() { return transferDragTimer },
      set transferDragTimer(value) { transferDragTimer = value },
      get transferDragging() { return transferDragging },
      set transferDragging(value) { transferDragging = value },
      get transferPanelOpen() { return transferPanelOpen },
      interruptTransition: () => { options.island.beginTransition() },
      get transferService() { return options.service },
      get transferPanelSize() { return transferPanelSize },
      set transferPanelSize(value) { transferPanelSize = value },
      get arbiter() { return options.island.arbiter },
      openTransferPanel, createNotificationHistoryWindow: options.notifications.openHistory, cancelCollapse: options.island.cancelCollapse, stageOrigin: options.island.stageOrigin, stageHitRegion: options.island.stageHitRegion, setHitRegion: options.island.setHitRegion, sendLayout: options.island.sendLayout, sendHost: options.sendHost, showHost: options.layer.show, showRest: options.island.showRest, hideTransferPanel
    })
  }
  return {
    dispose() {
      disposed = true
      hideTransferPanel()
      if (transferView) releaseView(transferView)
    },
    open: openTransferPanel,
    hide: hideTransferPanel,
    showProgress: showTransferProgress,
    registerIpc: installTransferIpc,
    get view() { return transferView },
    get isOpen() { return transferPanelOpen },
    get dragging() { return transferDragging },
    get progressVisible() { return transferProgressVisible },
    set progressVisible(value: boolean) { transferProgressVisible = value },
  }
}
