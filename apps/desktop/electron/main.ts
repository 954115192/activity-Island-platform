import { registerIslandIpc } from './island/ipc'
import { registerWindowIpc } from './window/ipc'
import { registerSkillExportIpc } from './plugins/skill-export'
import { createPackageInstaller } from './plugins/package-installer'
import { createHostWindow } from './window/host-window'
import { sendMediaKey } from './system/media-keys'
import { createSettingsWindows } from './settings/windows'
import { createAppResources } from './system/resources'
import { registerWorkbenchManagementIpc } from './workbench/management-ipc'
import { registerPluginIpc } from './plugins/ipc'
import { createWorkbenchCoordinator } from './workbench/coordinator'
import { createPluginCoordinator } from './plugins/coordinator'
import { createTransferPanel } from './transfers/panel'
import { createIslandController } from './island/controller'
import { createWorkbenchAccess } from './workbench/access'
import { createWorkbenchView } from './workbench/view'
import { createWindowLayer } from './window/window-layer'
import { createNotificationWindows } from './notifications/windows'
import { SettingsController } from './settings/controller'
import { registerSettingsIpc } from './settings/ipc'
import { SettingsStore } from './settings/store'
import { applyLaunchAtLogin } from './system/startup'
import { createTray } from './system/tray'
import { registerWorkbenchIpc } from './workbench/ipc'
import { registerNotificationIpc } from './notifications/ipc'
import { createUpdateChecker } from './updates/checker'
import { app, BrowserWindow, screen, Tray } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { EventBus } from './events/event-bus'
import { PluginBackgroundManager } from './plugins/plugin-background-manager'
import { PluginLogger } from './plugins/plugin-logger'
import { PluginManager } from './plugins/plugin-manager'
import { PluginStorage } from './plugins/plugin-storage'
import { PluginViewManager } from './plugins/plugin-view-manager'
import { PluginWatcher } from './plugins/plugin-watcher'
import { ForegroundFullscreenMonitor } from './window/foreground-fullscreen'
import { BUILTIN_NOTIFICATIONS_ID, NotificationModule } from './notifications/module'
import { LocalSendService } from './transfers/service'
import { WorkbenchManager } from './workbench/workbench-manager'
import type { PluginDescriptor, PluginManifest } from './plugins/types'

const CONTRACT_VERSION = 2
const HOST_CAPABILITIES = ['media', 'process']

let mainWindow: BrowserWindow | null = null
let pluginManager: PluginManager | null = null
let viewManager: PluginViewManager | null = null
let backgroundManager: PluginBackgroundManager | null = null
let storage: PluginStorage | null = null
let pluginLogger: PluginLogger | null = null
let pluginWatcher: PluginWatcher | null = null
/** 工作台：独立目录 + 独立管理器，**不混进插件列表**。 */
let workbenchManager: WorkbenchManager | null = null
/** 内置通知能力：Windows 通知接管 + 本地触发接口 + 统一历史。 */
let notificationModule: NotificationModule | null = null
let transferService: LocalSendService | null = null
let tray: Tray | null = null
let hitPoll: NodeJS.Timeout | null = null
let fullscreenMonitor: ForegroundFullscreenMonitor | null = null
let quitRequested = false

// Shared paths and persistent preferences.
const resources = createAppResources((level, message) => pluginLogger?.append('_host', level, message))

const settingsStore = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'))
const islandSettings = settingsStore.value

// Workbench identity, catalog and its reusable page.
const workbenchAccess = createWorkbenchAccess(sender => {
  const view = workbenchRuntime.view
  return !!view && !view.webContents.isDestroyed() && view.webContents === sender
})

const workbenches = createWorkbenchCoordinator({
  dataDirectory: path.join(app.getPath('userData'), 'workbench'),
  settings: settingsStore,
  access: workbenchAccess,
  get runtime() { return workbenchRuntime },
  get island() { return island },
  get manager() { return workbenchManager },
  get storage() { return storage },
  get logger() { return pluginLogger },
  appRoot: resources.root, sendHost,
})

const workbenchRuntime = createWorkbenchView({
  preloadPath: path.join(__dirname, 'preload', 'workbench-preload.js'),
  hostWindow: () => mainWindow,
  resolve: workbenches.resolve,
  applyGrant: workbenchAccess.apply,
  adopt: view => viewManager?.adoptWorkbench(view),
  log: (level, message) => pluginLogger?.append('_host', level, message),
})

const windowLayer = createWindowLayer({
  mainWindow: () => mainWindow,
  historyWindow: () => notificationWindows.history,
  quitting: () => quitRequested,
  updateHitTest: () => island.updateHitTest(),
})

const notificationWindows = createNotificationWindows({
  preloadDirectory: path.join(__dirname, 'preload'),
  appRoot: resources.root, appIcon: resources.icon,
  watchWindow: windowLayer.watch,
})

const settingsUi = createSettingsWindows({
  preloadDirectory: path.join(__dirname, 'preload'),
  get manager() { return pluginManager },
  get views() { return viewManager },
  resources, layer: windowLayer,
})

// Domain coordinators use live service getters; they do not start work here.
const events = new EventBus()
const pluginsRuntime = createPluginCoordinator({
  settings: settingsStore,
  events,
  get island() { return island },
  get notification() { return notificationView },
  services: {
    get manager() { return pluginManager },
    get views() { return viewManager },
    get background() { return backgroundManager },
    get storage() { return storage },
    get logger() { return pluginLogger },
    get watcher() { return pluginWatcher },
  },
  windows: {
    get settings() { return settingsUi.window },
    get panel() { return settingsUi.panel },
    closePanel: settingsUi.closePanel,
  },
  runtimeView, sendHost,
  settingsChanged: sendSettingsChanged,
})

const installPackage = createPackageInstaller({
  get plugins() { return pluginManager },
  get workbenches() { return workbenchManager },
  get background() { return backgroundManager },
  log: (id, level, message) => pluginLogger?.append(id, level, message),
  watch: () => pluginsRuntime.reloader.watch(),
  refreshIsland: () => island.showCompact(),
  pluginsChanged: () => sendHost('host:plugins-changed', pluginsRuntime.list().map(item => item.manifest)),
  workbenchesChanged: () => sendHost('host:workbenches-changed', workbenches.list()),
})

const transfers = createTransferPanel({
  preloadPath: path.join(__dirname, 'preload', 'transfer-preload.js'),
  get hostWindow() { return mainWindow },
  get views() { return viewManager },
  get service() { return transferService },
  get workbench() { return workbenchRuntime },
  get access() { return workbenchAccess },
  get island() { return island },
  get layer() { return windowLayer },
  get notifications() { return notificationWindows },
  appRoot: resources.root, sendHost,
})

const island = createIslandController({
  settings: islandSettings,
  events,
  host: {
    get window() { return mainWindow },
    get views() { return viewManager },
    get logger() { return pluginLogger },
    get layer() { return windowLayer },
    send: sendHost,
  },
  plugins: { hidden: pluginsRuntime.hidden, tools: pluginsRuntime.tools, ordered: pluginsRuntime.ordered, get: runtimeView, list: runtimeViews },
  get workbench() { return workbenchRuntime },
  transfers: {
    get dragging() { return transfers.dragging },
    get open() { return transfers.isOpen },
    get progressVisible() { return transfers.progressVisible },
    set progressVisible(value) { transfers.progressVisible = value },
    hide: transfers.hide,
    showProgress: transfers.showProgress,
  },
  mediaKey: sendMediaKey,
})

// 通知是宿主功能；只复用视图排版与动画，不参加插件发现和管理。
function notificationViewDescriptor(): PluginDescriptor {
  const rootDir = path.join(resources.root(), 'modules', BUILTIN_NOTIFICATIONS_ID)
  const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'module.json'), 'utf8')) as PluginManifest
  return { manifest, rootDir, entryPath: path.join(rootDir, 'index.html') }
}
let notificationView: PluginDescriptor | null = null
function runtimeView(id: string): PluginDescriptor | undefined {
  return id === BUILTIN_NOTIFICATIONS_ID ? notificationView ?? undefined : pluginManager?.get(id)
}
function runtimeViews(): PluginDescriptor[] { return notificationView ? [...pluginsRuntime.list(), notificationView] : pluginsRuntime.list() }

function saveNotificationSettings(patch: Record<string, unknown>): Record<string, unknown> {
  // 沿用原存储位置以保留升级前的通知配置。
  const next = pluginsRuntime.storeSettings(BUILTIN_NOTIFICATIONS_ID, patch)
  void notificationModule?.applySettings(next)
  viewManager?.sendToPlugin(BUILTIN_NOTIFICATIONS_ID, 'host:settings', { values: next, schema: notificationView?.manifest.settings ?? null })
  return next
}
function sendHost(channel: string, payload?: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

// ---------------------------------------------------------------- 更新检查
// 只读 GitHub Releases 的 latest，不自动下载安装；有新版时由「关于」页给出跳转。
const updateChecker = createUpdateChecker((level, message) => pluginLogger?.append('_host', level, message))
const checkForUpdates = updateChecker.checkForUpdates

const settingsController = new SettingsController(settingsStore, {
  pluginIds: () => pluginsRuntime.list().map(plugin => plugin.manifest.id),
  launchAtLogin: applyLaunchAtLogin,
  changed: () => sendSettingsChanged(),
  applyLayout: island.applySettingsLayout,
})

function sendSettingsChanged(): void {
  sendHost('settings:changed', settingsStore.snapshot())
  if (settingsUi.window && !settingsUi.window.isDestroyed()) settingsUi.window.webContents.send('settings:changed', settingsStore.snapshot())
}

// Existing test/internal capability seam; production changes go through the coordinator.
export function workbenchCapabilities() { return workbenchAccess.snapshot() }
/** Test/internal seam; changes capabilities without persisting settings. */
export function setActiveWorkbench(id: string, declared: unknown): void { workbenchAccess.set(id, declared) }
function closeAppWindows(): void {
  fullscreenMonitor?.stop()
  fullscreenMonitor = null
  windowLayer.reset()
  // Hide the transparent always-on-top host before tearing down child views so
  // the Windows trigger strip disappears immediately during tray exit.
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    if (win.isDestroyed()) continue
    try { win.hide() } catch { /* window is already closing */ }
  }
  if (hitPoll) { clearInterval(hitPoll); hitPoll = null }
  island.cancelCollapse()
  pluginWatcher?.close()
  backgroundManager?.stopAll()
  viewManager?.destroyAll()
  events.clear()
  tray?.destroy()
  tray = null
  for (const win of windows) if (!win.isDestroyed()) {
    try { win.destroy() } catch { /* window is already closing */ }
  }
  mainWindow = null

  island.detachWindow()
}
/** Ensures the built-in view exists before delivering its first notification. */
function emitNotificationEvent(name: string, payload: unknown): void {
  const manager = viewManager
  if (!manager) return
  if (manager.has(BUILTIN_NOTIFICATIONS_ID)) {
    manager.sendToPlugin(BUILTIN_NOTIFICATIONS_ID, 'host:event', { name, payload })
    return
  }
  // 视图尚未加载：先创建，加载完成后再补发这条事件（提醒不能丢）。
  const descriptor = notificationView
  if (!descriptor) return
  void manager.ensure(descriptor).then(() => {
    viewManager?.sendToPlugin(BUILTIN_NOTIFICATIONS_ID, 'host:event', { name, payload })
  })
}

/** 托盘提示里带一条通知状态摘要（不含正文），方便确认监听是否在跑。 */
function refreshNotificationTrayHint(): void {
  if (!tray || !notificationModule) return
  const status = notificationModule.status()
  const windows = status.windows
  const windowsText = windows.access === 'allowed' ? '监听中' : windows.access === 'denied' ? '未授权' : windows.access === 'unspecified' ? '待授权' : '不可用'
  tray.setToolTip(`Activity Island · 通知 ${windowsText} · 历史 ${status.totalRecords} 条`)
}

// Register domain adapters once runtime services and the host view are ready.
function wireIpc(): void {
  registerIslandIpc({ island, get window() { return mainWindow } })
  registerWindowIpc({ settings: settingsUi, workbench: workbenchRuntime, island })
  registerSkillExportIpc({ resources, get logger() { return pluginLogger } })

  registerWorkbenchManagementIpc({
    get manager() { return workbenchManager },
    get settingsWindow() { return settingsUi.window },
    get logger() { return pluginLogger },
    coordinator: workbenches,
    runtime: workbenchRuntime,
    access: workbenchAccess,
    island, settings: settingsStore,
    sendHost, installPackage,
  })

  registerPluginIpc({
    runtime: pluginsRuntime,
    island,
    settings: settingsStore,
    services: {
      get manager() { return pluginManager },
      get views() { return viewManager },
      get background() { return backgroundManager },
      get storage() { return storage },
      get logger() { return pluginLogger },
    },
    get panel() { return settingsUi.panel },
    get settingsWindow() { return settingsUi.window },
    openPanel: settingsUi.openPanel,
    closePanel: settingsUi.closePanel,
    sendHost, installPackage,
  })

  registerNotificationIpc({
    get settingsWindow() { return settingsUi.window },
    get viewManager() { return viewManager },
    get notificationView() { return notificationView },
    get notificationModule() { return notificationModule },
    get notificationHistoryWindow() { return notificationWindows.history },
    get clearConfirmReply() { return notificationWindows.reply },
    pluginSettingsValues: pluginsRuntime.settingsValues, saveNotificationSettings, showClearConfirm: notificationWindows.confirmClear, createNotificationHistoryWindow: notificationWindows.openHistory
  })

  registerSettingsIpc({
    controller: settingsController,
    snapshot: () => ({ ...settingsStore.snapshot(), appVersion: app.getVersion(), plugins: pluginsRuntime.list().map(item => item.manifest) }),
    updateStatus: () => ({
      ...(updateChecker.status ?? { currentVersion: app.getVersion(), checkedAt: 0 }),
      checkUpdatesOnLaunch: islandSettings.checkUpdatesOnLaunch,
    }),
    checkUpdates: () => checkForUpdates(true),
  })
  registerWorkbenchIpc({
    get workbenchView() { return workbenchRuntime.view },
    get activeWorkbenchId() { return workbenchAccess.id },
    get workbenchManager() { return workbenchManager },
    get storage() { return storage },
    get workbenchLaidOutOnce() { return island.workbenchLaidOutOnce },
    get pluginLogger() { return pluginLogger },
    workbenchGuard: workbenchAccess.guard,
    workbenchCapabilities,
    workbenchSettingsValues: workbenches.settingsValues,
    saveWorkbenchSettings: workbenches.saveSettings,
    consoleVisible: island.consoleVisible,
    workbenchStorageId: workbenches.storageId,
    workbenchSize: island.workbenchSizing.current,
    applyWorkbenchSize: island.workbenchSizing.apply,
    enterCustomMode: island.enterCustomMode,
    workbenchLogId: workbenches.logId,
    readShortcuts: workbenches.readShortcuts,
    writeShortcuts: workbenches.writeShortcuts
  })
}

// F11 belongs to the browser shell for web pages; allowing Chromium to handle
// it inside the island can fullscreen one renderer while native child views and
// the host capsule keep their window-relative geometry.
app.on('web-contents-created', (_event, contents) => {
  contents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') event.preventDefault()
  })
})

// Startup order: discover artifacts, reconcile preferences, create views, then start services.
app.whenReady().then(async () => {
  // Windows 靠 AppUserModelId 认任务栏图标与分组；不设的话任务栏显示的是 Electron 默认图标。
  app.setAppUserModelId('com.activity-island.host')
  const userRoot = path.join(app.getPath('userData'), 'plugins')
  notificationView = notificationViewDescriptor()
  pluginManager = new PluginManager([userRoot], userRoot, new Set([BUILTIN_NOTIFICATIONS_ID]))
  const discovered = pluginManager.discover()
  storage = new PluginStorage(path.join(app.getPath('userData'), 'plugin-data'))
  pluginLogger = new PluginLogger(path.join(app.getPath('userData'), 'island-plugins', 'logs'))
  pluginWatcher = new PluginWatcher(event => { void pluginsRuntime.reloader.reload(event.id, event.origin) })
  // 工作台：**独立目录**。插件的任何路径都看不到它们，所以"不是插件"是结构性事实，
  // 不需要在 orderedPlugins / mini 条 / presence 里到处加过滤。
  workbenchManager = new WorkbenchManager(
    path.join(app.getPath('userData'), 'workbenches'),
    path.join(resources.root(), 'console-apps', 'workbench'),
  )
  workbenchManager.discover()
  // 后台脚本的 stdout / runtime:* 都是"发给这个插件自己"的，必须也投递到它的页面。
  backgroundManager = new PluginBackgroundManager(
    (id, name, payload) => pluginsRuntime.emit(id, name, payload, { toSelf: true }),
    id => pluginsRuntime.settingsValues(id),
  )
  settingsStore.load()
  // 登录项可能因为换安装路径/重装而失效：设置里开着就重新对齐一次。
  if (islandSettings.launchAtLogin) applyLaunchAtLogin(true)
  pluginsRuntime.reconcile(discovered)
  workbenches.reconcile()
  { const descriptor = workbenches.resolve(); workbenchAccess.apply(descriptor) }
  mainWindow = createHostWindow({
    preloadPath: path.join(__dirname, 'preload', 'host-preload.js'),
    rendererFile: path.join(__dirname, '..', 'dist', 'index.html'),
    island, icon: resources.icon,
    quitting: () => quitRequested,
    closed: () => { mainWindow = null },
    log: (level, message) => pluginLogger?.append('_host', level, message),
  })
  island.attachWindow()
  mainWindow.webContents.on('did-finish-load', island.restoreRenderer)
  mainWindow.setIgnoreMouseEvents(true, { forward: true })
  mainWindow.on('move', island.updateHitTest); mainWindow.on('resize', island.updateHitTest)
  viewManager = new PluginViewManager(mainWindow, {
    onEvent: pluginsRuntime.emit,
    onContextMenu: () => { void island.enterCustomMode() },
  })
  viewManager.setHostIdentity({ contractVersion: CONTRACT_VERSION, hostVersion: app.getVersion(), hostName: 'Activity Island', capabilities: HOST_CAPABILITIES })
  viewManager.setDeviceScaleFactor(screen.getPrimaryDisplay().scaleFactor)
  wireIpc()
  tray = createTray({
    iconPath: resources.asset('tray.png'),
    log: (level, message) => pluginLogger?.append('_host', level, message),
    openSettings: () => { settingsUi.open().show() },
    quit: () => { quitRequested = true; closeAppWindows(); app.quit() },
  })
  transfers.registerIpc()
  transferService = new LocalSendService({
    baseDir: path.join(app.getPath('userData'), 'transfers'),
    saveDirectory: path.join(app.getPath('downloads'), 'Activity Island'),
  })
  transferService.on('change', snapshot => {
    if (transfers.view && !transfers.view.webContents.isDestroyed()) transfers.view.webContents.send('transfers:change', snapshot)
    if (!transfers.isOpen && !transfers.dragging && ['idle', 'compact'].includes(island.islandState.value.mode)) {
      const wasVisible = transfers.progressVisible
      if (!transfers.showProgress() && wasVisible) void island.showRest()
    }
  })
  transferService.on('offer', () => { void transfers.open() })
  void transferService.start()
  // 内置通知能力：Windows 通知接管 + 本地触发接口，随应用启动（视图加载后即可收到事件）。
  const listenerScript = app.isPackaged
    ? path.join(process.resourcesPath ?? '', 'notifications', 'listener.ps1')
    : path.join(resources.root(), 'resources', 'notifications', 'listener.ps1')
  const listenerExe = app.isPackaged
    ? path.join(process.resourcesPath ?? '', 'notifications', 'notify-listener.exe')
    : resources.listenerExe()
  const clearScript = app.isPackaged
    ? path.join(process.resourcesPath ?? '', 'notifications', 'clear.ps1')
    : path.join(resources.root(), 'resources', 'notifications', 'clear.ps1')
  notificationModule = new NotificationModule({
    baseDir: path.join(app.getPath('userData'), 'notifications'),
    listenerScript,
    listenerExe,
    clearScript,
    emit: emitNotificationEvent,
    log: (level, message) => pluginLogger?.append(BUILTIN_NOTIFICATIONS_ID, level, message),
    onStatusChange: () => refreshNotificationTrayHint(),
  })
  void notificationModule.start().then(() => {
    // 用用户保存的设置覆盖默认策略（管道启动后立即生效）。
    return notificationModule?.applySettings(pluginsRuntime.settingsValues(BUILTIN_NOTIFICATIONS_ID))
  })
  // 仅提醒模块不会被 warmPluginViews 预热：这里主动加载一次视图，
  // 让首条通知就能立刻触发提醒，也避免提醒事件发给未加载的视图。
  const notifDescriptor = notificationView
  if (notifDescriptor) void viewManager.ensure(notifDescriptor)
  // 启动时后台检查一次更新：不拦启动、不弹窗，结果留给「关于」页。
  if (islandSettings.checkUpdatesOnLaunch) setTimeout(() => { void checkForUpdates(false) }, 5000)
  hitPoll = setInterval(island.updateHitTest, 20)
  fullscreenMonitor = new ForegroundFullscreenMonitor(mainWindow, windowLayer.fullscreenChanged)
  fullscreenMonitor.start()
  for (const plugin of discovered) if (pluginsRuntime.enabled(plugin.manifest.id)) backgroundManager.start(plugin)
  if (islandSettings.idleMode === 'collapsed') void island.warmPluginViews()
  // 启动时的静止状态同样取决于"空闲表现"：收起模式直接就是顶部触发条。
  await island.showRest()
  // 盯住开发目录/安装目录：改文件就自动同步 + 热重载。
  pluginsRuntime.reloader.watch()
  if (pluginManager?.issues().length) for (const issue of pluginManager.issues()) pluginLogger?.append(issue.id ?? 'unknown', 'warn', `未加载 ${issue.directory}：${issue.reason}`)
  // Warm the console once the island is on screen, so the first right-click
  // reveals an already-loaded page instead of waiting out a cold load.
  void workbenchRuntime.ensure()
})

app.on('before-quit', () => {
  if (!quitRequested) quitRequested = true
  // 停掉监听进程与本地接口，并把历史立即落盘（延迟写入可能在退出时来不及执行）。
  void notificationModule?.stop()
  void transferService?.stop()
  closeAppWindows()
})
app.on('window-all-closed', () => {})
