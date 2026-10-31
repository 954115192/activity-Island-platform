import { BrowserWindow } from 'electron'
import { WINDOW_SIZE } from '../island/geometry'
import type { createIslandController } from '../island/controller'

interface HostWindowOptions {
  preloadPath: string
  rendererFile: string
  island: ReturnType<typeof createIslandController>
  icon(): Electron.NativeImage | undefined
  quitting(): boolean
  closed(): void
  log(level: 'info' | 'error', message: string): void
}

/** Native host configuration and renderer recovery; interaction belongs to the island. */
export function createHostWindow(options: HostWindowOptions): BrowserWindow {
  const hostCrashTimes: number[] = []
  const win = new BrowserWindow({
    width: WINDOW_SIZE.width,
    height: WINDOW_SIZE.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    skipTaskbar: true,
    hasShadow: false,
    icon: options.icon(),
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    sandbox: false,
    },
  })
  // Use Electron's highest always-on-top level; fullscreen apps are hidden by
  // the foreground monitor before this can cover their display.
  win.setAlwaysOnTop(true, 'screen-saver')
  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(options.rendererFile)
  win.webContents.on('context-menu', event => {
    event.preventDefault()
    options.island.enterCustomMode()
  })
  win.on('blur', options.island.blur)
  // 灵动岛的画面就是这个渲染进程画的：它一崩，窗口还在、进程还在，但整个岛看起来"死了"，
  // 只能重启应用。这里自动重载并重新同步布局，用户无感恢复；同时把原因记下来方便排查。
  win.webContents.on('render-process-gone', (_event, details) => {
    const reason = `${details?.reason ?? 'unknown'} (exit ${details?.exitCode ?? '?'})`
    console.error('[host] island renderer gone', reason)
    // 打包后没有控制台，这种"整块看起来死掉"的原因必须落到日志里，否则用户只能说"它就是死了"。
    options.log( 'error', `灵动岛渲染进程崩溃：${reason}`)
    if (options.quitting() || win.isDestroyed()) return
    const now = Date.now()
    hostCrashTimes.push(now)
    while (hostCrashTimes.length && now - hostCrashTimes[0] > 60000) hostCrashTimes.shift()
    if (hostCrashTimes.length > 3) {
      options.log( 'error', '灵动岛渲染进程 1 分钟内崩溃超过 3 次，已停止自动恢复（请重启应用并把这份日志发出来）')
      return
    }
    options.log( 'info', '正在自动重载灵动岛（不用重启应用）')
    void win.reload()
  })
  win.on('closed', () => { options.closed(); options.island.detachWindow() })
  return win
}
