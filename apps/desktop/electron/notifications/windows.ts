import { BrowserWindow } from 'electron'
import path from 'node:path'
import { BUILTIN_NOTIFICATIONS_ID } from './module'

interface NotificationWindowsOptions {
  preloadDirectory: string
  appRoot(): string
  appIcon(): Electron.NativeImage | undefined
  watchWindow(window: BrowserWindow): void
}

/** Owns the notification history window and the pending clear confirmation. */
export function createNotificationWindows(options: NotificationWindowsOptions) {
  let notificationHistoryWindow: BrowserWindow | null = null
  let clearConfirmWindow: BrowserWindow | null = null
  let clearConfirmReply: ((action: 'app-only' | 'both' | 'cancel') => void) | null = null

  function showClearConfirm(parent: BrowserWindow | null, windowsAvailable: boolean): Promise<'app-only' | 'both' | 'cancel'> {
    if (clearConfirmWindow && !clearConfirmWindow.isDestroyed()) clearConfirmWindow.close()
    clearConfirmReply?.('cancel')

    return new Promise((resolve) => {
      let settled = false
      const finish = (action: 'app-only' | 'both' | 'cancel'): void => {
        if (settled) return
        settled = true
        clearConfirmReply = null
        resolve(action)
        if (clearConfirmWindow && !clearConfirmWindow.isDestroyed()) clearConfirmWindow.close()
        clearConfirmWindow = null
      }
      clearConfirmReply = finish

      const width = 400
      const height = windowsAvailable ? 296 : 248
      const win = new BrowserWindow({
        width,
        height,
        parent: parent ?? undefined,
        modal: Boolean(parent),
        frame: false,
        transparent: true,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        show: false,
        backgroundColor: '#00000000',
        skipTaskbar: true,
        webPreferences: {
          preload: path.join(options.preloadDirectory, 'notification-confirm-preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
        },
      })
      clearConfirmWindow = win
      win.setMenu(null)
      void win.loadFile(path.join(options.appRoot(), 'modules', BUILTIN_NOTIFICATIONS_ID, 'confirm.html'), {
        query: { windowsAvailable: windowsAvailable ? '1' : '0' },
      })
      win.once('ready-to-show', () => {
        win.show()
        win.focus()
      })
      win.on('closed', () => {
        if (clearConfirmWindow === win) clearConfirmWindow = null
        finish('cancel')
      })
    })
  }

  function createNotificationHistoryWindow(): BrowserWindow {
    if (notificationHistoryWindow && !notificationHistoryWindow.isDestroyed()) {
      notificationHistoryWindow.show()
      notificationHistoryWindow.focus()
      return notificationHistoryWindow
    }
    const win = new BrowserWindow({
      width: 720,
      height: 620,
      minWidth: 520,
      minHeight: 420,
      title: '通知历史',
      backgroundColor: '#0b0d12',
      icon: options.appIcon(),
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(options.preloadDirectory, 'notification-history-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    })
    notificationHistoryWindow = win
    options.watchWindow(win)
    win.on('closed', () => { notificationHistoryWindow = null })
    void win.loadFile(path.join(options.appRoot(), 'modules', BUILTIN_NOTIFICATIONS_ID, 'history.html'))
    return win
  }

  return {
    openHistory: createNotificationHistoryWindow,
    confirmClear: showClearConfirm,
    get history(): BrowserWindow | null { return notificationHistoryWindow },
    get reply() { return clearConfirmReply },
  }
}
