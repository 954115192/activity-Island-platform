import { BrowserWindow, WebContentsView } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { PluginManager } from '../plugins/plugin-manager'
import type { PluginViewManager } from '../plugins/plugin-view-manager'
import type { createAppResources } from '../system/resources'
import type { createWindowLayer } from '../window/window-layer'

interface SettingsWindowsOptions {
  preloadDirectory: string
  readonly manager: PluginManager | null
  readonly views: PluginViewManager | null
  resources: ReturnType<typeof createAppResources>
  layer: ReturnType<typeof createWindowLayer>
}

/** Settings shell and its embedded custom plugin settings page. */
export function createSettingsWindows(options: SettingsWindowsOptions) {

  let settingsWindow: BrowserWindow | null = null

  function createSettingsWindow(tab?: string): BrowserWindow {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.focus()
      if (tab) settingsWindow.webContents.send('settings:tab', tab)
      return settingsWindow
    }
    const win = new BrowserWindow({
      width: 1100,
      height: 740,
      minWidth: 900,
      minHeight: 560,
      frame: false,
      title: 'Activity Island 控制台管理',
      backgroundColor: '#0b0d12',
      icon: options.resources.icon(),
      webPreferences: { preload: path.join(options.preloadDirectory, 'settings-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
    })
    settingsWindow = win
    options.layer.watch(win)
    void win.loadFile(path.join(options.resources.root(), 'console-apps', 'settings', 'index.html'), tab ? { query: { tab } } : undefined)
    win.on('closed', () => { settingsWindow = null; pluginPanel = null })
    win.on('resize', applyPluginPanelBounds)
    return win
  }

  // ---------------------------------------------------------------- 插件设置面板（manifest.settings 为字符串时）
  // 控制台「插件」页的「面板」按钮把插件的设置页（如 dist/settings.html）装进控制台窗口，
  // 用 WebContentsView 叠加在页面之上。页面带完整插件 preload（storage/events/log），
  // 后台脚本的 stdout 事件在 emitPluginEvent 里镜像给面板 —— 信箱/事件模式和岛上视图完全一致。
  let pluginPanel: { pluginId: string; view: WebContentsView } | null = null

  function applyPluginPanelBounds(): void {
    if (!pluginPanel || !settingsWindow || settingsWindow.isDestroyed()) return
    const { width, height } = settingsWindow.contentView.getBounds()
    pluginPanel.view.setBounds({ x: 0, y: 0, width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) })
  }

  function closePluginPanel(): void {
    const panel = pluginPanel
    if (!panel) return
    pluginPanel = null
    try { settingsWindow?.contentView.removeChildView(panel.view) } catch { /* 窗口可能正在销毁 */ }
    if (!panel.view.webContents.isDestroyed()) panel.view.webContents.close()
  }

  function openPluginPanel(pluginId: string): { ok: boolean; error?: string } {
    const plugin = options.manager?.get(pluginId)
    if (!plugin) return { ok: false, error: '插件未加载' }
    const settingsEntry = typeof plugin.manifest.settings === 'string' ? plugin.manifest.settings : null
    if (!settingsEntry) return { ok: false, error: '该插件没有声明自定义设置页（settings 字段不是路径）' }
    const pagePath = path.resolve(plugin.rootDir, settingsEntry)
    if (!pagePath.startsWith(path.resolve(plugin.rootDir) + path.sep)) return { ok: false, error: '非法的设置页路径' }
    if (!fs.existsSync(pagePath)) return { ok: false, error: `设置页不存在：${settingsEntry}` }
    const win = createSettingsWindow()
    closePluginPanel()

    const view = new WebContentsView({
      webPreferences: {
        preload: path.join(options.preloadDirectory, 'plugin-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    })
    view.setBackgroundColor('#0b0d12')
    pluginPanel = { pluginId, view }
    win.contentView.addChildView(view)
    applyPluginPanelBounds()
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    view.webContents.on('will-navigate', event => event.preventDefault())
    view.webContents.on('render-process-gone', () => { if (pluginPanel?.view === view) pluginPanel = null })
    void view.webContents.loadFile(pagePath, { query: { pluginId } }).then(() => {
      // 面板不是岛上的插件视图，viewManager 的契约推送轮不到它；加载完手动补握手 + 可见性，
      // 让 island.ready / onVisible 正常工作。
      if (pluginPanel?.view !== view || !options.views) return
      view.webContents.send('host:hello', options.views.helloPayloadFor(pluginId))
      view.webContents.send('host:visibility', { visible: true, reason: 'expanded', rendering: true })
    })
    return { ok: true }
  }
  return {
    open: createSettingsWindow,
    openPanel: openPluginPanel,
    closePanel: closePluginPanel,
    get window() { return settingsWindow },
    get panel() { return pluginPanel },
  }
}
