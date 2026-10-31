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
}

/** Owns transfer panel loading, drag state and the compact progress presentation. */
export function createTransferPanel(options: TransferPanelOptions) {

  let transferView: WebContentsView | null = null

  let transferViewLoading: Promise<void> | null = null

  let transferPanelOpen = false

  let transferDragging = false

  let transferProgressVisible = false

  let transferDragTimer: NodeJS.Timeout | null = null

  let transferPanelSize = { width: 680, height: 620 }

  function hideTransferPanel(): void {
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

  async function openTransferPanel(request?: TransferOpenRequest): Promise<void> {
    if (!options.hostWindow || !options.views) return
    if (transferPanelOpen && transferViewLoading) {
      await transferViewLoading
      if (request) transferView?.webContents.send('transfers:open-mode', request)
      return
    }
    const wasOpen = transferPanelOpen
    transferPanelOpen = true
    transferProgressVisible = false
    options.sendHost('transfers:progress', null)
    options.island.cancelCollapse()
    options.island.arbiter.interrupt()
    options.island.clearPendingMiniReveal()
    options.island.clearAlertCarry()
    options.island.sendAlert(null)
    options.island.hideWorkbench()
    if (wasOpen && transferView && !transferView.webContents.isDestroyed()) {
      transferView.webContents.send('transfers:change', options.service?.snapshot())
      if (request) transferView.webContents.send('transfers:open-mode', request)
      return
    }
    const serial = options.island.beginTransition()
    if (!transferView || transferView.webContents.isDestroyed()) {
      const view = new WebContentsView({ webPreferences: {
        preload: options.preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: false,
      } })
      transferView = view
      view.setBackgroundColor('#00000000')
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      view.webContents.on('will-navigate', event => event.preventDefault())
      options.views.adoptTransfer(view)
      transferViewLoading = view.webContents.loadFile(path.join(options.appRoot(), 'modules', 'file-transfer', 'index.html'))
      try { await transferViewLoading } finally { transferViewLoading = null }
    }
    if (!transferPanelOpen || serial !== options.island.transitionSerial) return
    const size = transferPanelSize
    const stage = options.island.stageOrigin(size.width, size.height)
    options.island.islandState.patch({ mode: 'custom', activePluginId: null, visiblePluginIds: [], sticky: true })
    options.island.setHitRegion(options.island.stageHitRegion(stage, 28), false)
    options.views.setTransferStage(stage)
    options.island.sendLayout('custom', undefined, [], false, size, stage.y, [], size, true)
    transferView?.webContents.send('transfers:change', options.service?.snapshot())
    if (request) transferView?.webContents.send('transfers:open-mode', request)
    options.layer.show()
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
