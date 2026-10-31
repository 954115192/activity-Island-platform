import type { BrowserWindow } from 'electron'

interface WindowLayerOptions {
  mainWindow(): BrowserWindow | null
  historyWindow(): BrowserWindow | null
  quitting(): boolean
  updateHitTest(): void
}

/** Coordinates topmost layers, overlap hit testing and fullscreen visibility. */
export function createWindowLayer(options: WindowLayerOptions) {
  let fullscreenHidden = false
  function auxiliaryWindowAt(point: Electron.Point): boolean {
    // Settings is an ordinary window below the island; only the topmost
    // notification history can take precedence where it overlaps the island.
    const win = options.historyWindow()
    if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return false
    const bounds = win.getBounds()
    return point.x >= bounds.x && point.x < bounds.x + bounds.width && point.y >= bounds.y && point.y < bounds.y + bounds.height
  }
  function syncHostLayerForAuxiliaryWindows(): void {
    const win = options.mainWindow()
    if (!win || win.isDestroyed()) return
    const history = options.historyWindow()
    if (history && !history.isDestroyed() && history.isAlwaysOnTop() !== !fullscreenHidden) history.setAlwaysOnTop(!fullscreenHidden, 'screen-saver')
    if (!fullscreenHidden && !win.isAlwaysOnTop()) win.setAlwaysOnTop(true, 'screen-saver')
    if (!fullscreenHidden) options.updateHitTest()
  }
  function watchAuxiliaryWindow(win: BrowserWindow): void {
    win.on('show', syncHostLayerForAuxiliaryWindows)
    win.on('hide', syncHostLayerForAuxiliaryWindows)
    win.on('closed', syncHostLayerForAuxiliaryWindows)
    syncHostLayerForAuxiliaryWindows()
  }
  function showHost(): void {
    const win = options.mainWindow()
    if (!win || win.isDestroyed() || fullscreenHidden) return
    win.showInactive()
    syncHostLayerForAuxiliaryWindows()
  }
  function updateHostVisibilityForFullscreen(fullscreen: boolean): void {
    const win = options.mainWindow()
    if (!win || win.isDestroyed() || options.quitting()) return
    fullscreenHidden = fullscreen
    syncHostLayerForAuxiliaryWindows()
    if (fullscreen) {
      if (win.isVisible()) win.hide()
      return
    }
    win.setAlwaysOnTop(true, 'screen-saver')
    if (!win.isVisible() || win.isMinimized()) {
      if (win.isMinimized()) win.restore()
      win.showInactive()
    }
    options.updateHitTest()
  }
  return {
    contains: auxiliaryWindowAt,
    sync: syncHostLayerForAuxiliaryWindows,
    watch: watchAuxiliaryWindow,
    show: showHost,
    fullscreenChanged: updateHostVisibilityForFullscreen,
    get hidden() { return fullscreenHidden },
    reset() { fullscreenHidden = false },
  }
}
