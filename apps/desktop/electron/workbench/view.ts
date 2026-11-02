import { WebContentsView, type BrowserWindow } from 'electron'
import type { WorkbenchDescriptor } from './workbench-manager'

interface WorkbenchViewOptions {
  preloadPath: string
  hostWindow(): BrowserWindow | null
  resolve(): WorkbenchDescriptor
  applyGrant(descriptor: WorkbenchDescriptor): void
  adopt(view: WebContentsView | null): void
  log(level: 'info' | 'error', message: string): void
}

/** Owns one page; callers share its current navigation, never a half-loaded view. */
export function createWorkbenchView(options: WorkbenchViewOptions) {
  let workbenchView: WebContentsView | null = null
  let loadedWorkbenchId: string | null = null
  let pending: { id: string; generation: number; promise: Promise<WebContentsView | null> } | null = null
  let generation = 0
  let disposed = false

  function alive(): boolean {
    const host = options.hostWindow()
    return !disposed && !!host && !host.isDestroyed()
  }

  function invalidate(): void {
    ++generation
    pending = null
    loadedWorkbenchId = null
  }

  function navigate(view: WebContentsView, descriptor: WorkbenchDescriptor): Promise<WebContentsView | null> {
    const token = ++generation
    loadedWorkbenchId = null
    options.applyGrant(descriptor)
    const current = () => alive() && token === generation && workbenchView === view && !view.webContents.isDestroyed()
    const promise = Promise.resolve().then(async () => {
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          if (!current()) return null
          try {
            if (view.webContents.isLoading()) view.webContents.stop()
            await view.webContents.loadFile(descriptor.entryPath)
            if (!current()) return null
            loadedWorkbenchId = descriptor.manifest.id
            return view
          } catch (error) {
            if (!current()) return null
            if (attempt === 0) { await new Promise(resolve => setTimeout(resolve, 150)); continue }
            options.log('error', `工作台「${descriptor.manifest.name}」（${descriptor.manifest.id}）加载失败：${String(error)}`)
          }
        }
        return null
      } finally {
        if (pending?.generation === token) pending = null
      }
    })
    pending = { id: descriptor.manifest.id, generation: token, promise }
    return promise
  }

  function ensure(): Promise<WebContentsView | null> {
    if (!alive()) return Promise.resolve(null)
    const descriptor = options.resolve()
    if (pending?.id === descriptor.manifest.id) return pending.promise
    if (workbenchView && !workbenchView.webContents.isDestroyed()) {
      if (loadedWorkbenchId === descriptor.manifest.id) return Promise.resolve(workbenchView)
      options.log('info', `切换工作台 →「${descriptor.manifest.name}」（${descriptor.manifest.id}）`)
      return navigate(workbenchView, descriptor)
    }
    const view = new WebContentsView({ webPreferences: {
      preload: options.preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: false,
    } })
    view.setBackgroundColor('#00000000')
    view.setVisible(false)
    options.adopt(view)
    workbenchView = view
    view.webContents.on('context-menu', event => event.preventDefault())
    view.webContents.on('render-process-gone', () => {
      if (workbenchView !== view) return
      invalidate()
      workbenchView = null
      if (alive()) options.adopt(null)
    })
    options.log('info', `加载工作台「${descriptor.manifest.name}」（${descriptor.manifest.id}）`)
    return navigate(view, descriptor)
  }

  return {
    ensure,
    get view(): WebContentsView | null { return workbenchView },
    invalidate,
    async reload(descriptor: WorkbenchDescriptor): Promise<void> {
      if (!alive() || !workbenchView || workbenchView.webContents.isDestroyed()) return
      await navigate(workbenchView, descriptor)
    },
    dispose(): void {
      if (disposed) return
      invalidate()
      const view = workbenchView
      if (alive()) options.adopt(null)
      disposed = true
      workbenchView = null
      if (view && !view.webContents.isDestroyed()) view.webContents.close()
    },
  }
}
