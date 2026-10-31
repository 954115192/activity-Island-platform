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

/** Owns one reusable workbench page and its in-flight navigation. */
export function createWorkbenchView(options: WorkbenchViewOptions) {
  let workbenchView: WebContentsView | null = null
  let workbenchPromise: Promise<WebContentsView | null> | null = null
  let loadedWorkbenchId: string | null = null
  async function loadWorkbenchEntry(view: WebContentsView, descriptor: WorkbenchDescriptor): Promise<WebContentsView> {
    const target = descriptor.manifest.id
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        if (view.webContents.isLoading()) view.webContents.stop()
        await view.webContents.loadFile(descriptor.entryPath)
        return view
      } catch (error) {
        if (loadedWorkbenchId !== target) return view
        if (attempt === 0) { await new Promise(resolve => setTimeout(resolve, 150)); continue }
        const message = String((error as Error)?.message ?? error)
        console.warn('[host] workbench load failed', error)
        options.log( 'error', `工作台「${descriptor.manifest.name}」（${target}）加载失败：${message}`)
      }
    }
    return view
  }

  /**
   * 取出工作台视图，并保证它加载的是**当前活动工作台**的入口。
   *
   * 视图只创建一次并复用；换了活动工作台时重新 `loadFile` 到新入口，而不是销毁重建
   * （重建会丢 adopt 关系，还会闪一下）。
   */
  function ensureWorkbenchView(): Promise<WebContentsView | null> {
    const mainWindow = options.hostWindow()
    if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve(null)
    const descriptor = options.resolve()
    if (workbenchView) {
      if (loadedWorkbenchId === descriptor.manifest.id) return Promise.resolve(workbenchView)
      const view = workbenchView
      loadedWorkbenchId = descriptor.manifest.id
      options.applyGrant(descriptor)
      options.log( 'info', `切换工作台 →「${descriptor.manifest.name}」（${descriptor.manifest.id}）`)
      workbenchPromise = loadWorkbenchEntry(view, descriptor)
      return workbenchPromise
    }
    if (workbenchPromise && loadedWorkbenchId === descriptor.manifest.id) return workbenchPromise
    const view = new WebContentsView({
      webPreferences: {
        preload: options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    })
    view.setBackgroundColor('#00000000')
    view.setVisible(false)
    // Hand the console to the view manager so it lives under the same animated
    // clip as the plugin pages instead of floating at full size over the island.
    options.adopt(view)
    workbenchView = view
    view.webContents.on('context-menu', event => event.preventDefault())
    view.webContents.on('render-process-gone', () => {
      workbenchView = null
      workbenchPromise = null
      loadedWorkbenchId = null
      options.adopt(null)
    })
    loadedWorkbenchId = descriptor.manifest.id
    options.applyGrant(descriptor)
    options.log( 'info', `加载工作台「${descriptor.manifest.name}」（${descriptor.manifest.id}）`)
    // Keep hold of the load promise: the console is warmed at startup, and a
    // right-click landing while that load is still running must await the same
    // view instead of creating a second one.
    workbenchPromise = loadWorkbenchEntry(view, descriptor)
    return workbenchPromise
  }

  return {
    ensure: ensureWorkbenchView,
    get view(): WebContentsView | null { return workbenchView },
    invalidate() { loadedWorkbenchId = null },
    async reload(descriptor: WorkbenchDescriptor): Promise<void> {
      if (!workbenchView || workbenchView.webContents.isDestroyed()) return
      options.applyGrant(descriptor)
      loadedWorkbenchId = descriptor.manifest.id
      await loadWorkbenchEntry(workbenchView, descriptor)
    },
  }
}
