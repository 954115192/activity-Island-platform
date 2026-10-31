import { SettingsController, type SettingsLayoutChange } from './settings/controller'
import { registerSettingsIpc } from './settings/ipc'
import { SettingsStore } from './settings/store'
import { applyLaunchAtLogin } from './system/startup'
import { createTray } from './system/tray'
import { registerTransferIpc } from './transfers/ipc'
import { exportArtifactPackage } from './plugins/package-export'
import { registerWorkbenchIpc } from './workbench/ipc'
import { clampNumber } from './shared/numbers'
import { registerNotificationIpc } from './notifications/ipc'
import { createUpdateChecker } from './updates/checker'
import { app, BrowserWindow, WebContentsView, dialog, ipcMain, nativeImage, screen, shell, Tray } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { EventBus } from './events/event-bus'
import { IntentArbiter } from './island/intent-arbiter'
import type { AlertLevel } from './island/intent-arbiter'
import { fitMiniBar } from './island/mini-bar'
import { IslandLayoutManager } from './island/layout-manager'
import { IslandState } from './island/island-state'
import { PluginBackgroundManager } from './plugins/plugin-background-manager'
import { PluginLogger } from './plugins/plugin-logger'
import { PluginManager } from './plugins/plugin-manager'
import { orderPlugins, pruneOrder } from './plugins/plugin-order'
import { PluginStorage } from './plugins/plugin-storage'
import { PluginViewManager } from './plugins/plugin-view-manager'
import { PluginWatcher } from './plugins/plugin-watcher'
import { ForegroundFullscreenMonitor } from './window/foreground-fullscreen'
import { BUILTIN_NOTIFICATIONS_ID, NotificationModule } from './notifications/module'
import { LocalSendService } from './transfers/service'
import { extractZip, isZipFile, zipDirectory } from './plugins/zip'
import { allCapabilities, CAPABILITY_LABELS, checkCapability, normalizeCapabilities, WORKBENCH_TRUST_NOTICE, type WorkbenchCapability } from './workbench/capabilities'
import { BUILTIN_WORKBENCH_ID, WorkbenchManager, type WorkbenchDescriptor } from './workbench/workbench-manager'
import type { IslandMode, PluginDescriptor, PluginManifest, PluginMode, PluginTool, PluginToolView } from './plugins/types'

const SMALL_DEFAULT = { width: 134, height: 38 }
const WINDOW_SIZE = { width: 1064, height: 730 }
/** mini 条最多能占多宽（窗口本身就这么宽，留点余量）。 */
const MINI_BAR_MAX_WIDTH = WINDOW_SIZE.width - 24
/** 溢出时 `+N` 徽标的宽度。 */
const OVERFLOW_CHIP_WIDTH = 34
/** 插件契约版本（见 docs/plugin-contract.md）与宿主当前授予的能力集。 */
const CONTRACT_VERSION = 2
const HOST_CAPABILITIES = ['media', 'process']
const MODE_DEFAULTS: Record<PluginMode, { width: number; height: number }> = {
  small: SMALL_DEFAULT,
  medium: { width: 400, height: 160 },
  large: { width: 600, height: 220 },
}

let mainWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null
let workbenchView: WebContentsView | null = null
let workbenchPromise: Promise<WebContentsView | null> | null = null
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
let transferView: WebContentsView | null = null
let transferViewLoading: Promise<void> | null = null
let transferPanelOpen = false
let transferDragging = false
let transferProgressVisible = false
let transferDragTimer: NodeJS.Timeout | null = null
let transferPanelSize = { width: 680, height: 620 }
/** 独立通知历史窗口。 */
let notificationHistoryWindow: BrowserWindow | null = null
/** 正在把开发目录同步到安装目录的时间窗，用来吞掉同步自身触发的 installed 事件。 */
let syncingUntil = 0
let tray: Tray | null = null
let hitPoll: NodeJS.Timeout | null = null
let fullscreenMonitor: ForegroundFullscreenMonitor | null = null
let fullscreenHidden = false
let collapseTimer: NodeJS.Timeout | null = null
let transitionSerial = 0
let hitInside = false
let idleHover = false
let compactHover = false
let openGraceUntil = 0
let quitRequested = false
/** 岛窗口渲染进程崩过的时刻（自动恢复用，1 分钟内超过 3 次就不再重载，避免崩溃循环）。 */
const hostCrashTimes: number[] = []
/** 自己声明"我现在没内容、别占着 mini 条"的插件（island.ui.setPresence(false)）。 */
const hiddenPlugins = new Set<string>()
/**
 * 插件推到控制台「工具」页的实时数据。清单里的 view 只是首帧兜底；
 * 插件用 island.tools.set(toolId, { view }) 覆盖，控制台通过 settings:plugin-tools 收到。
 */
type PluginToolLive = { view?: PluginToolView; notice?: string | null; updatedAt: number }
const pluginToolState = new Map<string, Record<string, PluginToolLive>>()

function mergedPluginTools(pluginId: string): PluginTool[] {
  const plugin = pluginManager?.get(pluginId)
  const tools = plugin?.manifest.tools
  if (!Array.isArray(tools) || !tools.length) return []
  const live = pluginToolState.get(pluginId) ?? {}
  return tools.map(tool => {
    const patch = live[tool.id]
    if (!patch) return tool
    const merged: PluginTool = {
      ...tool,
      ...(patch.view ? { view: patch.view } : {}),
      updatedAt: patch.updatedAt,
    }
    if ('notice' in patch) merged.notice = patch.notice ?? undefined
    return merged
  })
}
function notifyPluginTools(pluginId: string): void {
  const target = settingsWindow
  if (!target || target.isDestroyed()) return
  target.webContents.send('settings:plugin-tools', { pluginId, tools: mergedPluginTools(pluginId) })
}
function clearPluginTools(pluginId: string): void {
  pluginToolState.delete(pluginId)
  notifyPluginTools(pluginId)
}
const TOOL_VIEW_TYPES = new Set(['stats', 'list', 'focus', 'media', 'text'])
function isPluginToolView(value: unknown): value is PluginToolView {
  if (!value || typeof value !== 'object') return false
  const type = (value as { type?: unknown }).type
  return typeof type === 'string' && TOOL_VIEW_TYPES.has(type)
}
/**
 * 收起动画期间的"延后切换"：中岛→mini 时先让收缩中的胶囊把旧内容裁掉，
 * 到位后才把插件切成 small 并显示 mini 内容（见 showCompact）。
 */
let pendingMiniReveal: { ids: Set<string>; target: { layout: AnimatedLayout; placements: PluginPlacement[] }; timer: NodeJS.Timeout | null } | null = null

const settingsStore = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'))
const islandSettings = settingsStore.value

const islandState = new IslandState()
const events = new EventBus()
let islandLayout: IslandLayoutManager | null = null
let hostLayoutState: { mode: IslandMode; pluginMode?: PluginMode; separators: number[]; collapsed?: boolean; clipPlugins?: boolean; showClock?: boolean; quickActions?: boolean; overflow?: number; chipX?: number | null; width: number; height: number; top: number; contentWidth?: number } = { mode: 'idle', separators: [], width: SMALL_DEFAULT.width, height: SMALL_DEFAULT.height, top: 8, contentWidth: SMALL_DEFAULT.width }
type PluginPlacement = { pluginId: string; x: number; width: number; height: number }
type AnimatedLayout = { width: number; height: number; top: number; placements: PluginPlacement[]; clipPlugins: boolean }
let animatedFrame = { width: SMALL_DEFAULT.width, height: SMALL_DEFAULT.height, top: 8, radius: 28 }
let animatedLayout: AnimatedLayout = { width: SMALL_DEFAULT.width, height: SMALL_DEFAULT.height, top: 8, placements: [], clipPlugins: false }
// Scale and island-top the compact placements above were built with. Native
// plugin views cache their bounds and zoom factor, so a change to either one
// needs a real re-layout - resizing the shell alone leaves the plugins stale.
let compactScale = Number.NaN
let compactTop = Number.NaN
let warmedPluginIds: string[] = []
// Window-absolute target rect of the console (workbench) while it is open. The
// view manager keeps the console clipped to the animated island, so it grows out
// of the island like a plugin page does.
let workbenchStage: { x: number; y: number; width: number; height: number } | null = null
// 宿主是否已经给控制台排过一次版。页面在此之前量到的尺寸是垃圾值（视图还没有尺寸），
// 所以 workbench:resize 在它为 false 时直接拒绝 —— 详见那个 handler 的注释。
// 判据不是"当前可见"：工作台可能刚好被命中检测收回去，但它仍保持上次的 bounds。
let workbenchLaidOutOnce = false
// 提醒（alert）正在整条显示中：这段时间里 hover 只改外壳，收起由 ttl 决定。
let alertActive = false
// 当前提醒档位与自定义颜色，岛壳渲染进程重载（含崩溃自愈）后要重发一次，否则光晕会丢。
let currentAlertLevel: AlertLevel | null = null
let currentAlertColor: string | null = null
// 点提醒展开成中岛/大岛时，光圈跟随过去（不随 endAlert 撤掉）；离开展开态才清。
let alertCarry = false
let alertCarryOwner: string | null = null

const arbiter = new IntentArbiter({
  showAlert: alert => { void showAlertBar(alert) },
  endAlert: () => {
    alertActive = false
    // 点提醒展开的中岛/大岛要继承光圈（alertCarry）——此时不撤，等离开展开态再撤。
    if (!alertCarry) sendAlert(null)
    void showRest(hitInside)
  },
  canAlert: () => islandState.value.mode === 'idle' || islandState.value.mode === 'compact',
  grantFocus: request => grantFocus(request),
  releaseFocus: () => { clearAlertCarry(); void showRest(hitInside) },
  sendIntent: (pluginId, message) => viewManager?.sendIntent(pluginId, message),
})
let hitRegion = { x: 0, y: 0, width: SMALL_DEFAULT.width, height: SMALL_DEFAULT.height, radius: 23, interactive: true }

function appRoot(): string { return app.isPackaged ? app.getAppPath() : process.cwd() }
/** Run a cached copy in development so publishing a new listener never replaces a running executable. */
function developmentListenerExe(): string {
  const built = path.join(appRoot(), 'build', 'notify-listener', 'notify-listener.exe')
  const fallback = path.join(appRoot(), 'resources', 'notifications', 'notify-listener.exe')
  if (!fs.existsSync(built)) return fallback
  try {
    const bytes = fs.readFileSync(built)
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 20)
    const cacheDir = path.join(app.getPath('temp'), 'activity-island-listeners')
    fs.mkdirSync(cacheDir, { recursive: true })
    const cached = path.join(cacheDir, `notify-listener-${hash}.exe`)
    if (!fs.existsSync(cached)) fs.writeFileSync(cached, bytes, { flag: 'wx' })
    return cached
  } catch (error) {
    pluginLogger?.append('_host', 'warn', `无法缓存开发版通知监听器：${String(error)}`)
    return built
  }
}
/**
 * 资源文件（assets/ 由 `npm run icons` 生成）。
 *
 * 打包之后 assets/ 是**放在 asar 外面**的（见 electron-builder.yml 的 extraResources）：
 * `nativeImage.createFromPath` 与 `Tray` 对 asar 内路径的支持不稳定，而图标是托盘和任务栏的
 * 关键，一旦读不到就会回落成 Electron 默认图标（用户看到的就是"任务栏图标又没了"）。
 * 所以这里优先用真实路径 `process.resourcesPath`，源码运行时才回落成仓库里的 assets/。
 */
function assetFile(name: string): string {
  const candidates = [
    path.join(process.resourcesPath ?? '', 'assets', name),
    path.join(appRoot(), 'assets', name),
  ]
  for (const candidate of candidates) {
    try { if (candidate && fs.existsSync(candidate)) return candidate } catch { /* 忽略 */ }
  }
  return candidates[1]
}
function appIcon(): Electron.NativeImage | undefined {
  try {
    const file = assetFile('icon.ico')
    const image = nativeImage.createFromPath(file)
    if (image.isEmpty()) {
      // 打包后图标读不到是"任务栏/托盘没图标"最常见的原因（assets 没跟着进安装包），
      // 必须自己说出来，否则用户只能看到"图标又没了"。
      pluginLogger?.append('_host', 'warn', `应用图标读取失败（空图）：${file}`)
      return undefined
    }
    return image
  } catch (error) {
    pluginLogger?.append('_host', 'warn', `应用图标读取异常：${String((error as Error)?.message ?? error)}`)
    return undefined
  }
}
function plugins(): PluginDescriptor[] { return pluginManager?.list() ?? [] }
function pluginIssues() { return pluginManager?.issues() ?? [] }
// 通知是宿主功能；只复用视图排版与动画，不参加插件发现和管理。
function notificationViewDescriptor(): PluginDescriptor {
  const rootDir = path.join(appRoot(), 'modules', BUILTIN_NOTIFICATIONS_ID)
  const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'module.json'), 'utf8')) as PluginManifest
  return { manifest, rootDir, entryPath: path.join(rootDir, 'index.html') }
}
let notificationView: PluginDescriptor | null = null
function runtimeView(id: string): PluginDescriptor | undefined {
  return id === BUILTIN_NOTIFICATIONS_ID ? notificationView ?? undefined : pluginManager?.get(id)
}
function runtimeViews(): PluginDescriptor[] { return notificationView ? [...plugins(), notificationView] : plugins() }
function pluginEnabled(id: string): boolean { return !islandSettings.disabledPlugins.includes(id) }
/**
 * 用户选的"上岛方式"：resident = 常驻 mini 条；alert = 仅提醒。
 * 没存过就按清单 resident 默认；small 被作者关掉的插件不能常驻。
 */
function pluginModeOf(plugin: PluginDescriptor): 'resident' | 'alert' {
  if (plugin.manifest.small?.enabled === false) return 'alert'
  const stored = islandSettings.pluginModes[plugin.manifest.id]
  if (stored === 'resident' || stored === 'alert') return stored
  return plugin.manifest.resident === true ? 'resident' : 'alert'
}
function pluginSupportsResident(plugin: PluginDescriptor): boolean { return plugin.manifest.small?.enabled !== false }
function pluginResident(plugin: PluginDescriptor): boolean { return pluginModeOf(plugin) === 'resident' }
function pluginPublicMode(id: string): 'off' | 'resident' | 'alert' {
  if (!pluginEnabled(id)) return 'off'
  const plugin = pluginManager?.get(id)
  return plugin ? pluginModeOf(plugin) : 'alert'
}
/** 控制台插件页需要的完整状态：清单 + 用户选择 + 实时工具数据。 */
function pluginListPayload() {
  return plugins().map(item => ({
    ...item.manifest,
    enabled: pluginEnabled(item.manifest.id),
    mode: pluginPublicMode(item.manifest.id),
    resident: pluginResident(item),
    supportsResident: pluginSupportsResident(item),
    sourceDir: pluginManager?.sourceOf(item.manifest.id) ?? null,
    tools: mergedPluginTools(item.manifest.id),
  }))
}
function enabledPlugins(): PluginDescriptor[] { return plugins().filter(plugin => pluginEnabled(plugin.manifest.id)) }

/** 把插件目录挂到监听上：开发目录改动会自动同步 + 热重载。 */
function startWatching(): void {
  if (!pluginManager || !pluginWatcher) return
  syncSettingsSchemas()
  pluginWatcher.watch(pluginManager.list()
    .map(plugin => ({
      id: plugin.manifest.id,
      installedDir: plugin.rootDir,
      sourceDir: pluginManager?.sourceOf(plugin.manifest.id),
    })))
}

/** 热重载风暴保护：插件自己往插件目录写文件时，会形成"文件变 → 重载 → 文件又变"的无限循环。 */
const reloadTimes = new Map<string, number[]>()
const RELOAD_STORM_WINDOW_MS = 20000
const RELOAD_STORM_LIMIT = 8

function allowReload(id: string): boolean {
  const now = Date.now()
  const times = (reloadTimes.get(id) ?? []).filter(time => now - time < RELOAD_STORM_WINDOW_MS)
  times.push(now)
  reloadTimes.set(id, times)
  if (times.length <= RELOAD_STORM_LIMIT) return true
  reloadTimes.set(id, [now])
  pluginLogger?.append(id, 'error', `20 秒内触发 ${times.length} 次热重载，已暂停自动重载：插件可能在改写自己目录里的文件（运行时数据请写到 %TEMP%）`)
  return false
}

/** 热重载：必要时先从开发目录同步，然后重建视图、后台进程与布局。 */
async function reloadPlugin(id: string, origin: 'source' | 'installed'): Promise<void> {
  if (!pluginManager || !viewManager) return
  if (origin === 'installed' && Date.now() < syncingUntil) return
  if (!allowReload(id)) return
  if (origin === 'source') {
    syncingUntil = Date.now() + 2000
    if (!pluginManager.syncFromSource(id)) {
      pluginLogger?.append(id, 'error', '热重载失败：开发目录里找不到 plugin.json')
      return
    }
  }
  backgroundManager?.stop(id)
  hiddenPlugins.delete(id)
  clearPluginTools(id)
  viewManager.destroy(id)
  // 面板承载的是旧清单的设置页，热重载后直接关掉，用户重开即是新页面。
  if (pluginPanel?.pluginId === id) closePluginPanel()
  // 视图被销毁了，紧凑布局的缓存必须作废，否则会走"只改外壳"的快速分支，
  // 插件视图再也不会被创建。
  compactScale = Number.NaN
  compactTop = Number.NaN
  const list = pluginManager.discover()
  const next = list.find(item => item.manifest.id === id)
  if (!next) {
    pluginLogger?.append(id, 'error', '热重载失败：插件不再可加载（去控制台看未加载原因）')
  } else {
    if (pluginEnabled(id)) backgroundManager?.start(next)
    // 立刻重新加载页面（隐藏状态也加载），作者保存后就能在日志里看到结果。
    await viewManager.ensure(next)
    pluginLogger?.append(id, 'info', `热重载完成（${origin === 'source' ? '开发目录' : '安装目录'}改动）`)
  }
  startWatching()
  await showRest(hitInside)
  sendHost('host:plugins-changed', list.map(item => item.manifest))
}

// ---------------------------------------------------------------- 插件参数（设置项）
const SETTINGS_KEY = '__settings'

function pluginSettingsFields(pluginId: string): Array<Record<string, unknown>> {
  const settings = runtimeView(pluginId)?.manifest.settings
  const fields = typeof settings === 'object' && settings !== null ? settings.fields : null
  return Array.isArray(fields) ? (fields as unknown as Array<Record<string, unknown>>) : []
}

function pluginSettingsValues(pluginId: string): Record<string, unknown> {
  const stored = (storage?.get(pluginId, SETTINGS_KEY) as Record<string, unknown> | undefined) ?? {}
  const values: Record<string, unknown> = {}
  for (const field of pluginSettingsFields(pluginId)) {
    const key = String(field.key ?? '')
    if (key && field.default !== undefined) values[key] = field.default
  }
  return { ...values, ...stored }
}

function storeSettings(pluginId: string, patch: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set(pluginSettingsFields(pluginId).map(field => String(field.key ?? '')))
  const clean: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) if (allowed.has(key)) clean[key] = value
  const next = { ...pluginSettingsValues(pluginId), ...clean }
  storage?.set(pluginId, SETTINGS_KEY, next)
  return next
}

function saveNotificationSettings(patch: Record<string, unknown>): Record<string, unknown> {
  // 沿用原存储位置以保留升级前的通知配置。
  const next = storeSettings(BUILTIN_NOTIFICATIONS_ID, patch)
  void notificationModule?.applySettings(next)
  viewManager?.sendToPlugin(BUILTIN_NOTIFICATIONS_ID, 'host:settings', { values: next, schema: notificationView?.manifest.settings ?? null })
  return next
}

function savePluginSettings(pluginId: string, patch: Record<string, unknown>): Record<string, unknown> {
  const next = storeSettings(pluginId, patch)
  // 后台脚本在启动时读一次参数（端口监听甚至要在启动时绑定端口），保存后重启它让新值生效。
  const descriptor = pluginManager?.get(pluginId)
  if (descriptor?.manifest.background?.entry && pluginEnabled(pluginId)) {
    backgroundManager?.stop(pluginId)
    backgroundManager?.start(descriptor)
  }
  // 插件侧立即收到；控制台窗口也刷新。
  viewManager?.sendToPlugin(pluginId, 'host:settings', { values: next, schema: runtimeView(pluginId)?.manifest.settings ?? null })
  if (pluginPanel && pluginPanel.pluginId === pluginId && !pluginPanel.view.webContents.isDestroyed()) {
    pluginPanel.view.webContents.send('host:settings', { values: next })
  }
  return next
}

/** 插件设置项 schema 同步给视图管理器，hello 里会带给插件。 */
function syncSettingsSchemas(): void {
  const schemas: Record<string, unknown> = {}
  for (const plugin of plugins()) if (plugin.manifest.settings) schemas[plugin.manifest.id] = plugin.manifest.settings
  if (notificationView?.manifest.settings) schemas[BUILTIN_NOTIFICATIONS_ID] = notificationView.manifest.settings
  viewManager?.setSettingsSchemas(schemas)
}

/** mini 条里的插件顺序：用户拖拽顺序 > priority > 名字。 */
function orderedPlugins(): PluginDescriptor[] {
  // hiddenPlugins：插件自己说"我现在没内容"（island.ui.setPresence(false)），就不占 mini 条。
  // 仅提醒的插件也不占 —— 它们只通过 alert/focus 出现。
  const visible = enabledPlugins().filter(plugin => pluginResident(plugin) && !hiddenPlugins.has(plugin.manifest.id))
  return orderPlugins(visible, islandSettings.pluginOrder)
}
function pluginSize(plugin: PluginDescriptor, mode: PluginMode): { width: number; height: number } {
  const configured = plugin.manifest[mode]
  const defaults = MODE_DEFAULTS[mode]
  const range = mode === 'medium'
    ? { minWidth: 260, minHeight: 110, maxWidth: 800, maxHeight: 400 }
    : mode === 'large'
      ? { minWidth: 400, minHeight: 160, maxWidth: 1000, maxHeight: 680 }
      : { minWidth: 64, minHeight: 28, maxWidth: 1000, maxHeight: 120 }
  const numberOr = (value: unknown, fallback: number): number => Number.isFinite(Number(value)) ? Number(value) : fallback
  const width = numberOr(configured?.preferredWidth ?? configured?.width, defaults.width)
  const height = numberOr(configured?.preferredHeight ?? configured?.height, defaults.height)
  const minWidth = Math.max(range.minWidth, numberOr(configured?.minWidth, range.minWidth))
  const minHeight = Math.max(range.minHeight, numberOr(configured?.minHeight, range.minHeight))
  const maxWidth = Math.min(range.maxWidth, Math.max(minWidth, numberOr(configured?.maxWidth, range.maxWidth)))
  const maxHeight = Math.min(range.maxHeight, Math.max(minHeight, numberOr(configured?.maxHeight, range.maxHeight)))
  return {
    width: Math.max(minWidth, Math.min(maxWidth, Math.round(width))),
    height: Math.max(minHeight, Math.min(maxHeight, Math.round(height))),
  }
}
function sendHost(channel: string, payload?: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}
function pluginGeometry(layout: AnimatedLayout, placement: PluginPlacement) {
  const targetLeft = (WINDOW_SIZE.width - layout.width) / 2
  return {
    x: Math.round(targetLeft + placement.x),
    y: Math.round(layout.top + (layout.height - placement.height) / 2),
    width: placement.width,
    height: placement.height,
  }
}

/** Compact (small) island layout for one scale: plugin placements plus the content size the shell grows around. */
function compactLayout(visible: PluginDescriptor[], scale: number, options: { solo?: boolean; soloWidth?: number; maxWidth?: number } = {}): { placements: PluginPlacement[]; separators: number[]; baseWidth: number; height: number; overflow: number; chipX: number | null } {
  const padding = Math.round(8 * scale)
  const measured = visible.map(plugin => {
    const size = pluginSize(plugin, 'small')
    return { pluginId: plugin.manifest.id, width: Math.round(size.width * scale), height: Math.round(size.height * scale) }
  })
  const minWidth = Math.round(SMALL_DEFAULT.width * scale)
  // 提醒态：只显示一条，居中，不给分隔线也不溢出。
  if (options.solo && measured.length > 0) {
    const only = measured[0]
    // 提醒可申请更宽（island.alert 的 width，逻辑 px）：按 miniScale 缩放，
    // 不小于清单声明的 small 宽（推荐尺寸下限），不超过 mini 条最大宽。
    // 注意申请的宽度直接作用于插件视图本身（页面是 100% 布局，能自适应更宽的画布）。
    const requested = options.soloWidth !== undefined ? Math.round(options.soloWidth * scale) : only.width
    const contentWidth = Math.max(only.width, Math.min(requested, MINI_BAR_MAX_WIDTH - padding * 2))
    const baseWidth = Math.max(minWidth, contentWidth + padding * 2)
    return {
      // 通知计数区贴到提醒胶囊右边缘，使其圆弧与外壳同心。
      placements: [{ pluginId: only.pluginId, x: Math.round((baseWidth - contentWidth) / 2), width: contentWidth + (only.pluginId === BUILTIN_NOTIFICATIONS_ID ? padding : 0), height: only.height }],
      separators: [], baseWidth, height: only.height, overflow: 0, chipX: null,
    }
  }
  const fit = fitMiniBar(measured.map(({ pluginId, width }) => ({ pluginId, width })), padding, minWidth, options.maxWidth ?? MINI_BAR_MAX_WIDTH, Math.round(OVERFLOW_CHIP_WIDTH * scale))
  const kept = new Set(fit.kept.map(segment => segment.pluginId))
  const placements: PluginPlacement[] = []
  const separators: number[] = []
  let x = padding
  let height = Math.round(SMALL_DEFAULT.height * scale)
  for (const segment of measured) {
    if (!kept.has(segment.pluginId)) continue
    placements.push({ pluginId: segment.pluginId, x, width: segment.width, height: segment.height })
    x += segment.width
    height = Math.max(height, segment.height)
    if (placements.length < fit.kept.length) separators.push(x)
  }
  return {
    placements, separators, height,
    baseWidth: Math.max(minWidth, fit.contentWidth + padding * 2),
    overflow: fit.dropped,
    chipX: fit.dropped > 0 ? x + Math.round(6 * scale) : null,
  }
}

/** Reserve a small host-owned trailing slot while the user hovers the island. */
function compactLayoutWithQuickActions(visible: PluginDescriptor[], scale: number, enabled: boolean) {
  if (!enabled) return { layout: compactLayout(visible, scale), quickActions: false }
  const slot = Math.round(44 * scale)
  const layout = compactLayout(visible, scale)
  if (layout.baseWidth + slot > MINI_BAR_MAX_WIDTH) return { layout, quickActions: false }
  const shift = Math.round(slot / 2)
  return {
    layout: {
      ...layout,
      placements: layout.placements.map(placement => ({ ...placement, x: placement.x + shift })),
      separators: layout.separators.map(position => position + shift),
      baseWidth: layout.baseWidth + slot,
      chipX: layout.chipX == null ? null : layout.chipX + shift,
    },
    quickActions: true,
  }
}

function syncPluginViews(frame = animatedFrame): void {
  if (!viewManager) return
  // idle（含收起触发条）：插件视图一个都不藏。setVisible(false) 会让 Chromium
  // 停掉该页的出帧，下次展开的第一帧要等合成器从休眠里恢复——弹簧都走完了内容
  // 才蹦出来。改成把裁剪窗口收到 1x1、视图全部保持可见：页面持续活着，展开退化
  // 成纯裁剪动画，内容跟着胶囊一起长出来。裁到 1x1 而不是 idle 胶囊尺寸，是
  // 因为浮动待机胶囊（134x38）和小岛段几何是重叠的，按胶囊裁会漏出内容。
  const idle = hostLayoutState.mode === 'idle'
  const clipFrame = idle ? { width: 1, height: 1, top: hostLayoutState.top, radius: 0 } : frame
  if (idle) animatedFrame = clipFrame
  const shell = {
    x: Math.round((WINDOW_SIZE.width - clipFrame.width) / 2),
    y: Math.round(clipFrame.top),
    width: Math.max(1, Math.round(clipFrame.width)),
    height: Math.max(1, Math.round(clipFrame.height)),
  }
  // The native parent View is the only clipping/animated surface. Plugin
  // WebContentsView widths and heights stay at their target dimensions.
  viewManager.setViewport(shell, clipFrame.radius)
  // The console grows out of the same shell instead of popping in at full size.
  viewManager.setWorkbenchStage(workbenchStage)
  const activeIds = new Set(animatedLayout.placements.map(item => item.pluginId))
  for (const plugin of runtimeViews()) {
    const placement = animatedLayout.placements.find(item => item.pluginId === plugin.manifest.id)
    // 收起动画期间：这些插件的视图保持原样（中岛尺寸/内容），让收缩中的胶囊裁掉它们，
    // 等动画到位后再由 applyPendingMiniReveal 切成 mini —— 别在这里提前动它们。
    if (pendingMiniReveal?.ids.has(plugin.manifest.id)) continue
    if (!placement) {
      // idle 下没有 placement 的插件也保持可见（1x1 裁剪负责藏住它们）；
      // 非 idle 模式才真正隐藏（中岛只留激活插件、工作台盖住全部）。
      if (!idle) viewManager.hide(plugin.manifest.id)
      continue
    }
    viewManager.setBounds(plugin.manifest.id, pluginGeometry(animatedLayout, placement))
    viewManager.show(plugin.manifest.id)
  }
  for (const id of viewManager.list()) if (!activeIds.has(id) && !pendingMiniReveal?.ids.has(id) && !idle) viewManager.hide(id)
  // 契约状态跟着布局一起下发：可见性、真实尺寸/缩放、主题（都按插件去重）。
  viewManager.publishContract({
    islandMode: hostLayoutState.mode,
    activePluginId: islandState.value.activePluginId,
    scale: islandSettings.miniScale,
  })
}
function sendLayout(mode: IslandMode, pluginMode?: PluginMode, separators: number[] = [], collapsed = false, size = { width: SMALL_DEFAULT.width, height: SMALL_DEFAULT.height }, top = islandSettings.islandTop, placements: PluginPlacement[] = [], contentSize: { width: number; height: number; top?: number } = size, clipPlugins = mode === 'expanded' || mode === 'detail', showClock = false, syncPlugins = true, bar: { overflow?: number; chipX?: number | null; quickActions?: boolean } = {}): void {
  if (transferProgressVisible && (mode !== 'compact' || placements.length > 0)) {
    transferProgressVisible = false
    sendHost('transfers:progress', null)
  }
  const quickActions = bar.quickActions ?? (!transferProgressVisible && !transferDragging && !alertActive && ((mode === 'idle' && idleHover) || (mode === 'compact' && compactHover)))
  hostLayoutState = { mode, pluginMode, separators, collapsed, clipPlugins, showClock, quickActions, width: size.width, height: size.height, top, contentWidth: contentSize.width, overflow: bar.overflow ?? 0, chipX: bar.chipX ?? null }
  animatedLayout = { width: contentSize.width, height: contentSize.height, top: contentSize.top ?? top, placements, clipPlugins }
  if (syncPlugins) syncPluginViews()
  sendHost('host:layout', hostLayoutState)
}
function layoutManager(): IslandLayoutManager | null { return mainWindow ? islandLayout : null }
async function animateWindow(_bounds: { x: number; y: number; width: number; height: number }, _duration = 380): Promise<void> {
  // The host window stays fixed like the old project. Only the inner island
  // capsule animates, so plugin renderers never move with the spring.
}
function centerBounds(_width: number, _height: number, _top = islandSettings.islandTop) { return layoutManager()?.center(WINDOW_SIZE.width, WINDOW_SIZE.height, 0) }
function stageOrigin(width: number, height: number, top = islandSettings.islandTop) { return { x: Math.round((WINDOW_SIZE.width - width) / 2), y: Math.round(top), width, height } }
function updatePluginAnimationFrame(frame: { width: number; height: number; top: number; radius: number }): void {
  animatedFrame = { width: Math.max(1, frame.width), height: Math.max(1, frame.height), top: frame.top, radius: Math.max(0, frame.radius) }
  syncPluginViews(animatedFrame)
  // hostLayoutState 里存的就是这次过渡的目标外壳尺寸，跟它比最准。
  const settled = Math.abs(animatedFrame.width - hostLayoutState.width) <= 2 && Math.abs(animatedFrame.height - hostLayoutState.height) <= 2
  // 收起进度到点（或弹簧到位）：先撤工作台内容（它叠在插件之上），剩下的交给空胶囊；
  // 再切插件 mini 内容（早切就是"内容先缩进岛里"）。
  if (pendingWorkbenchHide && (animatedFrame.width <= pendingWorkbenchHide.belowWidth || settled)) hideWorkbench()
  if (pendingMiniReveal) {
    if (settled) applyPendingMiniReveal('frame')
  }
}
function saveIslandSettings(): void { settingsStore.save() }
function publicIslandSettings() { return settingsStore.snapshot() }

// ---------------------------------------------------------------- 更新检查
// 只读 GitHub Releases 的 latest，不自动下载安装；有新版时由「关于」页给出跳转。
const updateChecker = createUpdateChecker((level, message) => pluginLogger?.append('_host', level, message))
const checkForUpdates = updateChecker.checkForUpdates

const settingsController = new SettingsController(settingsStore, {
  pluginIds: () => plugins().map(plugin => plugin.manifest.id),
  launchAtLogin: applyLaunchAtLogin,
  changed: () => sendSettingsChanged(),
  applyLayout: applySettingsLayout,
})

async function applySettingsLayout(change: SettingsLayoutChange): Promise<void> {
  const state = islandState.value
  if (change === 'idle-mode') {
    if (state.mode === 'idle' || state.mode === 'compact') await showRest()
  } else if (change === 'top') {
    if (state.mode === 'idle') await showIdle(idleHover)
    else if (state.mode === 'compact') await showRest(hitInside)
    else if ((state.mode === 'expanded' || state.mode === 'detail') && state.activePluginId) {
      const plugin = runtimeView(state.activePluginId)
      if (plugin) await showActive(plugin, state.mode)
    } else if (state.mode === 'custom') await enterCustomMode()
  } else if (change === 'scale') {
    if (state.mode === 'compact') await showRest(hitInside)
    else if (state.mode === 'idle') await showIdle(idleHover)
  } else if (state.mode === 'compact' && !alertActive) await showRest(hitInside)
}

function sendSettingsChanged(): void {
  sendHost('settings:changed', publicIslandSettings())
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('settings:changed', publicIslandSettings())
}
async function setPluginMode(pluginId: string, mode: 'resident' | 'alert' | 'off'): Promise<{ ok: boolean; enabled?: boolean; mode?: 'resident' | 'alert' | 'off'; error?: string }> {
  const plugin = pluginManager?.get(pluginId)
  if (!plugin) return { ok: false, error: '插件未加载' }
  if (mode === 'resident' && !pluginSupportsResident(plugin)) return { ok: false, error: '这个插件没有提供小岛视图，只能仅提醒' }

  if (mode === 'off') {
    if (!islandSettings.disabledPlugins.includes(pluginId)) islandSettings.disabledPlugins.push(pluginId)
    backgroundManager?.stop(pluginId)
    hiddenPlugins.delete(pluginId)
    viewManager?.destroy(pluginId)
    if (islandState.value.activePluginId === pluginId) arbiter.interrupt()
  } else {
    islandSettings.disabledPlugins = islandSettings.disabledPlugins.filter(id => id !== pluginId)
    islandSettings.pluginModes[pluginId] = mode
    backgroundManager?.start(plugin)
    // 常驻 → 仅提醒：如果它正展开着，先把展开态收掉，回到 mini 条/静止。
    if (mode === 'alert' && islandState.value.activePluginId === pluginId
      && (islandState.value.mode === 'expanded' || islandState.value.mode === 'detail')) {
      clearAlertCarry()
      arbiter.interrupt()
    }
  }

  saveIslandSettings()
  startWatching()
  await showRest(hitInside)
  sendSettingsChanged()
  sendHost('host:plugins-changed', plugins().map(item => ({ ...item.manifest, enabled: pluginEnabled(item.manifest.id), mode: pluginPublicMode(item.manifest.id) })))
  return { ok: true, enabled: pluginEnabled(pluginId), mode: pluginPublicMode(pluginId) }
}

/** 兼容旧调用：true 按插件默认/上次选择恢复，false = 关闭。 */
async function setPluginEnabled(pluginId: string, enabled: boolean): Promise<{ ok: boolean; enabled?: boolean; error?: string }> {
  const plugin = pluginManager?.get(pluginId)
  if (!plugin) return { ok: false, error: '插件未加载' }
  if (!enabled) {
    const result = await setPluginMode(pluginId, 'off')
    return { ok: result.ok, enabled: false, error: result.error }
  }
  const stored = islandSettings.pluginModes[pluginId]
  let mode = stored === 'resident' || stored === 'alert'
    ? stored
    : (plugin.manifest.resident === true ? 'resident' : 'alert')
  if (mode === 'resident' && !pluginSupportsResident(plugin)) mode = 'alert'
  const result = await setPluginMode(pluginId, mode)
  return { ok: result.ok, enabled: result.ok, error: result.error }
}

function createHostWindow(): BrowserWindow {
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
    icon: appIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload', 'host-preload.js'),
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
  else void win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  win.webContents.on('context-menu', event => {
    event.preventDefault()
    enterCustomMode()
  })
  win.on('blur', () => {
    // Blur is authoritative: the cursor can no longer keep the island in its
    // hover-sized compact layout. releaseFocus() already invokes showRest(),
    // so do not start a second competing showCompact() transition here.
    hitInside = false
    islandState.patch({ pointerInside: false })
    sendHost('host:blur')
    const state = islandState.value
    if ((state.mode === 'expanded' || state.mode === 'detail') && state.sticky) {
      islandState.patch({ sticky: false })
      arbiter.releaseFocus('preempted')
    }
  })
  // 灵动岛的画面就是这个渲染进程画的：它一崩，窗口还在、进程还在，但整个岛看起来"死了"，
  // 只能重启应用。这里自动重载并重新同步布局，用户无感恢复；同时把原因记下来方便排查。
  win.webContents.on('render-process-gone', (_event, details) => {
    const reason = `${details?.reason ?? 'unknown'} (exit ${details?.exitCode ?? '?'})`
    console.error('[host] island renderer gone', reason)
    // 打包后没有控制台，这种"整块看起来死掉"的原因必须落到日志里，否则用户只能说"它就是死了"。
    pluginLogger?.append('_host', 'error', `灵动岛渲染进程崩溃：${reason}`)
    if (quitRequested || win.isDestroyed()) return
    const now = Date.now()
    hostCrashTimes.push(now)
    while (hostCrashTimes.length && now - hostCrashTimes[0] > 60000) hostCrashTimes.shift()
    if (hostCrashTimes.length > 3) {
      pluginLogger?.append('_host', 'error', '灵动岛渲染进程 1 分钟内崩溃超过 3 次，已停止自动恢复（请重启应用并把这份日志发出来）')
      return
    }
    pluginLogger?.append('_host', 'info', '正在自动重载灵动岛（不用重启应用）')
    void win.reload()
  })
  win.on('closed', () => { mainWindow = null; islandLayout = null })
  return win
}

/**
 * 把工作台入口加载进视图。
 *
 * 两个实测坑都在这里处理：
 *  1. **被打断不算失败**：连续切换活动工作台、或刚卸载掉"正在显示的那个"（目录已被删）时，
 *     `loadFile` 会在十几毫秒内直接抛 `ERR_FAILED`。那是导航被取代，不是工作台坏了 ——
 *     所以先取消在途导航，失败时**重试一次**。
 *  2. 重试后仍失败、且**当前仍指向这个工作台** → 那才是真坏了，必须写进 _host.log，
 *     否则用户只看到一片空白，不知道为什么。
 */
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
      pluginLogger?.append('_host', 'error', `工作台「${descriptor.manifest.name}」（${target}）加载失败：${message}`)
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
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve(null)
  const descriptor = resolveActiveWorkbench()
  if (workbenchView) {
    if (loadedWorkbenchId === descriptor.manifest.id) return Promise.resolve(workbenchView)
    const view = workbenchView
    loadedWorkbenchId = descriptor.manifest.id
    applyWorkbenchGrant(descriptor)
    pluginLogger?.append('_host', 'info', `切换工作台 →「${descriptor.manifest.name}」（${descriptor.manifest.id}）`)
    workbenchPromise = loadWorkbenchEntry(view, descriptor)
    return workbenchPromise
  }
  if (workbenchPromise && loadedWorkbenchId === descriptor.manifest.id) return workbenchPromise
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload', 'workbench-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  view.setBackgroundColor('#00000000')
  view.setVisible(false)
  // Hand the console to the view manager so it lives under the same animated
  // clip as the plugin pages instead of floating at full size over the island.
  viewManager?.adoptWorkbench(view)
  workbenchView = view
  view.webContents.on('context-menu', event => event.preventDefault())
  view.webContents.on('render-process-gone', () => {
    workbenchView = null
    workbenchPromise = null
    loadedWorkbenchId = null
    viewManager?.adoptWorkbench(null)
  })
  loadedWorkbenchId = descriptor.manifest.id
  applyWorkbenchGrant(descriptor)
  pluginLogger?.append('_host', 'info', `加载工作台「${descriptor.manifest.name}」（${descriptor.manifest.id}）`)
  // Keep hold of the load promise: the console is warmed at startup, and a
  // right-click landing while that load is still running must await the same
  // view instead of creating a second one.
  workbenchPromise = loadWorkbenchEntry(view, descriptor)
  return workbenchPromise
}

/** Close the console. The next layout sync hides it; this also does it now. */
function hideWorkbench(): void {
  cancelDeferredWorkbenchHide()
  viewManager?.endWorkbenchCollapse()
  workbenchStage = null
  viewManager?.setWorkbenchStage(null)
}

/**
 * 从工作台收回 mini 时的"延迟收尾"：立刻 `setVisible(false)` 会让控制台内容
 * 在收缩动画的第一帧就整个消失，只剩空壳在缩。正确做法和插件的
 * pendingMiniReveal 对称 —— 保留视图，让收缩中的原生裁剪窗把它逐帧裁掉。
 * 但内容**不跟全程**：宽度收到 WORKBENCH_HIDE_PROGRESS 进度时就提前撤掉
 * （弹簧收尾段最慢，内容缩到很小时还在磨蹭，反而生硬），剩下的完全交给
 * 空胶囊的岛动画；900ms 超时兜底。工作台视图叠在插件之上，所以
 * hideWorkbench 必须先于 applyPendingMiniReveal 执行（见 updatePluginAnimationFrame）。
 */
let pendingWorkbenchHide: { timer: NodeJS.Timeout; belowWidth: number } | null = null
/** 收起宽度进度的隐藏点：0 = 一收就藏，1 = 收到最小才藏。 */
const WORKBENCH_HIDE_PROGRESS = 0.7
function deferWorkbenchHide(): void {
  cancelDeferredWorkbenchHide()
  const timer = setTimeout(() => { pendingWorkbenchHide = null; hideWorkbench() }, 900)
  pendingWorkbenchHide = { timer, belowWidth: Number.POSITIVE_INFINITY }
}
/** 收起目标布局发出后调用：按起始/目标宽度算出提前撤内容的宽度阈值。 */
function armWorkbenchHideThreshold(): void {
  if (!pendingWorkbenchHide || !workbenchStage) return
  pendingWorkbenchHide.belowWidth = workbenchStage.width + (hostLayoutState.width - workbenchStage.width) * WORKBENCH_HIDE_PROGRESS
}
function cancelDeferredWorkbenchHide(): void {
  if (pendingWorkbenchHide) { clearTimeout(pendingWorkbenchHide.timer); pendingWorkbenchHide = null }
}

/** True while the island console is actually on screen. */
function consoleVisible(): boolean {
  // workbenchStage is set by enterCustomMode and cleared by hideWorkbench,
  // which every transition that leaves custom mode goes through.
  return workbenchStage !== null
}

/**
 * 工作台尺寸。
 *
 * 默认 1040 × 700；工作台可以通过 `workbench.resize()` 请求别的尺寸，宿主**钳制**后应用。
 * 以前页面是调 `window.resizeTo` 想按内容自适应 —— 在 Electron 里那是空操作，
 * 所以"高度自适应"从来没生效过。现在尺寸由宿主统一管，并会把**真正生效的值**回给页面。
 */
const WORKBENCH_SIZE_DEFAULT = { width: 1040, height: 700 }
const WORKBENCH_SIZE_RANGE = { minWidth: 720, maxWidth: 1280, minHeight: 480, maxHeight: 860 }
/** 小于这个像素差就当"自适应回环"丢掉（见 workbench:resize 的注释）。 */
let workbenchSizeRequest: { width: number; height: number } = { ...WORKBENCH_SIZE_DEFAULT }

function workbenchSize(): { width: number; height: number } {
  return {
    width: clampNumber(workbenchSizeRequest.width, WORKBENCH_SIZE_RANGE.minWidth, WORKBENCH_SIZE_RANGE.maxWidth, WORKBENCH_SIZE_DEFAULT.width),
    height: clampNumber(workbenchSizeRequest.height, WORKBENCH_SIZE_RANGE.minHeight, WORKBENCH_SIZE_RANGE.maxHeight, WORKBENCH_SIZE_DEFAULT.height),
  }
}

/** 记录工作台请求的尺寸，返回钳制后真正生效的值（页面据此知道有没有被截）。 */
function applyWorkbenchSize(size: { width?: unknown; height?: unknown }): { width: number; height: number; clamped: boolean } {
  const requestedWidth = Number(size?.width)
  const requestedHeight = Number(size?.height)
  if (Number.isFinite(requestedWidth)) workbenchSizeRequest.width = requestedWidth
  if (Number.isFinite(requestedHeight)) workbenchSizeRequest.height = requestedHeight
  const applied = workbenchSize()
  const clamped = applied.width !== Math.round(workbenchSizeRequest.width) || applied.height !== Math.round(workbenchSizeRequest.height)
  workbenchSizeRequest = { ...applied }
  return { ...applied, clamped }
}

async function enterCustomMode(): Promise<void> {
  if (!mainWindow || !viewManager) return
  hideTransferPanel()
  clearAlertCarry()
  cancelCollapse()
  cancelDeferredWorkbenchHide()
  // 若上一次收起动画中途被打断，zoom 可能停在 <1：重新打开前必须恢复。
  viewManager.endWorkbenchCollapse()
  // 控制台是最高优先级的"用户操作"：提醒与独占都让位（排队的提醒保留）。
  arbiter.interrupt()
  idleHover = false
  compactHover = false
  const serial = ++transitionSerial
  const view = await ensureWorkbenchView()
  if (!view || serial !== transitionSerial) return
  for (const plugin of runtimeViews()) viewManager.hide(plugin.manifest.id)
  const { width, height } = workbenchSize()
  const stage = stageOrigin(width, height, islandSettings.islandTop)
  workbenchStage = { x: stage.x, y: stage.y, width, height }
  // 从这里开始，页面量到的就是宿主真正排布出来的尺寸，它的 resize 请求才有意义。
  workbenchLaidOutOnce = true
  const bounds = centerBounds(width, height, islandSettings.islandTop)
  if (!bounds) return
  islandState.patch({ mode: 'custom', activePluginId: null, visiblePluginIds: [], sticky: false })
  setHitRegion(stageHitRegion(stage, 28))
  // clipPlugins: the renderer must stream its spring frames so the native clip
  // rect tracks the growing island and uncovers the console with it.
  sendLayout('custom', undefined, [], false, { width, height }, stage.y, [], { width, height }, true)
  await animateWindow(bounds)
  if (serial !== transitionSerial) return
  showHost()
}

function roundedRectContains(x: number, y: number): boolean {
  if (!mainWindow || mainWindow.isDestroyed() || !hitRegion.interactive) return false
  const bounds = mainWindow.getBounds()
  const localX = x - bounds.x
  const localY = y - bounds.y
  if (localX < hitRegion.x || localX > hitRegion.x + hitRegion.width || localY < hitRegion.y || localY > hitRegion.y + hitRegion.height) return false
  const radius = Math.min(hitRegion.radius, hitRegion.width / 2, hitRegion.height / 2)
  if (radius <= 0) return true
  const left = localX < hitRegion.x + radius
  const right = localX > hitRegion.x + hitRegion.width - radius
  const top = localY < hitRegion.y + radius
  const bottom = localY > hitRegion.y + hitRegion.height - radius
  if (!(left || right) || !(top || bottom)) return true
  const cx = left ? hitRegion.x + radius : hitRegion.x + hitRegion.width - radius
  const cy = top ? hitRegion.y + radius : hitRegion.y + hitRegion.height - radius
  return Math.hypot(localX - cx, localY - cy) <= radius
}
function updateHitTest(): void {
  if (!mainWindow || mainWindow.isDestroyed() || fullscreenHidden) return
  const point = screen.getCursorScreenPoint()
  // Prefer the utility window only where it actually overlaps the cursor.
  // The rest of the island remains clickable and stays above ordinary apps.
  if (auxiliaryWindowAt(point)) {
    if (hitInside) {
      hitInside = false
      islandState.patch({ pointerInside: false })
      sendHost('host:cursor', false)
    }
    mainWindow.setIgnoreMouseEvents(true, { forward: true })
    return
  }
  const inside = roundedRectContains(point.x, point.y)
  if (inside === hitInside) return
  hitInside = inside
  islandState.patch({ pointerInside: inside })
  mainWindow.setIgnoreMouseEvents(!inside, { forward: true })
  sendHost('host:cursor', inside)
  // 传输面板是用户任务；移出、拖动和普通通知均不能把接收确认或文件草稿自动收走。
  if (transferPanelOpen || transferDragging) return
  if (inside) {
    cancelCollapse()
    const state = islandState.value
    if (state.mode === 'expanded' || state.mode === 'detail' || state.mode === 'custom') islandState.patch({ sticky: false })
    else if (state.mode === 'idle' && !idleHover) {
      idleHover = true
      // 收起模式：从触发条展开时直接把插件一起带出来。idle 是空胶囊（插件视图
      // 被 1x1 裁剪窗藏住、但保持渲染），只有 compact 才把裁剪窗放开。
      if (islandSettings.idleMode === 'collapsed') { compactHover = true; void showCompact(true) }
      else void showIdle(true)
    } else if (state.mode === 'compact' && !compactHover) {
      compactHover = true
      void showCompact(true)
    }
    return
  }

  const state = islandState.value
  if (state.mode !== 'compact' && state.mode !== 'idle') sendHost('host:pointer-outside')
  if (state.mode === 'expanded' || state.mode === 'detail') {
    if (Date.now() < openGraceUntil) {
      islandState.patch({ sticky: true })
    } else if (!state.sticky) {
      // releaseFocus() calls the host's single showRest() transition. A
      // second showCompact() here used to race it and produce mini -> hover
      // sized, which looked like the island shrank past its target and came
      // back.
      arbiter.releaseFocus('preempted')
    }
  } else if (state.mode === 'custom') {
    void showCompact()
  } else if (state.mode === 'idle') {
    if (idleHover) void showIdle(false)
  } else if (state.mode === 'compact') {
    // 收起模式：鼠标一离开就缩回触发条；浮动模式仍留 3 秒窗口给插件活动。
    // 提醒显示期间不收起——它的生命周期由 ttl 决定。
    if (alertActive) return
    if (islandSettings.idleMode === 'collapsed' && !state.sticky) {
      compactHover = false
      void showIdle()
    } else {
      if (compactHover) {
        compactHover = false
        void showCompact(false)
      }
      scheduleTransientCollapse()
    }
  }
}
/**
 * Hit region for an island stage. 收起模式下小岛是从贴顶的 64x8 触发条里长出来的，
 * 所以热区必须把那条窄带一起包含进去：否则鼠标还停在触发条上（y < islandTop）时
 * 会被判成"已移出"，展开态每 40ms 就被打回收起态，看起来就是来回抖。
 */
function stageHitRegion(stage: { x: number; y: number; width: number; height: number }, radius: number): { x: number; y: number; width: number; height: number; radius: number } {
  if (islandSettings.idleMode !== 'collapsed') return { x: stage.x, y: stage.y, width: stage.width, height: stage.height, radius }
  return { x: stage.x, y: 0, width: stage.width, height: stage.y + stage.height, radius: 4 }
}

function setHitRegion(region: { x: number; y: number; width: number; height: number; radius?: number; interactive?: boolean }, refresh = true): void {
  if (![region.x, region.y, region.width, region.height].every(Number.isFinite)) return
  hitRegion = {
    x: Math.max(0, region.x), y: Math.max(0, region.y),
    width: Math.max(0, region.width), height: Math.max(0, region.height),
    radius: Math.max(0, region.radius ?? 0), interactive: region.interactive !== false,
  }
  // A transition changes the state before the native/renderer layout has
  // committed. Refreshing synchronously here can re-enter updateHitTest while
  // the cursor is already outside and start a second collapse in the same
  // turn. The caller refreshes after the new layout is submitted.
  if (refresh) updateHitTest()
}
function auxiliaryWindowAt(point: Electron.Point): boolean {
  // Settings is an ordinary window below the island; only the topmost
  // notification history can take precedence where it overlaps the island.
  const win = notificationHistoryWindow
  if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return false
  const bounds = win.getBounds()
  return point.x >= bounds.x && point.x < bounds.x + bounds.width && point.y >= bounds.y && point.y < bounds.y + bounds.height
}
function syncHostLayerForAuxiliaryWindows(): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  const history = notificationHistoryWindow
  if (history && !history.isDestroyed() && history.isAlwaysOnTop() !== !fullscreenHidden) history.setAlwaysOnTop(!fullscreenHidden, 'screen-saver')
  if (!fullscreenHidden && !win.isAlwaysOnTop()) win.setAlwaysOnTop(true, 'screen-saver')
  if (!fullscreenHidden) updateHitTest()
}
function watchAuxiliaryWindow(win: BrowserWindow): void {
  win.on('show', syncHostLayerForAuxiliaryWindows)
  win.on('hide', syncHostLayerForAuxiliaryWindows)
  win.on('closed', syncHostLayerForAuxiliaryWindows)
  syncHostLayerForAuxiliaryWindows()
}
function showHost(): void {
  if (!mainWindow || mainWindow.isDestroyed() || fullscreenHidden) return
  mainWindow.showInactive()
  syncHostLayerForAuxiliaryWindows()
}
function updateHostVisibilityForFullscreen(fullscreen: boolean): void {
  const win = mainWindow
  if (!win || win.isDestroyed() || quitRequested) return
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
  updateHitTest()
}
function cancelCollapse(): void { if (collapseTimer) clearTimeout(collapseTimer); collapseTimer = null }
function scheduleTransientCollapse(): void {
  cancelCollapse()
  if (islandState.value.sticky || islandState.value.pointerInside) return
  // 提醒自己带 ttl，别被活动计时器提前收掉。
  if (alertActive) return
  // 收起模式：常住插件("resident")也不能让小岛一直摊开，活动结束就回到触发条。
  // 只有浮动模式才允许常住插件把内容长期留在岛上；自己声明"没内容"的插件不算常住。
  const hasResident = orderedPlugins().length > 0
  if (hasResident && islandSettings.idleMode !== 'collapsed') return
  collapseTimer = setTimeout(() => {
    collapseTimer = null
    if (!islandState.value.pointerInside && islandState.value.mode === 'compact') void showIdle()
  }, 3000)
}

/**
 * 小岛的静止状态：收起模式只剩屏幕顶端的触发条，浮动模式显示插件内容。
 * 启动、以及切换"空闲表现/顶部位置/缩放"这类会影响静止尺寸的设置时都走这里。
 */
async function showRest(hovered = false): Promise<void> {
  if (transferPanelOpen || transferDragging) return
  if (showTransferProgress()) return
  if (islandSettings.idleMode === 'collapsed') {
    // Expanded content must pass through the mini layout before it is parked
    // at 1×1. Going straight to idle leaves a warm view in medium mode; the
    // next hover can then show that DOM clipped into the mini capsule.
    if (['expanded', 'detail', 'custom'].includes(islandState.value.mode)) {
      await showCompact(hovered)
      return
    }
    await showIdle(false)
    return
  }
  await showCompact(hovered)
}

/** 提醒态：mini 条只显示这一条（覆盖式），结束由仲裁器的 ttl 决定。 */
async function showAlertBar(alert: { pluginId: string; level: AlertLevel; color?: string; width?: number }): Promise<void> {
  const plugin = runtimeView(alert.pluginId)
  if (!plugin) return
  alertActive = true
  alertCarry = false
  alertCarryOwner = null
  // 档位与自定义颜色单独推给渲染层，岛壳据此画描边/光晕。不走 sendLayout：那条通道带 12 个位置参数
  // 和弹簧动画语义，塞进去会牵动动效路径。
  sendAlert(alert.level, alert.color)
  await showCompact(hitInside, plugin, alert.width)
}

/** 把当前提醒档位告诉岛壳；null 表示提醒已结束（撤掉描边光晕）。 */
function sendAlert(level: AlertLevel | null, color?: string | null): void {
  currentAlertLevel = level
  currentAlertColor = level ? (color ?? null) : null
  sendHost('host:alert', level ? { level, color: currentAlertColor } : null)
}

/** 撤掉"光圈跟随展开"状态；没有别的提醒在显示时顺带把岛壳的光圈撤掉。 */
function clearAlertCarry(): void {
  alertCarry = false
  alertCarryOwner = null
  if (!alertActive) sendAlert(null)
}

/** 仲裁器批准独占：真的把小岛展开到中岛/大岛。 */
function grantFocus(request: { pluginId: string; view: 'medium' | 'large' }): boolean {
  if (transferPanelOpen || transferDragging) return false
  const plugin = runtimeView(request.pluginId)
  if (!plugin) return false
  const mode: Extract<IslandMode, 'expanded' | 'detail'> = request.view === 'large' ? 'detail' : 'expanded'
  if (mode === 'expanded' && !plugin.manifest.medium) return false
  if (mode === 'detail' && !plugin.manifest.large) return false
  void showActive(plugin, mode)
  return true
}

/**
 * 先建好插件视图再隐藏。收起模式启动时不会走 showCompact，插件页从没加载过，
 * 第一次把鼠标移到触发条上就会看到"岛出来了但里面是空的"。
 */
async function warmPluginViews(): Promise<void> {
  const manager = viewManager
  if (!manager) return
  const small = orderedPlugins()
  const scale = islandSettings.miniScale
  const top = islandSettings.islandTop
  const { placements, baseWidth, height } = compactLayout(small, scale)
  const layout: AnimatedLayout = { width: baseWidth, height, top, placements, clipPlugins: true }
  await Promise.all(small.map(plugin => manager.ensure(plugin)))
  if (islandState.value.mode !== 'idle' || islandSettings.idleMode !== 'collapsed') return
  for (const plugin of small) {
    const placement = placements.find(item => item.pluginId === plugin.manifest.id)
    if (!placement) continue
    manager.setZoom(plugin.manifest.id, scale)
    manager.setBounds(plugin.manifest.id, pluginGeometry(layout, placement))
    manager.show(plugin.manifest.id)
  }
  compactScale = scale
  compactTop = top
  warmedPluginIds = small.map(plugin => plugin.manifest.id)
  syncPluginViews()
}

async function showIdle(hovered = false): Promise<void> {
  if (transferPanelOpen || transferDragging) return
  if (showTransferProgress()) return
  if (!mainWindow || !viewManager) return
  // 悬停状态必须跟布局同步：否则鼠标离开后 idleHover 残留为 true，
  // 下一次悬停触发条会被 `!idleHover` 挡住（表现为"悬停没反应/慢半拍"）。
  idleHover = hovered
  if (!hovered) compactHover = false
  clearAlertCarry()
  clearPendingMiniReveal()
  cancelCollapse()
  const serial = ++transitionSerial
  idleHover = hovered
  compactHover = false
  // 从工作台收回 mini 要走"吸入"（见 deferWorkbenchHide）：必须在下面的 patch 改模式前记下来。
  const fromConsole = islandState.value.mode === 'custom'
  // 插件视图不隐藏：它们保持可见、由 syncPluginViews 的 1x1 裁剪窗藏住，
  // 页面持续出帧，下次展开内容能跟着胶囊一起长出来。
  if (fromConsole) {
    deferWorkbenchHide()
    if (workbenchStage) viewManager?.beginWorkbenchCollapse(workbenchStage)
  }
  else hideWorkbench()
  const scale = islandSettings.miniScale
  const baseSize = islandSettings.idleMode === 'collapsed'
    ? (hovered ? SMALL_DEFAULT : { width: 64, height: 8 })
    : (hovered ? { width: 150, height: 46 } : SMALL_DEFAULT)
  const collapsed = islandSettings.idleMode === 'collapsed' && !hovered
  const collapsedMode = islandSettings.idleMode === 'collapsed'
  const size = { width: Math.round(baseSize.width * scale), height: Math.round(baseSize.height * scale) }
  const top = collapsed ? 0 : islandSettings.islandTop
  const bounds = centerBounds(size.width, size.height, top)
  if (!bounds) return
  const stage = stageOrigin(size.width, size.height, top)
  islandState.patch({ mode: 'idle', activePluginId: null, visiblePluginIds: [], sticky: false })
  setHitRegion(stageHitRegion(stage, (collapsedMode ? 4 : 19) * scale))
  const showClock = orderedPlugins().length === 0
  sendLayout('idle', undefined, [], collapsed, size, stage.y, [], size, false, showClock)
  if (fromConsole) armWorkbenchHideThreshold()
  await animateWindow(bounds)
  if (serial !== transitionSerial) return
  showHost()
  arbiter.noteIdle()
}

async function showCompact(hovered = false, solo?: PluginDescriptor, soloWidth?: number): Promise<void> {
  if (transferPanelOpen || transferDragging) return
  if (!solo && showTransferProgress()) return
  if (!mainWindow || !viewManager) return
  cancelCollapse()
  idleHover = false
  // Keep the hover flag authoritative instead of sticky: the collapse paths
  // decide on it, and it used to stay true after an event re-laid out the island.
  compactHover = hovered
  const visible = solo ? [solo] : orderedPlugins()
  if (visible.length === 0) { await showIdle(); return }

  const scale = islandSettings.miniScale
  const top = islandSettings.islandTop
  const currentCompactIds = animatedLayout.placements.map(item => item.pluginId)
  const visibleIds = visible.map(item => item.manifest.id)
  const sameSet = !solo && !alertActive && islandState.value.mode === 'compact'
    && currentCompactIds.length === visibleIds.length
    && currentCompactIds.every((id, index) => id === visibleIds[index] && viewManager!.has(id) && viewManager!.modeOf(id) === 'small')

  if (!solo && alertActive) {
    // 提醒正在整条显示时，hover 只改外壳尺寸，保持当前那条提醒的布局。
    const baseWidth = animatedLayout.width
    const baseHeight = animatedLayout.height
    const shellWidth = baseWidth + (hovered ? 10 : 0)
    const shellHeight = baseHeight + (hovered ? 4 : 0)
    const stage = stageOrigin(shellWidth, shellHeight, top)
    setHitRegion(stageHitRegion(stage, 28 * scale), false)
    sendLayout('compact', 'small', hostLayoutState.separators ?? [], false, { width: shellWidth, height: shellHeight }, stage.y, animatedLayout.placements, { width: baseWidth, height: baseHeight, top }, true, false, false, { overflow: hostLayoutState.overflow ?? 0, chipX: hostLayoutState.chipX ?? null, quickActions: false })
    return
  }

  if (sameSet && compactScale === scale && compactTop === top) {
    // Hovering an already-visible compact island must only resize the host shell.
    // Do not prepare, hide/show, resize, or re-zoom native plugin views here:
    // those operations cause the one-frame disappearance and the second animation
    // that the old renderer never had.
    const { layout, quickActions } = compactLayoutWithQuickActions(visible, scale, hovered && !solo && !alertActive)
    const { placements, separators, baseWidth, height: baseHeight, overflow, chipX } = layout
    const shellWidth = baseWidth + (hovered && !quickActions ? 10 : 0)
    const shellHeight = baseHeight + (hovered ? 4 : 0)
    const stage = stageOrigin(shellWidth, shellHeight, top)
    setHitRegion(stageHitRegion(stage, 28 * scale), false)
    sendLayout('compact', 'small', separators, false, { width: shellWidth, height: shellHeight }, stage.y, placements, { width: baseWidth, height: baseHeight, top }, true, false, false, { overflow, chipX, quickActions })
    return
  }

  if (sameSet) {
    // mini 缩放或"顶部距离"变了：原生插件视图缓存着自己的 bounds 和 zoom，光改外壳
    // 尺寸会留下旧尺寸的插件（表现为"改完缩放不生效，中岛来回一次才对"）。这里按新
    // 参数重排一次，但不走 prepare()——DOM 模式没变，不必先隐藏视图，避免那一帧闪烁。
    const { layout, quickActions } = compactLayoutWithQuickActions(visible, scale, hovered && !solo && !alertActive)
    const { placements, separators, baseWidth, height: baseHeight, overflow, chipX } = layout
    for (const plugin of visible) viewManager.setZoom(plugin.manifest.id, scale)
    compactScale = scale
    compactTop = top
    const shellWidth = baseWidth + (hovered ? 10 : 0)
    const shellHeight = baseHeight + (hovered ? 4 : 0)
    const stage = stageOrigin(shellWidth, shellHeight, top)
    setHitRegion(stageHitRegion(stage, 28 * scale), false)
    sendLayout('compact', 'small', separators, false, { width: shellWidth, height: shellHeight }, stage.y, placements, { width: baseWidth, height: baseHeight, top }, true, false, true, { overflow, chipX, quickActions })
    return
  }

  const serial = ++transitionSerial
  const { layout, quickActions } = hovered && !solo && !alertActive
    ? compactLayoutWithQuickActions(visible, scale, true)
    : { layout: compactLayout(visible, scale, { solo: !!solo, soloWidth }), quickActions: false }
  const { placements, separators, baseWidth, height, overflow, chipX } = layout
  for (const plugin of visible) await viewManager.ensure(plugin)
  if (serial !== transitionSerial) return
  for (const plugin of visible) viewManager.setZoom(plugin.manifest.id, scale)
  if (!solo) {
    compactScale = scale
    compactTop = top
  }
  const width = baseWidth + (hovered && !quickActions ? 10 : 0)
  const windowHeight = height + (hovered ? 4 : 0)
  const targetLayout: AnimatedLayout = { width: baseWidth, height, top, placements, clipPlugins: true }
  // 从工作台收回 mini：先别藏视图，让收缩中的裁剪窗把控制台"吸"进去（见 deferWorkbenchHide）。
  const fromConsole = islandState.value.mode === 'custom'
  if (fromConsole) {
    deferWorkbenchHide()
    if (workbenchStage) viewManager?.beginWorkbenchCollapse(workbenchStage)
  }
  else hideWorkbench()
  const bounds = centerBounds(width, windowHeight, top)
  if (!bounds) return
  // A compact hover changes only the host shell size. Do not hide or prepare
  // native plugin views again: that one-frame visibility reset is the flash
  // users see, and compact plugins do not need a second layout at all.
  // 从 中岛/大岛 收回到 mini 条：**不要立刻把插件切成 small**。
  // 立刻切的话，内容会先缩成 mini 尺寸，而胶囊还停在中岛那么大，要等 400ms 才追上来 ——
  // 看起来就是"内容缩到岛里面去了"，而展开是反过来的（胶囊先长，内容随之露出来）。
  // 正确做法：这一段时间保持插件原来的内容与尺寸不动，让收缩中的胶囊把它裁掉（吸进去的效果），
  // 等胶囊收到 mini 尺寸了再切 small 并显示 mini 内容。
  // 工作台（custom）同样算"收起"：插件本来就被工作台盖着，同样等到位后再切。
  const collapsing = !solo && (fromConsole || islandState.value.mode === 'expanded' || islandState.value.mode === 'detail')
  const prewarmed = !solo
    && islandState.value.mode === 'idle'
    && compactScale === scale
    && compactTop === top
    && warmedPluginIds.length === visibleIds.length
    && warmedPluginIds.every((id, index) => id === visibleIds[index])
    && visible.every(plugin => viewManager!.modeOf(plugin.manifest.id) === 'small')
  {
    await Promise.all(visible.map(async plugin => {
      const placement = placements.find(item => item.pluginId === plugin.manifest.id)!
      const geometry = pluginGeometry(targetLayout, placement)
      if (collapsing || prewarmed) return
      viewManager!.prepare(plugin.manifest.id, 'small', geometry)
      let ready = await viewManager!.waitForModeReady(plugin.manifest.id, 'small', 1200)
      if (!ready && serial === transitionSerial) {
        viewManager!.prepare(plugin.manifest.id, 'small', geometry, { forceModeReady: true })
        ready = await viewManager!.waitForModeReady(plugin.manifest.id, 'small', 1200)
      }
      if (!ready) pluginLogger?.append(plugin.manifest.id, 'warn', 'mini 布局切换未及时确认')
    }))
  }
  if (serial !== transitionSerial) return
  const stage = stageOrigin(width, windowHeight, top)
  islandState.patch({ mode: 'compact', activePluginId: null, visiblePluginIds: visible.map(item => item.manifest.id), sticky: false })
  setHitRegion(stageHitRegion(stage, 28 * scale), false)
  if (collapsing) {
    pendingMiniReveal = {
      ids: new Set(visible.map(item => item.manifest.id)),
      target: { layout: targetLayout, placements },
      timer: setTimeout(() => applyPendingMiniReveal('timeout'), 900),
    }
  } else {
    clearPendingMiniReveal()
  }
  sendLayout('compact', 'small', separators, false, { width, height: windowHeight }, stage.y, placements, { width: baseWidth, height, top }, true, false, true, { overflow, chipX, quickActions })
  if (fromConsole) armWorkbenchHideThreshold()
  await animateWindow(bounds)
  if (serial !== transitionSerial) return
  showHost()
  scheduleTransientCollapse()
  // 岛回到 mini 了：排队中的提醒可以上岛。
  arbiter.noteIdle()
}

/**
 * 收起动画到位之后，才把插件从"中岛/大岛内容"切成"mini 内容"。
 * 由 renderer 的动画帧驱动（收到接近目标尺寸的帧就切），并有超时兜底。
 */
async function applyPendingMiniReveal(reason: 'frame' | 'timeout'): Promise<void> {
  const pending = pendingMiniReveal
  if (!pending || !viewManager) return
  const serial = transitionSerial
  clearPendingMiniReveal()
  for (const id of pending.ids) {
    const placement = pending.target.placements.find(item => item.pluginId === id)
    if (!placement) { viewManager.hide(id); continue }
    const bounds = pluginGeometry(pending.target.layout, placement)
    viewManager.prepare(id, 'small', bounds)
    // Low-end machines can need longer than the expanded-mode budget to
    // repaint a file:// plugin page after the viewport has just collapsed.
    // Keep the native view hidden until the page confirms that its small DOM
    // is active; otherwise the old medium title can be clipped into the mini bar.
    let ready = await viewManager.waitForModeReady(id, 'small', 1200)
    if (!ready && serial === transitionSerial && islandState.value.mode === 'compact') {
      // Re-send once for slow renderers. The preload acknowledges every mode
      // message, including one whose requested mode is already selected.
      viewManager.prepare(id, 'small', bounds, { forceModeReady: true })
      ready = await viewManager.waitForModeReady(id, 'small', 1200)
    }
    if (serial !== transitionSerial || islandState.value.mode !== 'compact') return
    if (!ready) {
      viewManager.hide(id)
      pluginLogger?.append(id, 'warn', 'mini 布局未及时就绪，已隐藏旧尺寸视图以避免内容错位')
      continue
    }
    viewManager.show(id)
  }
  if (reason === 'timeout') viewManager.publishContract({ islandMode: hostLayoutState.mode, activePluginId: islandState.value.activePluginId, scale: islandSettings.miniScale })
}
function clearPendingMiniReveal(): void {
  if (pendingMiniReveal?.timer) clearTimeout(pendingMiniReveal.timer)
  pendingMiniReveal = null
}
async function showActive(plugin: PluginDescriptor, mode: Extract<IslandMode, 'expanded' | 'detail'>): Promise<void> {
  if (transferPanelOpen || transferDragging) return
  if (!mainWindow || !viewManager) return
  // 展开的是别的插件 → 提醒光圈不跟随，撤掉；展开的就是提醒归属插件 → 光圈继续跟随。
  if (alertCarry && alertCarryOwner !== plugin.manifest.id) clearAlertCarry()
  clearPendingMiniReveal()
  cancelCollapse()
  idleHover = false
  compactHover = false
  const pluginMode: PluginMode = mode === 'expanded' ? 'medium' : 'large'
  const serial = ++transitionSerial
  await viewManager.ensure(plugin)
  if (serial !== transitionSerial) return
  const size = pluginSize(plugin, pluginMode)
  const top = islandSettings.islandTop
  const placement: PluginPlacement = { pluginId: plugin.manifest.id, x: 0, width: size.width, height: size.height }
  const targetLayout: AnimatedLayout = { width: size.width, height: size.height, top, placements: [placement], clipPlugins: true }
  const geometry = pluginGeometry(targetLayout, placement)
  viewManager.setZoom(plugin.manifest.id, 1)
  // 已经在收起态持续渲染的页面不要再次 hide/show；只在原生裁剪窗后切模式，
  // 否则 Chromium 合成器会丢掉这一次展开的首帧。冷页面才走隐藏等待握手。
  viewManager.prepare(plugin.manifest.id, pluginMode, geometry, { preserveVisibility: viewManager.isShown(plugin.manifest.id) })
  await viewManager.waitForModeReady(plugin.manifest.id, pluginMode)
  if (serial !== transitionSerial) return
  for (const item of runtimeViews()) if (item.manifest.id !== plugin.manifest.id) viewManager.hide(item.manifest.id)
  hideWorkbench()
  const bounds = centerBounds(size.width, size.height, top)
  if (!bounds) return
  const stage = stageOrigin(size.width, size.height, top)
  openGraceUntil = Date.now() + 400
  islandState.patch({ mode, activePluginId: plugin.manifest.id, visiblePluginIds: [plugin.manifest.id], sticky: false })
  setHitRegion({ x: stage.x, y: stage.y, width: size.width, height: size.height, radius: 28 })
  // Defer the first native-view reveal to host:animation-frame. This keeps
  // the target large bounds hidden until the shell has started its spring, so
  // there is no large-left-edge flash before the medium-to-large animation.
  sendLayout(mode, pluginMode, [], false, size, stage.y, [placement], size, true, false, false)
  await animateWindow(bounds)
  if (serial !== transitionSerial) return
  hitInside = !roundedRectContains(screen.getCursorScreenPoint().x, screen.getCursorScreenPoint().y)
  updateHitTest()
  showHost()
}
function handlePluginCommand(pluginId: string, command: string, args: unknown[]): void {
  const plugin = runtimeView(pluginId)
  if (!plugin) return
  const state = islandState.value
  if (command === 'ui:expand') {
    // 用户点自己的 mini 段 → 用户操作优先，直接展开并登记独占。
    if (state.mode === 'compact') {
      if (plugin.manifest.medium) {
        // 点的是正在显示的提醒 → 光圈跟随进中岛，离开展开态才撤。
        const showing = arbiter.showingAlert()
        alertCarry = !!showing && showing.pluginId === pluginId
        alertCarryOwner = alertCarry ? pluginId : null
        arbiter.claimFocus({ pluginId, view: 'medium', reason: 'user' })
        void showActive(plugin, 'expanded')
      }
    } else if (state.mode === 'expanded' && state.activePluginId === pluginId && plugin.manifest.large) {
      // 中岛升大岛：光圈继续跟随（若它正带着提醒光圈）。
      arbiter.claimFocus({ pluginId, view: 'large', reason: 'user' })
      void showActive(plugin, 'detail')
    }
  } else if (command === 'ui:collapse') {
    // 回到 mini 段。
    clearAlertCarry()
    arbiter.releaseFocus('self', pluginId)
    void showCompact()
  } else if (command === 'ui:close') {
    // "我这条显示结束"：先撤掉自己的提醒；否则按收起处理。
    if (arbiter.dismissAlert(pluginId)) return
    clearAlertCarry()
    arbiter.releaseFocus('self', pluginId)
    void showCompact()
  } else if (command === 'alert') {
    arbiter.requestAlert({ pluginId, ...(args[0] as object | undefined) })
  } else if (command === 'focus') {
    arbiter.requestFocus({ pluginId, ...(args[0] as object | undefined) })
  } else if (command === 'tools:set') {
    // 工具页实时数据：插件只能更新自己清单里声明过的工具。
    const toolId = args[0]
    const patch = args[1] as { view?: unknown; notice?: unknown } | undefined
    if (typeof toolId !== 'string' || !patch || typeof patch !== 'object') return
    const tool = plugin.manifest.tools?.find(item => item.id === toolId)
    if (!tool) return
    if (patch.view !== undefined && !isPluginToolView(patch.view)) return
    const current = pluginToolState.get(pluginId) ?? {}
    const previous = current[toolId]
    const next: PluginToolLive = { ...(previous ?? {}), updatedAt: Date.now() }
    if (patch.view !== undefined) next.view = patch.view
    if (patch.notice !== undefined) next.notice = patch.notice === null ? null : String(patch.notice).slice(0, 500)
    current[toolId] = next
    pluginToolState.set(pluginId, current)
    notifyPluginTools(pluginId)
  } else if (command === 'ui:request-size' && state.activePluginId === pluginId && mainWindow) {
    const requested = args[0] as { width?: number; height?: number } | undefined
    if (!requested) return
    const mode = state.mode === 'detail' ? 'large' : 'medium'
    const declared = pluginSize(plugin, mode)
    const configured = plugin.manifest[mode]
    const defaults = MODE_DEFAULTS[mode]
    const minWidth = Math.max(mode === 'large' ? 400 : 260, Number(configured?.minWidth) || 0)
    const minHeight = Math.max(mode === 'large' ? 160 : 110, Number(configured?.minHeight) || 0)
    const maxWidth = Math.min(mode === 'large' ? 1000 : 800, Math.max(minWidth, Number(configured?.maxWidth) || Infinity))
    const maxHeight = Math.min(mode === 'large' ? 680 : 400, Math.max(minHeight, Number(configured?.maxHeight) || Infinity))
    const width = Math.max(minWidth, Math.min(maxWidth, Math.round(requested.width ?? declared.width ?? defaults.width)))
    const height = Math.max(minHeight, Math.min(maxHeight, Math.round(requested.height ?? declared.height ?? defaults.height)))
    const stage = stageOrigin(width, height, islandSettings.islandTop)
    viewManager?.setBounds(pluginId, { x: stage.x, y: stage.y, width, height })
    setHitRegion({ x: stage.x, y: stage.y, width, height, radius: 30 })
    sendLayout(state.mode, mode, [], false, { width, height }, stage.y)
    const bounds = centerBounds(width, height)
    if (bounds) void animateWindow(bounds, 260)
  } else if (command === 'media:command') {
    // 全局媒体键：任何播放器都认，插件不需要自己的后台脚本也能控制播放。
    const action = args[0]
    if (action === 'previous' || action === 'toggle' || action === 'next') {
      sendMediaKey(action)
      events.emit('media:command', { pluginId, action })
    }
  } else if (command === 'ui:presence') {
    // 插件自报"我现在有没有内容"：false = 别占着 mini 条（例如没有正在播放的媒体）。
    const present = args[0] !== false
    if (present !== !hiddenPlugins.has(pluginId)) {
      if (present) hiddenPlugins.delete(pluginId)
      else hiddenPlugins.add(pluginId)
      if (!present) {
        viewManager?.hide(pluginId)
        // 立刻让插件知道"你已经不在岛上了"，它的 island.every() 会自动暂停。
        viewManager?.publishContract({ islandMode: hostLayoutState.mode, activePluginId: islandState.value.activePluginId, scale: islandSettings.miniScale })
        // 正展开着它却被自己撤下 → 回到 mini 条，别留一个空白中岛。
        if ((state.mode === 'expanded' || state.mode === 'detail') && state.activePluginId === pluginId) {
          clearAlertCarry()
          arbiter.releaseFocus('self', pluginId)
          void showCompact(hitInside)
          return
        }
      }
      // 只有 mini 条正在显示时才重排；收起态（idle）不主动弹出来打扰用户。
      // 例外是浮动模式：那条横条本来就该一直挂着，插件又有内容了就把条恢复出来。
      if (islandState.value.mode === 'compact') void showCompact(compactHover)
      else if (islandState.value.mode === 'idle' && islandSettings.idleMode !== 'collapsed') void showCompact(false)
    }
  }
}

/**
 * 插件事件的中转站。
 * `toSelf` = 这个事件本来就是发给该插件自己的（它 resources/ 里后台脚本的 stdout、runtime:log/exit），
 * 必须也送到它自己的页面 —— 否则插件收不到自己后台脚本的输出。
 */
function emitPluginEvent(pluginId: string, name: string, payload: unknown, options: { toSelf?: boolean } = {}): void {
  if (name === 'runtime:log') {
    const entry = payload as { level?: string; message?: unknown } | undefined
    const level = entry?.level === 'error' ? 'error' : entry?.level === 'warn' ? 'warn' : 'info'
    pluginLogger?.append(pluginId, level, entry?.message ?? '')
  } else if (name.startsWith('runtime:')) {
    const level = name === 'runtime:error' ? 'error' : name === 'runtime:exit' ? 'warn' : 'info'
    pluginLogger?.append(pluginId, level, `${name} ${typeof payload === 'string' ? payload : JSON.stringify(payload)}`)
  }
  events.emit(`${pluginId}:${name}`, payload)
  viewManager?.broadcastEvent(name, payload, pluginId, options)
  // 设置面板不是岛上的插件视图，broadcastEvent 管不到；属于这个插件的事件（后台脚本
  // stdout、runtime:*）必须镜像给它，面板页才能和岛上视图收到同一份事件。
  if (pluginPanel && pluginPanel.pluginId === pluginId && !pluginPanel.view.webContents.isDestroyed()) {
    pluginPanel.view.webContents.send('host:event', { name, payload })
  }
  // 旧语义 ui:show / activity 收敛到 alert：带默认 ttl 的提醒，排队规则一致。
  if (name === 'ui:show' || name === 'activity') arbiter.requestAlert({ pluginId, key: name, level: 'info', ttl: 4000 })
}
function sendMediaKey(action: 'previous' | 'toggle' | 'next'): void {
  if (process.platform !== 'win32') return
  const key = action === 'previous' ? 0xB1 : action === 'next' ? 0xB0 : 0xB3
  const command = `$sig='[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);'; Add-Type -MemberDefinition $sig -Name MediaKey -Namespace Native; [Native.MediaKey]::keybd_event(${key},0,1,[UIntPtr]::Zero); [Native.MediaKey]::keybd_event(${key},0,3,[UIntPtr]::Zero)`
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, stdio: 'ignore' })
  child.unref()
}

// 工作台数据目录。`shortcuts.json` 是宿主拥有的（跨工作台共享）；
// 页面自己的偏好（刷新频率、主题色…）走 `workbench.storage`，宿主不掺和 ——
// 那些是某个页面的展示选择，不该让宿主为它开专用接口。
function workbenchDataRoot(): string { return path.join(app.getPath('userData'), 'workbench') }
function shortcutsFile(): string { return path.join(workbenchDataRoot(), 'shortcuts.json') }

// ---------------------------------------------------------------- 工作台能力
/**
 * 当前活动工作台声明了哪些能力。
 * 内置工作台（`builtin`）随宿主分发、本来就是受信任的，所以视为声明全部；
 * 装进来的工作台按 manifest 的 `capabilities` 设置，且**必须已被用户确认**才能启用（见 activateWorkbench）。
 */
let activeWorkbenchId = BUILTIN_WORKBENCH_ID
let activeWorkbenchCapabilities: ReadonlySet<string> = allCapabilities()
/** 工作台视图当前加载的是哪个工作台（换活动工作台时要重新 loadFile）。 */
let loadedWorkbenchId: string | null = null
export function workbenchCapabilities() { return { id: activeWorkbenchId, capabilities: [...activeWorkbenchCapabilities] } }

/** 只用于测试/内部：直接设定能力集（不写入设置）。 */
export function setActiveWorkbench(id: string, declared: unknown): void {
  activeWorkbenchId = id
  activeWorkbenchCapabilities = id === BUILTIN_WORKBENCH_ID ? allCapabilities() : new Set(normalizeCapabilities(declared))
}

/** 按描述符应用能力集：内置=全部；其余=manifest 声明。 */
function applyWorkbenchGrant(descriptor: WorkbenchDescriptor): void {
  activeWorkbenchId = descriptor.manifest.id
  activeWorkbenchCapabilities = descriptor.builtin ? allCapabilities() : new Set(descriptor.capabilities)
}

/**
 * 当前该用哪个工作台。
 * 设置里的那个不存在或已损坏时**回落内置**并记一条日志 ——
 * 否则右键小岛会试图打开一个不存在的入口，用户看到的是"点了没反应"。
 */
function resolveActiveWorkbench(): WorkbenchDescriptor {
  const wanted = islandSettings.activeWorkbench
  const found = workbenchManager?.get(wanted)
  if (found) return found
  if (wanted !== BUILTIN_WORKBENCH_ID) {
    pluginLogger?.append('_host', 'warn', `活动工作台「${wanted}」不存在，已回落到内置工作台`)
    islandSettings.activeWorkbench = BUILTIN_WORKBENCH_ID
    saveIslandSettings()
  }
  const builtin = workbenchManager?.get(BUILTIN_WORKBENCH_ID)
  if (builtin) return builtin
  // 连内置都没有：返回一个最小描述符，避免调用方到处判空。
  return {
    manifest: { id: BUILTIN_WORKBENCH_ID, name: '内置工作台', version: '1.0.0', entry: 'index.html' },
    rootDir: path.join(appRoot(), 'console-apps', 'workbench'),
    entryPath: path.join(appRoot(), 'console-apps', 'workbench', 'index.html'),
    builtin: true,
    capabilities: [...allCapabilities()],
  }
}

/**
 * 启用一个工作台（**独占**：设置里只存一个 id）。
 * 声明里有没有被用户确认过的能力，是能不能启用的前提 —— 工作台是**可分发**的，
 * 「装一个工作台 = 装一个任意程序」，所以"声明与实际能做一致"必须在这里强制。
 */
function activateWorkbench(id: string): { ok: boolean; error?: string; missing?: string[]; id?: string } {
  const descriptor = workbenchManager?.get(id)
  if (!descriptor) return { ok: false, error: '工作台不存在' }
  const granted = new Set(islandSettings.workbenchGrants[id] ?? [])
  const missing = descriptor.capabilities.filter(capability => !granted.has(capability))
  if (missing.length) return { ok: false, error: 'capabilities-not-acknowledged', missing }
  islandSettings.activeWorkbench = id
  saveIslandSettings()
  applyWorkbenchGrant(descriptor)
  // 正在看控制台就立刻换过去；否则下次右键生效。
  if (consoleVisible()) void enterCustomMode()
  sendHost('host:workbenches-changed', workbenchListPayload())
  return { ok: true, id }
}

/** 记录用户确认了哪些能力（管理页在启用前展示并让用户确认）。 */
function acknowledgeWorkbench(id: string, capabilities: string[]): { ok: boolean; grants?: string[] } {
  const descriptor = workbenchManager?.get(id)
  if (!descriptor) return { ok: false }
  const normalized = normalizeCapabilities(capabilities)
  // 只接受该工作台**真的声明了**的能力，避免前端塞进无关项。
  const allowed = normalized.filter(capability => descriptor.capabilities.includes(capability))
  const merged = [...new Set([...(islandSettings.workbenchGrants[id] ?? []), ...allowed])]
  islandSettings.workbenchGrants = { ...islandSettings.workbenchGrants, [id]: merged }
  saveIslandSettings()
  return { ok: true, grants: merged }
}

function workbenchListPayload(): Array<Record<string, unknown>> {
  const active = islandSettings.activeWorkbench
  return (workbenchManager?.list() ?? []).map(descriptor => {
    const granted = new Set(islandSettings.workbenchGrants[descriptor.manifest.id] ?? [])
    const fields = workbenchSettingsFields(descriptor.manifest.id)
    return {
      id: descriptor.manifest.id,
      name: descriptor.manifest.name,
      version: descriptor.manifest.version,
      description: descriptor.manifest.description ?? '',
      // 卡片上的缩略图：作者提供的示例图，没提供就由页面画占位
      preview: workbenchPreviewDataUrl(descriptor.manifest.id),
      builtin: descriptor.builtin,
      active: descriptor.manifest.id === active,
      sourceDir: workbenchManager?.sourceOf(descriptor.manifest.id) ?? null,
      hasSettings: fields.length > 0,
      paramCount: fields.length,
      capabilities: descriptor.capabilities.map(capability => ({ capability, label: CAPABILITY_LABELS[capability] })),
      // 还没确认过的能力：管理页要用它来提示"启用前请确认"。
      unacknowledged: descriptor.capabilities.filter(capability => !granted.has(capability)),
    }
  })
}

/** 只有工作台自己的页面能调工作台通道。插件页拿不到（plugin-preload 不暴露通用 invoke），这里再挡一层。 */
function isWorkbenchSender(sender: Electron.WebContents): boolean {
  if (workbenchView && !workbenchView.webContents.isDestroyed() && workbenchView.webContents === sender) return true
  return false
}

/**
 * 工作台通道的统一守卫：必须是工作台页面 + 声明了对应能力。
 * 返回错误串表示拒绝。**拒绝要明确**（`capability-not-declared:run`），不能静默失败 ——
 * 静默失败正是内置工作台「DeepSeek 用量」烂掉却没人发现的原因。
 */
function workbenchGuard(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent, capability: WorkbenchCapability | null): string | null {
  if (!isWorkbenchSender(event.sender)) return 'not-a-workbench'
  if (capability) return checkCapability(activeWorkbenchCapabilities, capability)
  return null
}

/** 工作台日志落到自己的文件：<userData>/island-plugins/logs/__workbench__<id>.log */
function workbenchLogId(): string { return `__workbench__${activeWorkbenchId}` }

/** http 返回体上限：防止一个工作台把主进程内存吃满。 */
/** 工作台自己的存储：复用插件存储（按 workbench id 分命名空间）。 */
function workbenchStorageKey(id: string): string { return `__workbench__${id}` }
function workbenchStorageId(): string { return workbenchStorageKey(activeWorkbenchId) }

/**
 * 工作台参数（workbench.json 的 `settings.fields`）。
 * 和插件用的是同一套机制与同一个保留键（`__settings`），所以页面既能用 `settings.*` 读，
 * 也能用 `storage.get('__settings')` 直接看到 —— 不存在"两套参数"。
 */
function workbenchSettingsFields(id: string): Array<Record<string, unknown>> {
  const fields = workbenchManager?.get(id)?.manifest.settings?.fields
  return Array.isArray(fields) ? (fields as unknown as Array<Record<string, unknown>>) : []
}

function workbenchSettingsValues(id: string): Record<string, unknown> {
  const stored = (storage?.get(workbenchStorageKey(id), SETTINGS_KEY) as Record<string, unknown> | undefined) ?? {}
  const values: Record<string, unknown> = {}
  for (const field of workbenchSettingsFields(id)) {
    const key = String(field.key ?? '')
    if (key && field.default !== undefined) values[key] = field.default
  }
  return { ...values, ...stored }
}

function saveWorkbenchSettings(id: string, patch: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set(workbenchSettingsFields(id).map(field => String(field.key ?? '')))
  const clean: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) if (allowed.has(key)) clean[key] = value
  const next = { ...workbenchSettingsValues(id), ...clean }
  storage?.set(workbenchStorageKey(id), SETTINGS_KEY, next)
  // 正在显示的就是它 → 页面立刻收到；控制台窗口也刷新。
  if (id === activeWorkbenchId && workbenchView && !workbenchView.webContents.isDestroyed()) {
    workbenchView.webContents.send('host:settings', { values: next, schema: workbenchManager?.get(id)?.manifest.settings ?? null })
  }
  return next
}

/**
 * 示例图：读成 data URL 交给管理页当缩略图。
 * 用 data URL 而不是让页面直接 `<img src="file://…">`：设置页自己也是 file:// 页面，
 * 直接引本地图片会被 Chromium 的 file 源策略挡住，读成 data URL 最稳。
 */
function workbenchPreviewDataUrl(id: string): string | null {
  const descriptor = workbenchManager?.get(id)
  const relative = descriptor?.manifest.preview
  if (!descriptor || !relative) return null
  const root = path.resolve(descriptor.rootDir)
  const file = path.resolve(root, String(relative))
  if (!file.startsWith(root + path.sep)) return null
  const mime = /\.svg$/i.test(String(relative)) ? 'image/svg+xml'
    : /\.png$/i.test(String(relative)) ? 'image/png'
      : /\.jpe?g$/i.test(String(relative)) ? 'image/jpeg'
        : /\.webp$/i.test(String(relative)) ? 'image/webp' : null
  if (!mime) return null
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size > 512 * 1024) return null
    return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`
  } catch { return null }
}
function readShortcuts(): Array<{ id: string; name: string; path: string }> {
  try { return JSON.parse(fs.readFileSync(shortcutsFile(), 'utf8')) as Array<{ id: string; name: string; path: string }> } catch { return [] }
}
function writeShortcuts(shortcuts: Array<{ id: string; name: string; path: string }>): void {
  fs.mkdirSync(workbenchDataRoot(), { recursive: true })
  fs.writeFileSync(shortcutsFile(), JSON.stringify(shortcuts, null, 2), 'utf8')
}
/**
 * 解开 `.islandplugin`（zip）到临时目录，**按包内清单自动判断装成插件还是控制台**。
 * 这样「导入插件包」一个入口就能装两种东西 —— 控制台既然是可分发应用，就不该要求用户
 * 记住"这个包要用另一个按钮装"。
 */
async function installPackage(filePath: string): Promise<{ kind: 'plugin' | 'workbench'; id: string; name: string; version: string; capabilities?: string[] }> {
  if (!pluginManager) throw new Error('插件管理器未就绪')
  if (!fs.existsSync(filePath)) throw new Error(`文件不存在：${filePath}`)
  // 先给出人话错误：拿一个 exe/txt 来当插件包是最常见的误操作。
  if (!isZipFile(filePath)) throw new Error('这不是一个插件包（.islandplugin 应该是 zip 格式）')
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'island-plugin-'))
  try {
    const written = extractZip(filePath, temp)
    if (!written.length) throw new Error('插件包是空的')
    // 包内可能直接是产物目录，也可能套了一层外层目录
    const candidates = [temp, ...fs.readdirSync(temp, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => path.join(temp, entry.name))]
    const workbenchRoot = candidates.find(dir => fs.existsSync(path.join(dir, 'workbench.json')))
    if (workbenchRoot) {
      if (!workbenchManager) throw new Error('工作台管理器未就绪')
      const installed = workbenchManager.installDirectory(workbenchRoot)
      pluginLogger?.append('_host', 'info', `已从插件包安装控制台「${installed.manifest.name}」（${path.basename(filePath)}，${written.length} 个文件）`)
      sendHost('host:workbenches-changed', workbenchListPayload())
      return { kind: 'workbench', id: installed.manifest.id, name: installed.manifest.name, version: installed.manifest.version, capabilities: installed.capabilities }
    }
    const root = candidates.find(dir => fs.existsSync(path.join(dir, 'plugin.json')))
    if (!root) throw new Error('包内既没有 plugin.json 也没有 workbench.json（确认这是用「导出插件包」生成的包）')
    const plugin = pluginManager.installDirectory(root, { link: false })
    pluginLogger?.append(plugin.manifest.id, 'info', `已从插件包安装 v${plugin.manifest.version}（${path.basename(filePath)}，${written.length} 个文件）`)
    backgroundManager?.start(plugin)
    startWatching()
    await showCompact()
    sendHost('host:plugins-changed', plugins().map(item => item.manifest))
    return { kind: 'plugin', id: plugin.manifest.id, name: plugin.manifest.name, version: plugin.manifest.version }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

async function exportPluginPackage(pluginId: string, targetPath: string): Promise<{ ok: boolean; path?: string; bytes?: number; entries?: number; error?: string }> {
  const plugin = pluginManager?.get(pluginId)
  if (!plugin) return { ok: false, error: '插件未加载' }
  return exportArtifactPackage({
    rootDir: plugin.rootDir, manifestFile: 'plugin.json', entry: String(plugin.manifest.entry ?? ''),
    label: '插件包', logId: pluginId, version: plugin.manifest.version,
  }, targetPath, (id, message) => pluginLogger?.append(id, 'info', message))
}

async function exportWorkbenchPackage(workbenchId: string, targetPath: string): Promise<{ ok: boolean; path?: string; bytes?: number; entries?: number; error?: string }> {
  const descriptor = workbenchManager?.get(workbenchId)
  if (!descriptor) return { ok: false, error: '工作台不存在' }
  if (descriptor.builtin) return { ok: false, error: '内置工作台随宿主分发，不需要单独导出' }
  return exportArtifactPackage({
    rootDir: descriptor.rootDir, manifestFile: 'workbench.json', entry: String(descriptor.manifest.entry ?? ''),
    label: '工作台包', logId: workbenchStorageKey(workbenchId), version: descriptor.manifest.version,
  }, targetPath, (id, message) => pluginLogger?.append(id, 'info', message))
}

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
    icon: appIcon(),
    webPreferences: { preload: path.join(__dirname, 'preload', 'settings-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  })
  settingsWindow = win
  watchAuxiliaryWindow(win)
  void win.loadFile(path.join(appRoot(), 'console-apps', 'settings', 'index.html'), tab ? { query: { tab } } : undefined)
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
  const plugin = pluginManager?.get(pluginId)
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
      preload: path.join(__dirname, 'preload', 'plugin-preload.js'),
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
    if (pluginPanel?.view !== view || !viewManager) return
    view.webContents.send('host:hello', viewManager.helloPayloadFor(pluginId))
    view.webContents.send('host:visibility', { visible: true, reason: 'expanded', rendering: true })
  })
  return { ok: true }
}
function closeAppWindows(): void {
  fullscreenMonitor?.stop()
  fullscreenMonitor = null
  fullscreenHidden = false
  // Hide the transparent always-on-top host before tearing down child views so
  // the Windows trigger strip disappears immediately during tray exit.
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    if (win.isDestroyed()) continue
    try { win.hide() } catch { /* window is already closing */ }
  }
  if (hitPoll) { clearInterval(hitPoll); hitPoll = null }
  cancelCollapse()
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
  settingsWindow = null
  islandLayout = null
}
/**
 * 内置通知模块的事件出口：推给岛上的 system-notifications 视图，并驱动提醒条。
 * 视图可能还没加载（启动早期），viewManager 内部会丢弃未知 id 的消息，事件不丢在管道里。
 */
/**
 * 内置通知模块的事件出口：推给岛上的 system-notifications 视图。
 * 该模块是「仅提醒」模式（resident:false），不在 orderedPlugins 里，因此启动时不会
 * 被 warmPluginViews 预热；这里负责确保视图存在，否则提醒事件会发给一个不存在的视图而丢失。
 */
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

function notificationHistoryFile(): string {
  return path.join(app.getPath('userData'), 'notifications')
}

function hideTransferPanel(): void {
  transferPanelOpen = false
  transferDragging = false
  if (transferDragTimer) clearTimeout(transferDragTimer)
  transferDragTimer = null
  viewManager?.setTransferStage(null)
}

function showTransferProgress(): boolean {
  if (!transferService || !viewManager || transferPanelOpen || transferDragging || alertActive) return false
  const tasks = transferService.snapshot().sessions.filter(s => !['completed', 'failed', 'cancelled', 'rejected'].includes(s.state))
  if (!tasks.length) {
    if (transferProgressVisible) sendHost('transfers:progress', null)
    transferProgressVisible = false
    return false
  }
  const task = tasks[0]
  const progress = task.total ? Math.min(100, Math.floor((task.state === 'verifying' ? task.preparedBytes ?? 0 : task.bytes) / task.total * 100)) : 0
  const text = task.state === 'waiting' ? (task.direction === 'incoming' ? '有文件等待接收' : `等待 ${task.peer} 接受`)
    : task.state === 'verifying' ? `准备文件 · ${progress}%` : `${task.direction === 'incoming' ? '接收' : '发送'}文件 · ${progress}%`
  if (transferProgressVisible) {
    sendHost('transfers:progress', { text, progress })
    return true
  }
  clearPendingMiniReveal()
  cancelCollapse()
  hideWorkbench()
  const size = { width: 260, height: 40 }
  const stage = stageOrigin(size.width, size.height)
  transferProgressVisible = true
  islandState.patch({ mode: 'compact', activePluginId: null, visiblePluginIds: [], sticky: true })
  setHitRegion(stageHitRegion(stage, 20), false)
  sendLayout('compact', undefined, [], false, size, stage.y, [], size, false)
  sendHost('transfers:progress', { text, progress })
  showHost()
  return true
}

type TransferOpenRequest = { mode: 'files' | 'text'; text?: string }
async function openTransferPanel(request?: TransferOpenRequest): Promise<void> {
  if (!mainWindow || !viewManager) return
  if (transferPanelOpen && transferViewLoading) {
    await transferViewLoading
    if (request) transferView?.webContents.send('transfers:open-mode', request)
    return
  }
  const wasOpen = transferPanelOpen
  transferPanelOpen = true
  transferProgressVisible = false
  sendHost('transfers:progress', null)
  cancelCollapse()
  arbiter.interrupt()
  clearPendingMiniReveal()
  clearAlertCarry()
  sendAlert(null)
  hideWorkbench()
  if (wasOpen && transferView && !transferView.webContents.isDestroyed()) {
    transferView.webContents.send('transfers:change', transferService?.snapshot())
    if (request) transferView.webContents.send('transfers:open-mode', request)
    return
  }
  const serial = ++transitionSerial
  if (!transferView || transferView.webContents.isDestroyed()) {
    const view = new WebContentsView({ webPreferences: {
      preload: path.join(__dirname, 'preload', 'transfer-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false,
    } })
    transferView = view
    view.setBackgroundColor('#00000000')
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    view.webContents.on('will-navigate', event => event.preventDefault())
    viewManager.adoptTransfer(view)
    transferViewLoading = view.webContents.loadFile(path.join(appRoot(), 'modules', 'file-transfer', 'index.html'))
    try { await transferViewLoading } finally { transferViewLoading = null }
  }
  if (!transferPanelOpen || serial !== transitionSerial) return
  const size = transferPanelSize
  const stage = stageOrigin(size.width, size.height)
  islandState.patch({ mode: 'custom', activePluginId: null, visiblePluginIds: [], sticky: true })
  setHitRegion(stageHitRegion(stage, 28), false)
  viewManager.setTransferStage(stage)
  sendLayout('custom', undefined, [], false, size, stage.y, [], size, true)
  transferView?.webContents.send('transfers:change', transferService?.snapshot())
  if (request) transferView?.webContents.send('transfers:open-mode', request)
  showHost()
}

function installTransferIpc(): void {
  registerTransferIpc({
    get transferView() { return transferView },
    get mainWindow() { return mainWindow },
    get workbenchView() { return workbenchView },
    get viewManager() { return viewManager },
    get activeWorkbenchId() { return activeWorkbenchId },
    get transferDragTimer() { return transferDragTimer },
    set transferDragTimer(value) { transferDragTimer = value },
    get transferDragging() { return transferDragging },
    set transferDragging(value) { transferDragging = value },
    get transferPanelOpen() { return transferPanelOpen },
    get transitionSerial() { return transitionSerial },
    set transitionSerial(value) { transitionSerial = value },
    get transferService() { return transferService },
    get transferPanelSize() { return transferPanelSize },
    set transferPanelSize(value) { transferPanelSize = value },
    get arbiter() { return arbiter },
    openTransferPanel, createNotificationHistoryWindow, cancelCollapse, stageOrigin, stageHitRegion, setHitRegion, sendLayout, sendHost, showHost, showRest, hideTransferPanel
  })
}

function testLevel(value: unknown): 'info' | 'warn' | 'critical' {
  return value === 'warn' || value === 'critical' ? value : 'info'
}

/** 托盘提示里带一条通知状态摘要（不含正文），方便确认监听是否在跑。 */
function refreshNotificationTrayHint(): void {
  if (!tray || !notificationModule) return
  const status = notificationModule.status()
  const windows = status.windows
  const windowsText = windows.access === 'allowed' ? '监听中' : windows.access === 'denied' ? '未授权' : windows.access === 'unspecified' ? '待授权' : '不可用'
  tray.setToolTip(`Activity Island · 通知 ${windowsText} · 历史 ${status.totalRecords} 条`)
}

/**
 * 自绘的清空确认框：系统 messageBox 是浅色 Windows 风格，和深色岛/控制台完全不符。
 * 无边框 + 透明底，页面自己画圆角与阴影；用户选择通过一次性 IPC 回传。
 */
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
        preload: path.join(__dirname, 'preload', 'notification-confirm-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    })
    clearConfirmWindow = win
    win.setMenu(null)
    void win.loadFile(path.join(appRoot(), 'modules', BUILTIN_NOTIFICATIONS_ID, 'confirm.html'), {
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
    icon: appIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload', 'notification-history-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  notificationHistoryWindow = win
  watchAuxiliaryWindow(win)
  win.on('closed', () => { notificationHistoryWindow = null })
  void win.loadFile(path.join(appRoot(), 'modules', BUILTIN_NOTIFICATIONS_ID, 'history.html'))
  return win
}

function wireIpc(): void {
  ipcMain.handle('host:plugins:list', () => pluginListPayload())
  ipcMain.handle('host:plugins:enabled:set', (_event, pluginId: string, enabled: boolean) => setPluginEnabled(pluginId, enabled))
  ipcMain.handle('host:plugins:mode:set', (_event, pluginId: string, mode: 'resident' | 'alert' | 'off') => {
    if (mode !== 'resident' && mode !== 'alert' && mode !== 'off') return { ok: false, error: '未知的上岛方式' }
    return setPluginMode(pluginId, mode)
  })
  // 工具按钮：宿主只转发 toolId/actionId，插件执行后自己推新数据（island.tools.set）。
  ipcMain.handle('host:plugins:tool:run', async (_event, pluginId: string, toolId: string, actionId: string) => {
    const plugin = pluginManager?.get(pluginId)
    if (!plugin) return { ok: false, error: '插件未加载' }
    if (!pluginEnabled(pluginId)) return { ok: false, error: '插件已关闭，先打开插件' }
    const tool = plugin.manifest.tools?.find(item => item.id === toolId)
    const action = tool?.actions?.find(item => item.id === actionId)
    if (!tool || !action) return { ok: false, error: '工具或动作不存在' }
    let delivered = false
    try {
      if (viewManager) {
        await viewManager.ensure(plugin)
        viewManager.sendToPlugin(pluginId, 'host:tool-action', { toolId, actionId })
        delivered = true
      }
    } catch { /* 视图加载失败时继续尝试面板 */ }
    if (pluginPanel?.pluginId === pluginId && !pluginPanel.view.webContents.isDestroyed()) {
      pluginPanel.view.webContents.send('host:tool-action', { toolId, actionId })
      delivered = true
    }
    pluginLogger?.append(pluginId, 'info', `工具动作 ${tool.id}/${actionId}${delivered ? ' 已发送' : ' 未送达（没有运行视图）'}`)
    return delivered ? { ok: true } : { ok: false, error: '插件当前没有运行视图，先打开插件或重试' }
  })
  // 在资源管理器中定位插件目录。
  ipcMain.handle('host:plugins:reveal', (_event, pluginId: string) => {
    const plugin = pluginManager?.get(pluginId)
    if (!plugin) return { ok: false, error: '插件未加载' }
    shell.showItemInFolder(path.join(plugin.rootDir, 'plugin.json'))
    return { ok: true }
  })
  ipcMain.handle('host:plugins:open-dir', async () => {
    const directory = path.join(app.getPath('userData'), 'plugins')
    fs.mkdirSync(directory, { recursive: true })
    const error = await shell.openPath(directory)
    return error ? { ok: false, error } : { ok: true }
  })
  ipcMain.handle('host:logs:open-dir', async () => {
    const directory = path.join(app.getPath('userData'), 'island-plugins', 'logs')
    fs.mkdirSync(directory, { recursive: true })
    const error = await shell.openPath(directory)
    return error ? { ok: false, error } : { ok: true }
  })
  // 发现阶段的问题（以前是静默跳过）：控制台要能告诉作者"为什么没加载"。
  ipcMain.handle('host:plugins:issues', () => pluginIssues())
  ipcMain.handle('host:plugins:logs', (_event, pluginId: string) => ({ ok: true, lines: pluginLogger?.tail(pluginId) ?? [] }))
  ipcMain.handle('host:plugins:logs:clear', (_event, pluginId: string) => { pluginLogger?.clear(pluginId); return { ok: true } })
  // 说明页里的外链：只放行 https 和 Windows 设置页，别的一律拒绝。
  ipcMain.handle('settings:open-external', (_event, url: unknown) => {
    const text = String(url ?? '')
    let parsed: URL
    try { parsed = new URL(text) } catch { return { ok: false, error: '链接格式不正确' } }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'ms-settings:') return { ok: false, error: '只允许打开 https 或系统设置链接' }
    void shell.openExternal(text)
    return { ok: true }
  })
  ipcMain.handle('host:plugins:reload', async (_event, pluginId: string) => {
    if (!pluginManager?.has(pluginId)) return { ok: false, error: '插件未加载' }
    await reloadPlugin(pluginId, pluginManager.sourceOf(pluginId) ? 'source' : 'installed')
    return { ok: true }
  })
  // 插件设置面板：控制台「插件」页的「面板」按钮；关闭由面板页自己发 panel:close。
  ipcMain.handle('settings:plugin-panel', (_event, pluginId: string) => openPluginPanel(pluginId))
  ipcMain.on('panel:close', (event) => { if (pluginPanel && pluginPanel.view.webContents === event.sender) closePluginPanel() })
  ipcMain.handle('host:state:get', () => islandState.value)
  ipcMain.handle('host:plugins:install', async (_event, directory: string) => {
    try {
      const plugin = pluginManager!.installDirectory(directory)
      pluginLogger?.append(plugin.manifest.id, 'info', `已安装 v${plugin.manifest.version}，源码目录 ${directory}`)
      backgroundManager?.start(plugin)
      startWatching()
      await showCompact()
      sendHost('host:plugins-changed', plugins().map(item => item.manifest))
      return { ok: true, plugin: plugin.manifest }
    } catch (error) { return { ok: false, error: String(error) } }
  })
  ipcMain.handle('host:plugins:uninstall', async (_event, pluginId: string) => {
    try {
      if (!pluginManager?.has(pluginId)) return { ok: false, error: '插件未加载' }
      arbiter.interrupt()
      if (pluginPanel?.pluginId === pluginId) closePluginPanel()
      clearPluginTools(pluginId)
      backgroundManager?.stop(pluginId); viewManager?.destroy(pluginId); pluginManager!.uninstall(pluginId); storage?.remove(pluginId)
      islandSettings.pluginOrder = pruneOrder(islandSettings.pluginOrder, plugins().map(item => item.manifest.id))
      saveIslandSettings()
      startWatching()
      await showCompact()
      sendHost('host:plugins-changed', plugins().map(item => item.manifest))
      return { ok: true }
    } catch (error) { return { ok: false, error: String(error) } }
  })
  ipcMain.handle('plugin:settings:get', (_event, pluginId: string) => pluginManager?.has(pluginId) ? ({ values: pluginSettingsValues(pluginId), schema: pluginManager.get(pluginId)?.manifest.settings ?? null }) : ({ values: {}, schema: null }))
  ipcMain.handle('plugin:settings:set', (_event, pluginId: string, patch: Record<string, unknown>) => pluginManager?.has(pluginId) ? ({ values: savePluginSettings(pluginId, patch ?? {}) }) : ({ values: {} }))
  ipcMain.handle('host:plugins:settings', (_event, pluginId: string) => pluginManager?.has(pluginId) ? ({ ok: true, values: pluginSettingsValues(pluginId), schema: pluginManager.get(pluginId)?.manifest.settings ?? null }) : ({ ok: false, error: '插件未加载' }))
  ipcMain.handle('host:plugins:settings:set', (_event, pluginId: string, patch: Record<string, unknown>) => {
    if (!pluginManager?.has(pluginId)) return { ok: false, error: '插件未加载' }
    const values = savePluginSettings(pluginId, patch ?? {})
    const target = settingsWindow
    if (target && !target.isDestroyed()) target.webContents.send('settings:plugin-values', { pluginId, values })
    return { ok: true, values }
  })
  ipcMain.handle('plugin:storage:get', (_event, pluginId: string, key: string) => pluginManager?.has(pluginId) ? storage?.get(pluginId, key) : undefined)
  ipcMain.handle('plugin:storage:set', (_event, pluginId: string, key: string, value: unknown) => { if (!pluginManager?.has(pluginId)) return { ok: false }; storage?.set(pluginId, key, value); return { ok: true } })
  // 插件主动握手：它的脚本可能早于宿主推送 host:hello 运行。
  ipcMain.handle('plugin:hello', event => viewManager?.helloFor(event.sender) ?? null)

  registerNotificationIpc({
    get settingsWindow() { return settingsWindow },
    get viewManager() { return viewManager },
    get notificationView() { return notificationView },
    get notificationModule() { return notificationModule },
    get notificationHistoryWindow() { return notificationHistoryWindow },
    get clearConfirmReply() { return clearConfirmReply },
    pluginSettingsValues, saveNotificationSettings, showClearConfirm, createNotificationHistoryWindow, testLevel
  })
  // 插件自己的日志（island.log.* / 页面未捕获异常）。
  ipcMain.on('plugin:log', (_event, pluginId: string, level: string, message: unknown) => {
    if (typeof pluginId !== 'string') return
    pluginLogger?.append(pluginId, level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info', message)
  })
  ipcMain.on('host:command', (_event, pluginId: string, command: string, args: unknown[] = []) => handlePluginCommand(pluginId, command, args))
  ipcMain.on('host:event', (_event, pluginId: string, name: string, payload: unknown) => emitPluginEvent(pluginId, name, payload))
  ipcMain.on('plugin:mode-ready', (event, pluginId: unknown, mode: unknown) => {
    if (typeof pluginId !== 'string' || (mode !== 'small' && mode !== 'medium' && mode !== 'large')) return
    const sender = event.sender
    const hello = viewManager?.helloFor(sender) as { pluginId?: string } | null
    if (hello?.pluginId !== pluginId) return
    viewManager?.modeReady(pluginId, mode)
  })
  ipcMain.on('host:animation-frame', (event, frame: { width?: number; height?: number; top?: number; radius?: number }) => {
    if (event.sender !== mainWindow?.webContents) return
    if (![frame.width, frame.height, frame.top, frame.radius].every(value => Number.isFinite(value))) return
    updatePluginAnimationFrame({ width: Number(frame.width), height: Number(frame.height), top: Number(frame.top), radius: Number(frame.radius) })
  })

  registerSettingsIpc({
    controller: settingsController,
    snapshot: () => ({ ...publicIslandSettings(), appVersion: app.getVersion(), plugins: plugins().map(item => item.manifest) }),
    updateStatus: () => ({
      ...(updateChecker.status ?? { currentVersion: app.getVersion(), checkedAt: 0 }),
      checkUpdatesOnLaunch: islandSettings.checkUpdatesOnLaunch,
    }),
    checkUpdates: () => checkForUpdates(true),
  })
  ipcMain.handle('console:open', (_event, kind: 'settings', tab?: string) => {
    if (kind === 'settings') createSettingsWindow(tab).show()
    return { ok: true }
  })
  ipcMain.on('console:close', event => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })
  ipcMain.on('workbench:exit', event => {
    if (workbenchView?.webContents === event.sender) void showCompact()
    else BrowserWindow.fromWebContents(event.sender)?.close()
  })
  registerWorkbenchIpc({
    get workbenchView() { return workbenchView },
    get activeWorkbenchId() { return activeWorkbenchId },
    get workbenchManager() { return workbenchManager },
    get storage() { return storage },
    get workbenchLaidOutOnce() { return workbenchLaidOutOnce },
    get pluginLogger() { return pluginLogger },
    workbenchGuard, workbenchCapabilities, workbenchSettingsValues, saveWorkbenchSettings, consoleVisible, workbenchStorageId, workbenchSize, applyWorkbenchSize, enterCustomMode, workbenchLogId, readShortcuts, writeShortcuts
  })
  // ---------------------------------------------------------------- 工作台管理（控制台「工作台」页用）
  ipcMain.handle('host:workbenches:list', () => ({ ok: true, trustNotice: WORKBENCH_TRUST_NOTICE, workbenches: workbenchListPayload(), issues: workbenchManager?.issues() ?? [] }))
  ipcMain.handle('host:workbenches:activate', (_event, id: string) => activateWorkbench(id))
  ipcMain.handle('host:workbenches:acknowledge', (_event, id: string, capabilities: string[]) => acknowledgeWorkbench(id, Array.isArray(capabilities) ? capabilities : []))
  // 工作台参数：和插件同构，宿主在管理页渲染表单，页面用 window.workbench.settings 读同一份。
  ipcMain.handle('host:workbenches:settings', (_event, id: string) => ({ ok: true, values: workbenchSettingsValues(id), schema: workbenchManager?.get(id)?.manifest.settings ?? null }))
  ipcMain.handle('host:workbenches:settings:set', (_event, id: string, patch: Record<string, unknown>) => ({ ok: true, values: saveWorkbenchSettings(id, patch ?? {}) }))
  // 导出工作台包：和插件共用打包实现（内置那个随宿主分发，不给导出）。
  ipcMain.handle('host:workbenches:export-package', async (_event, id: string) => {
    const descriptor = workbenchManager?.get(id)
    if (!descriptor) return { ok: false, error: '工作台不存在' }
    const options = {
      title: '导出工作台包',
      defaultPath: path.join(app.getPath('downloads'), `${descriptor.manifest.id}-${descriptor.manifest.version}.islandplugin`),
      filters: [{ name: '灵动岛插件包', extensions: ['islandplugin'] }],
    }
    const picked = settingsWindow && !settingsWindow.isDestroyed()
      ? await dialog.showSaveDialog(settingsWindow, options)
      : await dialog.showSaveDialog(options)
    if (picked.canceled || !picked.filePath) return { ok: false, canceled: true }
    return await exportWorkbenchPackage(id, picked.filePath)
  })
  // 从插件包安装：包内是 workbench.json 就装成控制台，是 plugin.json 就装成插件。
  ipcMain.handle('host:workbenches:import-package', async () => {
    const picked = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: '灵动岛插件包', extensions: ['islandplugin', 'zip'] }] })
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true }
    try {
      const installed = await installPackage(picked.filePaths[0])
      return { ok: true, ...installed }
    } catch (error) { return { ok: false, error: String((error as Error)?.message ?? error) } }
  })
  /**
   * 重载工作台：有开发目录就先同步一次（和插件热重载一致），再重新读清单 ——
   * 清单可能被改过（能力声明变了），所以重载后要按新声明刷新授权集。
   * 正在用的那个还要把视图重新加载，否则用户看不到改动。
   */
  ipcMain.handle('host:workbenches:reload', async (_event, id: string) => {
    if (!workbenchManager?.get(id)) return { ok: false, error: '工作台不存在' }
    if (workbenchManager.sourceOf(id)) workbenchManager.syncFromSource(id)
    workbenchManager.discover()
    const fresh = workbenchManager.get(id)
    if (!fresh) return { ok: false, error: '重载后找不到这个工作台（workbench.json 可能被改坏了）' }
    if (islandSettings.activeWorkbench === id && workbenchView && !workbenchView.webContents.isDestroyed()) {
      applyWorkbenchGrant(fresh)
      loadedWorkbenchId = fresh.manifest.id
      await loadWorkbenchEntry(workbenchView, fresh)
    }
    sendHost('host:workbenches-changed', workbenchListPayload())
    return { ok: true, capabilities: fresh.capabilities }
  })
  ipcMain.handle('host:workbenches:install', async (_event, directory: string) => {    try {
      const descriptor = workbenchManager!.installDirectory(directory)
      pluginLogger?.append('_host', 'info', `已安装工作台「${descriptor.manifest.name}」（${descriptor.manifest.id}）`)
      sendHost('host:workbenches-changed', workbenchListPayload())
      return { ok: true, workbench: { id: descriptor.manifest.id, name: descriptor.manifest.name, version: descriptor.manifest.version, capabilities: descriptor.capabilities } }
    } catch (error) { return { ok: false, error: String((error as Error)?.message ?? error) } }
  })
  ipcMain.handle('host:workbenches:uninstall', (_event, id: string) => {
    try {
      workbenchManager!.uninstall(id)
      // 卸掉的正是当前启用的那个 → 回落内置，**并且立刻把视图换过去**。
      // 只改设置不换视图的话，界面还停在已被删除的页面上，下一次切换还可能被它拖累。
      if (islandSettings.activeWorkbench === id) {
        setActiveWorkbench(BUILTIN_WORKBENCH_ID, [])
        islandSettings.activeWorkbench = BUILTIN_WORKBENCH_ID
        saveIslandSettings()
        loadedWorkbenchId = null
        if (consoleVisible()) void enterCustomMode()
      }
      const grants = { ...islandSettings.workbenchGrants }
      delete grants[id]
      islandSettings.workbenchGrants = grants
      saveIslandSettings()
      sendHost('host:workbenches-changed', workbenchListPayload())
      return { ok: true }
    } catch (error) { return { ok: false, error: String((error as Error)?.message ?? error) } }
  })

  ipcMain.handle('plugins:pick-directory', async () => { const result = await dialog.showOpenDialog({ properties: ['openDirectory'] }); return result.canceled ? null : result.filePaths[0] })
  ipcMain.handle('plugins:install', async (_event, directory: string) => {
    try {
      const plugin = pluginManager!.installDirectory(directory)
      backgroundManager?.start(plugin)
      await showCompact()
      sendHost('host:plugins-changed', plugins().map(item => item.manifest))
      return { ok: true, plugin: plugin.manifest }
    } catch (error) { return { ok: false, error: String(error) } }
  })
  ipcMain.handle('plugins:pick-package', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: '灵动岛插件包', extensions: ['islandplugin', 'zip'] }] })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('plugins:install-package', async (_event, filePath: string) => {
    try {
      // 包内清单决定装成插件还是控制台 —— 这一个按钮两种都能装。
      const installed = await installPackage(filePath)
      return { ok: true, kind: installed.kind, plugin: { id: installed.id, name: installed.name, version: installed.version }, capabilities: installed.capabilities }
    } catch (error) { return { ok: false, error: String(error) } }
  })
  // 导出插件包：宿主自己打包，不依赖插件目录里有没有 pack.ps1。
  ipcMain.handle('plugins:export-package', async (_event, pluginId: string) => {
    const plugin = pluginManager?.get(pluginId)
    if (!plugin) return { ok: false, error: '插件未加载' }
    const options = {
      title: '导出插件包',
      defaultPath: path.join(app.getPath('downloads'), `${plugin.manifest.id}-${plugin.manifest.version}.islandplugin`),
      filters: [{ name: '灵动岛插件包', extensions: ['islandplugin'] }],
    }
    const picked = settingsWindow && !settingsWindow.isDestroyed()
      ? await dialog.showSaveDialog(settingsWindow, options)
      : await dialog.showSaveDialog(options)
    if (picked.canceled || !picked.filePath) return { ok: false, canceled: true }
    return await exportPluginPackage(pluginId, picked.filePath)
  })
  // 把"生成 Skill 包"导出给用户：解压进本地 AI（Claude Code 等）的 skills 目录，
  // 本地 AI 读 SKILL.md 就能按规范生成插件或工作台。kind 决定导出哪份规范。
  ipcMain.handle('skill:download', async (_event, kind: string) => {
    const skillId = kind === 'workbench' ? 'island-workbench' : 'island-plugin'
    const skillDir = path.join(appRoot(), 'skills', skillId)
    if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) return { ok: false, error: `Skill 包源目录不存在（skills/${skillId}/SKILL.md）` }
    const picked = await dialog.showSaveDialog({
      title: kind === 'workbench' ? '保存工作台生成 Skill 包' : '保存插件生成 Skill 包',
      defaultPath: `${skillId}-skill.zip`,
      filters: [{ name: 'Skill 包', extensions: ['zip'] }],
    })
    if (picked.canceled || !picked.filePath) return { ok: false, canceled: true }
    try {
      const bytes = zipDirectory(skillDir, picked.filePath, { skipDir: name => name.startsWith('.') })
      pluginLogger?.append('_host', 'info', `已导出生成 Skill 包（${skillId}）：${picked.filePath}（${Math.round(bytes / 1024)} KB）`)
      return { ok: true, path: picked.filePath, bytes }
    } catch (error) {
      try { fs.rmSync(picked.filePath, { force: true }) } catch { /* 忽略 */ }
      return { ok: false, error: `打包失败：${String((error as Error)?.message ?? error)}` }
    }
  })
  ipcMain.on('host:open-workbench', () => { void enterCustomMode() })
  ipcMain.on('host:open-settings', () => { createSettingsWindow().show() })
}

// F11 belongs to the browser shell for web pages; allowing Chromium to handle
// it inside the island can fullscreen one renderer while native child views and
// the host capsule keep their window-relative geometry.
app.on('web-contents-created', (_event, contents) => {
  contents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') event.preventDefault()
  })
})

app.whenReady().then(async () => {
  // Windows 靠 AppUserModelId 认任务栏图标与分组；不设的话任务栏显示的是 Electron 默认图标。
  app.setAppUserModelId('com.activity-island.host')
  const userRoot = path.join(app.getPath('userData'), 'plugins')
  notificationView = notificationViewDescriptor()
  pluginManager = new PluginManager([userRoot], userRoot, new Set([BUILTIN_NOTIFICATIONS_ID]))
  const discovered = pluginManager.discover()
  storage = new PluginStorage(path.join(app.getPath('userData'), 'plugin-data'))
  pluginLogger = new PluginLogger(path.join(app.getPath('userData'), 'island-plugins', 'logs'))
  pluginWatcher = new PluginWatcher(event => { void reloadPlugin(event.id, event.origin) })
  // 工作台：**独立目录**。插件的任何路径都看不到它们，所以"不是插件"是结构性事实，
  // 不需要在 orderedPlugins / mini 条 / presence 里到处加过滤。
  workbenchManager = new WorkbenchManager(
    path.join(app.getPath('userData'), 'workbenches'),
    path.join(appRoot(), 'console-apps', 'workbench'),
  )
  workbenchManager.discover()
  // 后台脚本的 stdout / runtime:* 都是"发给这个插件自己"的，必须也投递到它的页面。
  backgroundManager = new PluginBackgroundManager(
    (id, name, payload) => emitPluginEvent(id, name, payload, { toSelf: true }),
    id => pluginSettingsValues(id),
  )
  settingsStore.load()
  // 登录项可能因为换安装路径/重装而失效：设置里开着就重新对齐一次。
  if (islandSettings.launchAtLogin) applyLaunchAtLogin(true)
  // 用户排序里丢掉已卸载的插件，避免顺序表无限增长。
  const hadLegacyNotificationPlugin = islandSettings.disabledPlugins.includes(BUILTIN_NOTIFICATIONS_ID)
    || BUILTIN_NOTIFICATIONS_ID in islandSettings.pluginModes || islandSettings.pluginOrder.includes(BUILTIN_NOTIFICATIONS_ID)
  islandSettings.pluginOrder = pruneOrder(islandSettings.pluginOrder, discovered.map(item => item.manifest.id))
  islandSettings.disabledPlugins = islandSettings.disabledPlugins.filter(id => discovered.some(item => item.manifest.id === id))
  islandSettings.pluginModes = Object.fromEntries(
    Object.entries(islandSettings.pluginModes).filter(([id]) => discovered.some(item => item.manifest.id === id)),
  )
  if (hadLegacyNotificationPlugin) saveIslandSettings()
  // 旧版本没有"上岛方式"：升级时先把已有插件默认成常驻，保持原来的 mini 条行为。
  // 之后新装的插件才按清单 resident 默认（false = 仅提醒）。
  if (!islandSettings.pluginModesMigrated) {
    for (const item of discovered) {
      if (!pluginSupportsResident(item)) continue
      if (!islandSettings.pluginModes[item.manifest.id]) islandSettings.pluginModes[item.manifest.id] = 'resident'
    }
    islandSettings.pluginModesMigrated = true
    saveIslandSettings()
  }
  // 只保留还存在的已装工作台；内置始终放行全部能力（它随宿主分发）。
  islandSettings.workbenchGrants = Object.fromEntries(
    Object.entries(islandSettings.workbenchGrants).filter(([id]) => id === BUILTIN_WORKBENCH_ID || (workbenchManager?.has(id) ?? false)),
  )
  if (!workbenchManager?.has(islandSettings.activeWorkbench)) {
    if (islandSettings.activeWorkbench !== BUILTIN_WORKBENCH_ID) {
      pluginLogger?.append('_host', 'warn', `启动时找不到活动工作台「${islandSettings.activeWorkbench}」，回落到内置工作台`)
    }
    islandSettings.activeWorkbench = BUILTIN_WORKBENCH_ID
    saveIslandSettings()
  }
  { const descriptor = resolveActiveWorkbench(); applyWorkbenchGrant(descriptor) }
  mainWindow = createHostWindow()
  islandLayout = new IslandLayoutManager(mainWindow)
  islandLayout.apply(islandLayout.center(WINDOW_SIZE.width, WINDOW_SIZE.height, 0))
  mainWindow.webContents.on('did-finish-load', () => { if (hostLayoutState.mode !== 'idle' || hostLayoutState.width !== SMALL_DEFAULT.width) sendHost('host:layout', hostLayoutState); sendAlert(currentAlertLevel) })
  mainWindow.setIgnoreMouseEvents(true, { forward: true })
  mainWindow.on('move', updateHitTest); mainWindow.on('resize', updateHitTest)
  viewManager = new PluginViewManager(mainWindow, {
    onEvent: emitPluginEvent,
    onContextMenu: () => { void enterCustomMode() },
  })
  viewManager.setHostIdentity({ contractVersion: CONTRACT_VERSION, hostVersion: app.getVersion(), hostName: 'Activity Island', capabilities: HOST_CAPABILITIES })
  viewManager.setDeviceScaleFactor(screen.getPrimaryDisplay().scaleFactor)
  wireIpc()
  tray = createTray({
    iconPath: assetFile('tray.png'),
    log: (level, message) => pluginLogger?.append('_host', level, message),
    openSettings: () => { createSettingsWindow().show() },
    quit: () => { quitRequested = true; closeAppWindows(); app.quit() },
  })
  installTransferIpc()
  transferService = new LocalSendService({
    baseDir: path.join(app.getPath('userData'), 'transfers'),
    saveDirectory: path.join(app.getPath('downloads'), 'Activity Island'),
  })
  transferService.on('change', snapshot => {
    if (transferView && !transferView.webContents.isDestroyed()) transferView.webContents.send('transfers:change', snapshot)
    if (!transferPanelOpen && !transferDragging && ['idle', 'compact'].includes(islandState.value.mode)) {
      const wasVisible = transferProgressVisible
      if (!showTransferProgress() && wasVisible) void showRest()
    }
  })
  transferService.on('offer', () => { void openTransferPanel() })
  void transferService.start()
  // 内置通知能力：Windows 通知接管 + 本地触发接口，随应用启动（视图加载后即可收到事件）。
  const listenerScript = app.isPackaged
    ? path.join(process.resourcesPath ?? '', 'notifications', 'listener.ps1')
    : path.join(appRoot(), 'resources', 'notifications', 'listener.ps1')
  const listenerExe = app.isPackaged
    ? path.join(process.resourcesPath ?? '', 'notifications', 'notify-listener.exe')
    : developmentListenerExe()
  const clearScript = app.isPackaged
    ? path.join(process.resourcesPath ?? '', 'notifications', 'clear.ps1')
    : path.join(appRoot(), 'resources', 'notifications', 'clear.ps1')
  notificationModule = new NotificationModule({
    baseDir: notificationHistoryFile(),
    listenerScript,
    listenerExe,
    clearScript,
    emit: emitNotificationEvent,
    log: (level, message) => pluginLogger?.append(BUILTIN_NOTIFICATIONS_ID, level, message),
    onStatusChange: () => refreshNotificationTrayHint(),
  })
  void notificationModule.start().then(() => {
    // 用用户保存的设置覆盖默认策略（管道启动后立即生效）。
    return notificationModule?.applySettings(pluginSettingsValues(BUILTIN_NOTIFICATIONS_ID))
  })
  // 仅提醒模块不会被 warmPluginViews 预热：这里主动加载一次视图，
  // 让首条通知就能立刻触发提醒，也避免提醒事件发给未加载的视图。
  const notifDescriptor = notificationView
  if (notifDescriptor) void viewManager.ensure(notifDescriptor)
  // 启动时后台检查一次更新：不拦启动、不弹窗，结果留给「关于」页。
  if (islandSettings.checkUpdatesOnLaunch) setTimeout(() => { void checkForUpdates(false) }, 5000)
  hitPoll = setInterval(updateHitTest, 20)
  fullscreenMonitor = new ForegroundFullscreenMonitor(mainWindow, updateHostVisibilityForFullscreen)
  fullscreenMonitor.start()
  for (const plugin of discovered) if (pluginEnabled(plugin.manifest.id)) backgroundManager.start(plugin)
  if (islandSettings.idleMode === 'collapsed') void warmPluginViews()
  // 启动时的静止状态同样取决于"空闲表现"：收起模式直接就是顶部触发条。
  await showRest()
  // 盯住开发目录/安装目录：改文件就自动同步 + 热重载。
  startWatching()
  if (pluginManager?.issues().length) for (const issue of pluginManager.issues()) pluginLogger?.append(issue.id ?? 'unknown', 'warn', `未加载 ${issue.directory}：${issue.reason}`)
  // Warm the console once the island is on screen, so the first right-click
  // reveals an already-loaded page instead of waiting out a cold load.
  void ensureWorkbenchView()
})

app.on('before-quit', () => {
  if (!quitRequested) quitRequested = true
  // 停掉监听进程与本地接口，并把历史立即落盘（延迟写入可能在退出时来不及执行）。
  void notificationModule?.stop()
  void transferService?.stop()
  closeAppWindows()
})
app.on('window-all-closed', () => {})
