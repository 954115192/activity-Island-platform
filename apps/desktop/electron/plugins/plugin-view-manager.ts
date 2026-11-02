import { BrowserWindow, View, WebContentsView } from 'electron'
import path from 'node:path'
import type { PluginDescriptor, PluginMode } from './types'

export interface PluginViewCallbacks {
  onEvent: (pluginId: string, name: string, payload: unknown) => void
  onContextMenu?: (pluginId: string) => void
}
export type ViewBounds = { x: number; y: number; width: number; height: number }

/** 插件在岛上的可见性原因：mini 段、被展开、没显示、岛整体被遮住。 */
export type PluginVisibilityReason = 'mini' | 'expanded' | 'hidden' | 'obscured'

type PluginVisibility = { visible: boolean; reason: PluginVisibilityReason; rendering: boolean }

export interface ContractTheme {
  surface: string
  ink: string
  inkDim: string
  accent: string
  /** 灵动岛当前实际生效的圆角（已经被短边压过，不是声明值）。 */
  radius: number
  gap: number
  font: string
  dark: boolean
}

export interface ContractMetrics {
  /** 宿主 mini 缩放设置。 */
  scale: number
  /** 该插件视图的 zoom 因子。 */
  zoom: number
  deviceScaleFactor: number
  /** 插件页面的 CSS 像素尺寸（= 原生 bounds / zoom）。 */
  width: number
  height: number
}

export interface ContractState {
  islandMode: 'idle' | 'compact' | 'expanded' | 'detail' | 'custom'
  activePluginId: string | null
  scale: number
}

export interface HostIdentity {
  contractVersion: number
  hostVersion: string
  hostName: string
  capabilities: string[]
  /** 插件 id → 该插件在 plugin.json 里声明的设置项（控制台表单与插件读取共用）。 */
  settings?: Record<string, unknown>
}

/** Native plugin pages with one animated clipping parent. */
export class PluginViewManager {
  private readonly views = new Map<string, WebContentsView>()
  private readonly pendingLoads = new Map<string, Promise<WebContentsView | null>>()
  private disposed = false
  private readonly modes = new Map<string, PluginMode>()
  private readonly zoomFactors = new Map<string, number>()
  private readonly bounds = new Map<string, ViewBounds>()
  private readonly viewport: View
  private viewportBounds = { x: 0, y: 0, width: 1, height: 1 }
  private viewportRadius = 0
  private workbench: WebContentsView | null = null
  private transferView: WebContentsView | null = null
  private transferStage: ViewBounds | null = null
  private workbenchStage: ViewBounds | null = null
  /** 非 null 时收起动画在跑：工作台视图随视口缩放（见 beginWorkbenchCollapse）。 */
  private workbenchCollapseStage: { width: number; height: number } | null = null
  private host: HostIdentity = { contractVersion: 2, hostVersion: '0.0.0', hostName: 'Activity Island', capabilities: [] }
  private deviceScaleFactor = 1
  private contractState: ContractState = { islandMode: 'idle', activePluginId: null, scale: 1 }
  private theme: ContractTheme | null = null
  private themeKey = ''
  private readonly shown = new Map<string, boolean>()
  private readonly sentVisibility = new Map<string, string>()
  private readonly sentMetrics = new Map<string, string>()
  private readonly pendingModeReady = new Map<string, PluginMode>()
  private readonly modeReadyWaiters = new Map<string, { mode: PluginMode; resolve: (ready: boolean) => void }>()

  constructor(private readonly window: BrowserWindow, private readonly callbacks: PluginViewCallbacks) {
    this.viewport = new View()
    this.viewport.setBackgroundColor('#00000000')
    this.viewport.setVisible(true)
    this.window.contentView.addChildView(this.viewport)
  }

  async ensure(plugin: PluginDescriptor): Promise<WebContentsView | null> {
    if (this.disposed || this.window.isDestroyed()) return null
    const id = plugin.manifest.id
    const pending = this.pendingLoads.get(id)
    if (pending) {
      const view = await pending
      if (this.disposed || this.window.isDestroyed()) return null
      return this.views.get(id) === view ? view : this.ensure(plugin)
    }
    const existing = this.views.get(id)
    if (existing) return existing
    const loading = this.loadPluginView(plugin)
    this.pendingLoads.set(id, loading)
    try {
      const view = await loading
      if (this.disposed || this.window.isDestroyed()) return null
      return this.views.get(id) === view ? view : this.ensure(plugin)
    } finally {
      if (this.pendingLoads.get(id) === loading) this.pendingLoads.delete(id)
    }
  }

  private async loadPluginView(plugin: PluginDescriptor): Promise<WebContentsView | null> {
    const id = plugin.manifest.id
    const view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'plugin-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    })
    // Keep the page transparent. The island's own black capsule is painted by
    // the host renderer underneath, so plugins do not have to declare a
    // background at all; whatever a plugin does paint stays inside the island
    // because every plugin view is clipped with the island's corner radius.
    view.setBackgroundColor('#00000000')
    view.setVisible(false)
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    view.webContents.on('will-navigate', event => event.preventDefault())
    view.webContents.on('context-menu', event => {
      event.preventDefault()
      this.callbacks.onContextMenu?.(id)
    })
    // 插件 → 宿主的命令与事件走 ipcMain 上的 host:command / host:event（见 main.ts），
    // 这里只保留渲染进程消失的上报。
    view.webContents.on('render-process-gone', (_event, details) => {
      this.callbacks.onEvent(id, 'runtime:error', { reason: 'render-process-gone', detail: details?.reason ?? 'unknown', exitCode: details?.exitCode ?? null })
      // 崩掉的视图留在表里就再也不会被重建（ensure 看到它还在就直接返回），插件会永远停在崩溃画面上 —— 丢掉它，下一次 ensure / 热重载会重建。
      if (this.views.get(id)?.webContents === view.webContents) this.destroy(id)
    })
    view.webContents.on('did-fail-load', (_event, code, description) => this.callbacks.onEvent(id, 'runtime:error', { reason: 'did-fail-load', code, description }))
    view.webContents.on('preload-error', (_event, preloadPath, error) => this.callbacks.onEvent(id, 'runtime:error', { reason: 'preload-error', preloadPath, message: String(error) }))
    // 页面里的未捕获异常会以 error 级 console 消息出现；隔离世界里拿不到主世界的
    // window.onerror，所以宿主这层来兜底写日志。
    view.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      if (level < 3) return
      const text = String(message).slice(0, 500)
      this.callbacks.onEvent(id, 'runtime:log', { level: 'error', message: `[页面错误] ${text} @ ${sourceId}:${line}` })
    })
    this.viewport.addChildView(view)
    this.views.set(id, view)
    this.shown.set(id, false)
    await view.webContents.loadFile(plugin.entryPath, { query: { pluginId: id, mode: 'small' } })
      .catch(error => { if (!this.disposed) this.callbacks.onEvent(id, 'runtime:error', { reason: 'load-failed', message: String(error) }) })
    if (this.disposed || this.window.isDestroyed() || view.webContents.isDestroyed() || this.views.get(id) !== view) return null
    // 页面加载完就把契约首包推给它：插件脚本可能早于这次推送运行，所以 preload
    // 还提供 plugin:hello 反向握手（见 helloFor）。
    this.sendHello(id)
    this.publishContract(this.contractState)
    return view
  }

  list(): string[] { return [...this.views.keys()] }

  /** 是否已经有活着的视图（热重载销毁后要能重新创建）。 */
  has(pluginId: string): boolean { return this.views.has(pluginId) }

  setHostIdentity(host: Partial<HostIdentity>): void {
    this.host = { ...this.host, ...host }
    this.theme = null
  }

  setDeviceScaleFactor(factor: number): void {
    if (!Number.isFinite(factor) || factor <= 0) return
    this.deviceScaleFactor = factor
  }

  sendHello(pluginId: string): void {
    const view = this.views.get(pluginId)
    if (view && !view.webContents.isDestroyed()) view.webContents.send('host:hello', this.helloPayload(pluginId))
  }

  /** 意图回执（alert/focus 的裁决结果）或其它定向通知。 */
  sendIntent(pluginId: string, intent: unknown): void {
    this.sendToPlugin(pluginId, 'host:intent', intent)
  }

  /** 定向给某个插件发消息（设置同步等）。 */
  sendToPlugin(pluginId: string, channel: string, payload: unknown): void {
    const view = this.views.get(pluginId)
    if (view && !view.webContents.isDestroyed()) view.webContents.send(channel, payload)
  }

  /** 插件清单里的设置项声明（控制台表单与插件的 island.settings.schema() 共用）。 */
  settingsSchema(pluginId: string): unknown {
    return this.host.settings?.[pluginId] ?? null
  }

  setSettingsSchemas(schemas: Record<string, unknown>): void {
    this.host = { ...this.host, settings: schemas }
  }

  /** 插件主动握手：按 webContents 反查它自己的 hello 载荷。 */
  helloFor(sender: Electron.WebContents): unknown | null {
    for (const [id, view] of this.views) if (view.webContents === sender) return this.helloPayload(id)
    return null
  }

  /** 给非岛上视图（控制台里的插件设置面板）复用契约首包。 */
  helloPayloadFor(pluginId: string): Record<string, unknown> { return this.helloPayload(pluginId) }

  private helloPayload(pluginId: string): Record<string, unknown> {
    return {
      type: 'host:hello',
      pluginId,
      contractVersion: this.host.contractVersion,
      hostVersion: this.host.hostVersion,
      hostName: this.host.hostName,
      capabilities: [...this.host.capabilities],
      // 插件自己的设置项声明，让 island.settings.schema() 不用额外往返。
      settings: pluginId ? (this.host.settings?.[pluginId] ?? null) : null,
      // 优先用已经算过的主题：页面刚加载时布局可能还没量过，圆角会是 0。
      theme: this.theme ?? this.currentTheme(),
    }
  }

  private currentTheme(): ContractTheme {
    // 这些值必须与 console-apps/theme.css（唯一 token 源）一致 —— 插件拿不到那份 CSS，
    // 只能靠宿主注入；两边一漂移，插件就会和岛壳对不上色。
    return {
      surface: '#000000',
      ink: '#F4F4F5',
      inkDim: '#A1A1AA',
      accent: '#3B82F6',
      radius: this.effectiveRadius(),
      gap: 1,
      font: '"Segoe UI Variable", "Segoe UI", "MiSans", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
      dark: true,
    }
  }

  /**
   * 布局之后把契约状态推给插件：主题（全局，变了才发）、可见性、真实尺寸/缩放。
   * 每插件去重，动画期间不会每帧刷 IPC；插件据此暂停轮询、重算画布。
   */
  publishContract(state: ContractState): void {
    this.contractState = state
    const theme = this.currentTheme()
    const themeKey = JSON.stringify(theme)
    const themeChanged = !this.theme || this.themeKey !== themeKey
    if (themeChanged) {
      this.theme = theme
      this.themeKey = themeKey
    }
    for (const [id, view] of this.views) {
      if (view.webContents.isDestroyed()) continue
      if (themeChanged) view.webContents.send('host:theme', { type: 'host:theme', theme })
      const visibility = this.visibilityFor(id, state)
      const visibilityKey = `${visibility.visible}|${visibility.reason}|${visibility.rendering}`
      if (this.sentVisibility.get(id) !== visibilityKey) {
        this.sentVisibility.set(id, visibilityKey)
        view.webContents.send('host:visibility', { type: 'host:visibility', pluginId: id, ...visibility })
      }
      const metrics = this.metricsFor(id)
      const metricsKey = JSON.stringify(metrics)
      if (this.sentMetrics.get(id) !== metricsKey) {
        this.sentMetrics.set(id, metricsKey)
        view.webContents.send('host:metrics', { type: 'host:metrics', pluginId: id, ...metrics })
      }
    }
  }

  private visibilityFor(pluginId: string, state: ContractState): PluginVisibility {
    // 没有原生可见视图的插件（包括 setPresence(false) 后被摘掉的插件）不应
    // 因为整个岛处于 idle 就被错误地保活；否则它会继续跑 every/rAF。
    if (!this.shown.get(pluginId)) return { visible: false, reason: 'hidden', rendering: false }
    // idle 下原生视图被父级 1x1 裁剪，但页面继续渲染 small 内容，避免展开时
    // 先等 SDK 的 every/rAF 被唤醒再出首帧。visible 仍为 false，插件不会误以为
    // 自己已经显示在岛上；rendering 是宿主内部的保活信号。
    if (state.islandMode === 'idle') return { visible: false, reason: 'obscured', rendering: true }
    // 工作台会盖住整个岛，插件没有任何可见 surface，不应继续刷新。
    if (state.islandMode === 'custom') return { visible: false, reason: 'obscured', rendering: false }
    if (state.islandMode === 'expanded' || state.islandMode === 'detail') {
      const active = state.activePluginId === pluginId
      return { visible: active, reason: active ? 'expanded' : 'hidden', rendering: active }
    }
    return { visible: true, reason: 'mini', rendering: true }
  }

  private metricsFor(pluginId: string): ContractMetrics {
    const view = this.views.get(pluginId)
    const bounds = this.bounds.get(pluginId)
    // 用真实 zoom（而不是我们记的值）：origin 级共享的 zoom 可能被别的插件改掉。
    const zoom = view ? view.webContents.getZoomFactor() : (this.zoomFactors.get(pluginId) ?? 1)
    return {
      scale: this.contractState.scale,
      zoom,
      deviceScaleFactor: this.deviceScaleFactor,
      width: bounds ? Math.max(1, Math.round(bounds.width / zoom)) : 0,
      height: bounds ? Math.max(1, Math.round(bounds.height / zoom)) : 0,
    }
  }

  sendMode(pluginId: string, mode: PluginMode): void {
    const view = this.views.get(pluginId)
    if (!view || this.modes.get(pluginId) === mode) return
    this.modes.set(pluginId, mode)
    view.webContents.send('host:mode', { type: 'host:mode', mode, pluginId })
  }

  /**
   * 设置插件页面的 zoom。注意 Chromium 的 zoom 是**按 origin 共享并持久化**的：
   * 所有插件都是 file:// origin，任何一个插件的 zoom 都会改到其它插件，甚至跨启动
   * 残留。所以这里不做"值没变就跳过"的缓存——那会让被别的插件改过的 zoom 一直错下去。
   */
  setZoom(pluginId: string, factor: number): void {
    const view = this.views.get(pluginId)
    if (!view) return
    this.zoomFactors.set(pluginId, factor)
    if (Math.abs(view.webContents.getZoomFactor() - factor) > 0.0001) view.webContents.setZoomFactor(factor)
  }

  prepare(pluginId: string, mode: PluginMode, bounds: { x: number; y: number; width: number; height: number }, options: { preserveVisibility?: boolean; forceModeReady?: boolean } = {}): void {
    const view = this.views.get(pluginId)
    if (!view) return
    if (!options.preserveVisibility) {
      view.setVisible(false)
      this.shown.set(pluginId, false)
    }
    const previousMode = this.modes.get(pluginId)
    this.modes.set(pluginId, mode)
    // Small-mode transitions need the same acknowledgement as expanded modes.
    // Without it, a medium page can be shown again while its DOM is still
    // rendering the medium view inside the now-small clipping viewport.
    if (previousMode && (previousMode !== mode || options.forceModeReady)) this.pendingModeReady.set(pluginId, mode)
    this.setBounds(pluginId, bounds)
    view.webContents.send('host:mode', { type: 'host:mode', mode, pluginId })
  }

  isShown(pluginId: string): boolean { return this.shown.get(pluginId) === true }
  modeOf(pluginId: string): PluginMode | undefined { return this.modes.get(pluginId) }

  modeReady(pluginId: string, mode: PluginMode): void {
    if (this.pendingModeReady.get(pluginId) !== mode) return
    this.pendingModeReady.delete(pluginId)
    const waiter = this.modeReadyWaiters.get(pluginId)
    if (waiter?.mode === mode) {
      this.modeReadyWaiters.delete(pluginId)
      waiter.resolve(true)
    }
  }

  waitForModeReady(pluginId: string, mode: PluginMode, timeoutMs = 140): Promise<boolean> {
    if (this.modes.get(pluginId) !== mode) return Promise.resolve(false)
    if (!this.pendingModeReady.has(pluginId)) return Promise.resolve(true)
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        const waiter = this.modeReadyWaiters.get(pluginId)
        if (waiter?.mode === mode) this.modeReadyWaiters.delete(pluginId)
        if (this.pendingModeReady.get(pluginId) === mode) this.pendingModeReady.delete(pluginId)
        resolve(false)
      }, timeoutMs)
      this.modeReadyWaiters.set(pluginId, { mode, resolve: ready => { clearTimeout(timer); resolve(ready) } })
    })
  }

  /**
   * Move/resize the animated parent and re-clip every plugin page.
   *
   * `radius` is the island's CSS border radius. A `View`'s own border radius
   * only clips the view's own drawing: child `WebContentsView`s keep painting
   * their square corners through it (verified against Electron 33 on Windows),
   * which is why the radius is pushed down to each plugin view as well - the
   * plugin view is the surface that actually paints the page.
   */
  setViewport(bounds: { x: number; y: number; width: number; height: number }, radius = 0): void {
    const next = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(1, Math.round(bounds.width)),
      height: Math.max(1, Math.round(bounds.height)),
    }
    const nextRadius = Math.max(0, Math.round(radius))
    const changed = this.viewportBounds.x !== next.x || this.viewportBounds.y !== next.y || this.viewportBounds.width !== next.width || this.viewportBounds.height !== next.height || this.viewportRadius !== nextRadius
    if (!changed) return
    this.viewportBounds = next
    this.viewportRadius = nextRadius
    this.viewport.setBounds(next)
    if (this.transferView && this.transferStage) this.applyLocalBoundsTo(this.transferView, this.transferStage)
    // Redundant on Windows, but a platform whose compositor does honour parent
    // clipping still gets the animated capsule for free.
    this.viewport.setBorderRadius(this.effectiveRadius())
    for (const [id, content] of this.bounds) this.applyLocalBounds(id, content)
    if (this.workbench && this.workbenchStage) {
      if (this.workbenchCollapseStage) {
        this.workbench.setBounds({ x: 0, y: 0, width: next.width, height: next.height })
        this.workbench.setBorderRadius(this.effectiveRadius())
        const zoom = next.width / this.workbenchCollapseStage.width
        if (Number.isFinite(zoom) && zoom > 0) this.workbench.webContents.setZoomFactor(zoom)
      } else {
        this.applyLocalBoundsTo(this.workbench, this.workbenchStage)
      }
    }
  }

  /**
   * Host the console (workbench) viewport inside the same animated clipping
   * parent the plugin pages use. As a direct child of the window it was painted
   * at full size the instant it became visible, so the console popped in on top
   * of the still-small island instead of being uncovered by the island's spring.
   * Pass `null` to detach a dead view.
   */
  adoptTransfer(view: WebContentsView | null): void {
    if (this.transferView === view) return
    if (this.transferView && !this.window.isDestroyed()) this.viewport.removeChildView(this.transferView)
    this.transferView = view
    this.transferStage = null
    if (!view) return
    view.setVisible(false)
    this.viewport.addChildView(view)
  }

  setTransferStage(bounds: ViewBounds | null): void {
    this.transferStage = bounds
    if (!this.transferView) return
    if (bounds) this.applyLocalBoundsTo(this.transferView, bounds)
    this.transferView.setVisible(!!bounds)
  }

  adoptWorkbench(view: WebContentsView | null): void {
    if (this.workbench === view) return
    if (this.workbench) this.viewport.removeChildView(this.workbench)
    this.workbench = view
    this.workbenchStage = null
    if (!view) return
    view.setVisible(false)
    this.viewport.addChildView(view)
  }

  /**
   * Window-absolute target rect for the console, or `null` to hide it. Bounds
   * are applied against the current viewport, so every spring frame re-clips the
   * console exactly like a plugin page.
   */
  setWorkbenchStage(bounds: ViewBounds | null): void {
    const view = this.workbench
    if (!view || bounds === this.workbenchStage) return
    this.workbenchStage = bounds
    if (!bounds) { view.setVisible(false); return }
    this.applyLocalBoundsTo(view, bounds)
    view.setVisible(true)
  }

  /**
   * 收起动画期间的"缩进"模式：工作台视图不再保持全尺寸方形裁剪（父视图的圆角
   * 裁不到子视图，而它自己的圆角在远超视口的四角上 —— 收起时会看到一个方形黑块）。
   * 改为每帧把视图 bounds 收成当前视口（圆角 = 胶囊圆角），同时用 zoomFactor 把
   * 页面等比缩小：页面 CSS 视口恒为 zoom 前的舞台尺寸（宽向严格恒定），不发生重排。
   */
  beginWorkbenchCollapse(stage: { width: number; height: number }): void {
    if (!this.workbench) return
    this.workbenchCollapseStage = { width: Math.max(1, stage.width), height: Math.max(1, stage.height) }
  }

  /** 结束"缩进"模式：恢复全尺寸 bounds 与 zoom=1（重新打开控制台前必须回到这里）。 */
  endWorkbenchCollapse(): void {
    if (!this.workbenchCollapseStage) return
    this.workbenchCollapseStage = null
    if (this.workbench) {
      if (this.workbenchStage) this.applyLocalBoundsTo(this.workbench, this.workbenchStage)
      this.workbench.webContents.setZoomFactor(1)
    }
  }

  /**
   * Border radius the island outline really ends up with. CSS (and Electron's
   * native clip) scales a radius down once it exceeds half of a box side, so a
   * 38px tall island with `border-radius: 28px` is really rounded by 19px.
   */
  private effectiveRadius(): number {
    return Math.max(0, Math.min(this.viewportRadius, Math.floor(this.viewportBounds.width / 2), Math.floor(this.viewportBounds.height / 2)))
  }

  /**
   * Corner radius that keeps a plugin's square corners inside the island
   * outline. The island corner arc has radius `R`; a plugin inset by `i` from
   * the island edge may only be rounded by `R - i`, which is exactly the
   * largest quarter circle that still fits inside the island's corner
   * (tangent to it). Plugins that never reach a rounded edge stay square.
   *
   * Electron only exposes one radius for all four corners, so a plugin that
   * touches an island end gets that end's radius on every corner. That is
   * invisible while plugins stay transparent or black on the black island - the
   * documented default - and it never lets content escape the island.
   */
  private childRadius(bounds: { x: number; y: number; width: number; height: number }): number {
    const radius = this.effectiveRadius()
    if (radius <= 0) return 0
    const insetX = Math.max(0, Math.min(bounds.x, this.viewportBounds.width - (bounds.x + bounds.width)))
    const insetY = Math.max(0, Math.min(bounds.y, this.viewportBounds.height - (bounds.y + bounds.height)))
    return Math.max(0, radius - Math.max(insetX, insetY))
  }

  private applyLocalBounds(pluginId: string, bounds: ViewBounds): void {
    const view = this.views.get(pluginId)
    if (view) this.applyLocalBoundsTo(view, bounds)
  }

  private applyLocalBoundsTo(view: WebContentsView, bounds: ViewBounds): void {
    const local = {
      x: Math.round(bounds.x - this.viewportBounds.x),
      y: Math.round(bounds.y - this.viewportBounds.y),
      width: bounds.width,
      height: bounds.height,
    }
    view.setBounds(local)
    view.setBorderRadius(this.childRadius(local))
  }

  /**
   * 把事件广播给其它插件。
   * `toSelf` 用于"事件本来就属于这个插件"的场景（后台脚本的 stdout）：必须也发给它自己，
   * 否则插件永远收不到自己 resources/ 里脚本的输出。
   */
  broadcastEvent(name: string, payload: unknown, source?: string, options: { toSelf?: boolean } = {}): void {
    for (const [id, view] of this.views) {
      if (view.webContents.isDestroyed()) continue
      if (id === source && !options.toSelf) continue
      view.webContents.send('host:event', { name, payload })
    }
  }

  show(pluginId: string): void {
    const view = this.views.get(pluginId)
    if (!view) return
    if (this.pendingModeReady.has(pluginId)) return
    // 弹簧动画期间每帧都会走到这里：已可见就跳过，省掉每帧 × 每插件的原生调用
    if (this.shown.get(pluginId)) return
    view.setVisible(true)
    this.shown.set(pluginId, true)
  }

  hide(pluginId: string): void {
    const view = this.views.get(pluginId)
    if (!view) return
    view.setVisible(false)
    this.shown.set(pluginId, false)
  }

  setBounds(pluginId: string, nextBounds: ViewBounds): void {
    const view = this.views.get(pluginId)
    if (!view) return
    const previous = this.bounds.get(pluginId)
    if (previous && previous.x === nextBounds.x && previous.y === nextBounds.y && previous.width === nextBounds.width && previous.height === nextBounds.height) return
    this.bounds.set(pluginId, nextBounds)
    this.applyLocalBounds(pluginId, nextBounds)
  }

  destroy(pluginId: string): void {
    const view = this.views.get(pluginId)
    if (!view) return
    if (!this.window.isDestroyed()) this.viewport.removeChildView(view)
    if (!view.webContents.isDestroyed()) view.webContents.close()
    this.views.delete(pluginId)
    this.pendingLoads.delete(pluginId)
    this.modes.delete(pluginId)
    this.zoomFactors.delete(pluginId)
    this.bounds.delete(pluginId)
    this.shown.delete(pluginId)
    this.sentVisibility.delete(pluginId)
    this.sentMetrics.delete(pluginId)
    this.pendingModeReady.delete(pluginId)
    const waiter = this.modeReadyWaiters.get(pluginId)
    if (waiter) { this.modeReadyWaiters.delete(pluginId); waiter.resolve(false) }
  }

  /** Terminal shutdown: pending loads resolve without recreating or messaging views. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.destroyAll()
  }

  destroyAll(): void {
    for (const id of [...this.views.keys()]) this.destroy(id)
    this.adoptWorkbench(null)
  }
}
