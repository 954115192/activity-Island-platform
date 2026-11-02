import { createIslandTransitions } from './transitions'
import { createPluginCommands } from './plugin-commands'
import { createIslandPointer } from './pointer'
import type { BrowserWindow } from 'electron'
import { IntentArbiter, type AlertLevel } from './intent-arbiter'
import { IslandState } from './island-state'
import { IslandLayoutManager } from './layout-manager'
import { SMALL_DEFAULT, WINDOW_SIZE, pluginSize, pluginGeometry, compactLayout, compactLayoutWithQuickActions, type PluginPlacement, type AnimatedLayout } from './geometry'
import { createWorkbenchSize } from '../workbench/size'
import type { createWorkbenchView } from '../workbench/view'
import type { createWindowLayer } from '../window/window-layer'
import type { PluginViewManager } from '../plugins/plugin-view-manager'
import type { PluginLogger } from '../plugins/plugin-logger'
import type { PluginToolState } from '../plugins/tool-state'
import type { IslandMode, PluginMode, PluginDescriptor } from '../plugins/types'
import type { IslandSettings } from '../settings/store'
import type { SettingsLayoutChange } from '../settings/controller'
import type { EventBus } from '../events/event-bus'

interface IslandOptions {
  settings: IslandSettings
  events: EventBus
  host: {
    readonly window: BrowserWindow | null
    readonly views: PluginViewManager | null
    readonly logger: PluginLogger | null
    readonly layer: ReturnType<typeof createWindowLayer>
    send(channel: string, payload?: unknown): void
  }
  plugins: {
    hidden: Set<string>
    tools: PluginToolState
    ordered(): PluginDescriptor[]
    get(id: string): PluginDescriptor | undefined
    list(): PluginDescriptor[]
  }
  readonly workbench: ReturnType<typeof createWorkbenchView>
  transfers: {
    readonly dragging: boolean
    readonly open: boolean
    progressVisible: boolean
    hide(): void
    showProgress(): boolean
  }
  mediaKey(action: 'previous' | 'toggle' | 'next'): void
}

/** Owns island interaction, transition timers and the rendered/native layout state. */
export function createIslandController(options: IslandOptions) {
  let disposed = false

  /**
   * 收起动画期间的"延后切换"：中岛→mini 时先让收缩中的胶囊把旧内容裁掉，
   * 到位后才把插件切成 small 并显示 mini 内容（见 showCompact）。
   */
  let pendingMiniReveal: { ids: Set<string>; target: { layout: AnimatedLayout; placements: PluginPlacement[] }; timer: NodeJS.Timeout | null } | null = null

  const islandState = new IslandState()

  let islandLayout: IslandLayoutManager | null = null

  let hostLayoutState: { mode: IslandMode; pluginMode?: PluginMode; separators: number[]; collapsed?: boolean; clipPlugins?: boolean; showClock?: boolean; quickActions?: boolean; overflow?: number; chipX?: number | null; width: number; height: number; top: number; contentWidth?: number } = { mode: 'idle', separators: [], width: SMALL_DEFAULT.width, height: SMALL_DEFAULT.height, top: 8, contentWidth: SMALL_DEFAULT.width }

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
      void showRest(pointer.inside)
    },
    canAlert: () => islandState.value.mode === 'idle' || islandState.value.mode === 'compact',
    grantFocus: request => grantFocus(request),
    releaseFocus: () => { clearAlertCarry(); void showRest(pointer.inside) },
    sendIntent: (pluginId, message) => options.host.views?.sendIntent(pluginId, message),
  })

  const transitions = createIslandTransitions({
    canScheduleCollapse: () => !islandState.value.sticky && !islandState.value.pointerInside && !alertActive
      && (!options.plugins.ordered().length || options.settings.idleMode === 'collapsed'),
    canCollapse: () => !islandState.value.pointerInside && islandState.value.mode === 'compact',
    collapse: () => { void showIdle() },
    hideWorkbench,
  })
  const cancelCollapse = transitions.cancelCollapse
  const scheduleTransientCollapse = transitions.scheduleCollapse
  const deferWorkbenchHide = transitions.deferWorkbenchHide
  const cancelDeferredWorkbenchHide = transitions.cancelWorkbenchHide

  const pointer = createIslandPointer({
    get window() { return options.host.window },
    get layer() { return options.host.layer },
    get transferOpen() { return options.transfers.open },
    get dragging() { return options.transfers.dragging },
    get alertActive() { return alertActive },
    settings: options.settings, state: islandState, arbiter,
    send: options.host.send, cancelCollapse, scheduleTransientCollapse,
    showCompact, showIdle,
  })
  const updateHitTest = pointer.update
  const setHitRegion = pointer.setRegion
  const stageHitRegion = pointer.stageRegion

  function syncPluginViews(frame = animatedFrame): void {
    if (disposed) return
    if (!options.host.views) return
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
    options.host.views.setViewport(shell, clipFrame.radius)
    // The console grows out of the same shell instead of popping in at full size.
    options.host.views.setWorkbenchStage(workbenchStage)
    const activeIds = new Set(animatedLayout.placements.map(item => item.pluginId))
    for (const plugin of options.plugins.list()) {
      const placement = animatedLayout.placements.find(item => item.pluginId === plugin.manifest.id)
      // 收起动画期间：这些插件的视图保持原样（中岛尺寸/内容），让收缩中的胶囊裁掉它们，
      // 等动画到位后再由 applyPendingMiniReveal 切成 mini —— 别在这里提前动它们。
      if (pendingMiniReveal?.ids.has(plugin.manifest.id)) continue
      if (!placement) {
        // idle 下没有 placement 的插件也保持可见（1x1 裁剪负责藏住它们）；
        // 非 idle 模式才真正隐藏（中岛只留激活插件、工作台盖住全部）。
        if (!idle) options.host.views.hide(plugin.manifest.id)
        continue
      }
      options.host.views.setBounds(plugin.manifest.id, pluginGeometry(animatedLayout, placement))
      options.host.views.show(plugin.manifest.id)
    }
    for (const id of options.host.views.list()) if (!activeIds.has(id) && !pendingMiniReveal?.ids.has(id) && !idle) options.host.views.hide(id)
    // 契约状态跟着布局一起下发：可见性、真实尺寸/缩放、主题（都按插件去重）。
    options.host.views.publishContract({
      islandMode: hostLayoutState.mode,
      activePluginId: islandState.value.activePluginId,
      scale: options.settings.miniScale,
    })
  }

  function sendLayout(mode: IslandMode, pluginMode?: PluginMode, separators: number[] = [], collapsed = false, size = { width: SMALL_DEFAULT.width, height: SMALL_DEFAULT.height }, top = options.settings.islandTop, placements: PluginPlacement[] = [], contentSize: { width: number; height: number; top?: number } = size, clipPlugins = mode === 'expanded' || mode === 'detail', showClock = false, syncPlugins = true, bar: { overflow?: number; chipX?: number | null; quickActions?: boolean } = {}): void {
    if (options.transfers.progressVisible && (mode !== 'compact' || placements.length > 0)) {
      options.transfers.progressVisible = false
      options.host.send('transfers:progress', null)
    }
    const quickActions = bar.quickActions ?? (!options.transfers.progressVisible && !options.transfers.dragging && !alertActive && ((mode === 'idle' && pointer.idleHover) || (mode === 'compact' && pointer.compactHover)))
    hostLayoutState = { mode, pluginMode, separators, collapsed, clipPlugins, showClock, quickActions, width: size.width, height: size.height, top, contentWidth: contentSize.width, overflow: bar.overflow ?? 0, chipX: bar.chipX ?? null }
    animatedLayout = { width: contentSize.width, height: contentSize.height, top: contentSize.top ?? top, placements, clipPlugins }
    if (syncPlugins) syncPluginViews()
    options.host.send('host:layout', hostLayoutState)
  }

  function layoutManager(): IslandLayoutManager | null { return options.host.window ? islandLayout : null }

  async function animateWindow(_bounds: { x: number; y: number; width: number; height: number }, _duration = 380): Promise<void> {
    // The host window stays fixed like the old project. Only the inner island
    // capsule animates, so plugin renderers never move with the spring.
  }

  function centerBounds(_width: number, _height: number, _top = options.settings.islandTop) { return layoutManager()?.center(WINDOW_SIZE.width, WINDOW_SIZE.height, 0) }

  function stageOrigin(width: number, height: number, top = options.settings.islandTop) { return { x: Math.round((WINDOW_SIZE.width - width) / 2), y: Math.round(top), width, height } }

  function updatePluginAnimationFrame(frame: { width: number; height: number; top: number; radius: number }): void {
    animatedFrame = { width: Math.max(1, frame.width), height: Math.max(1, frame.height), top: frame.top, radius: Math.max(0, frame.radius) }
    syncPluginViews(animatedFrame)
    // hostLayoutState 里存的就是这次过渡的目标外壳尺寸，跟它比最准。
    const settled = Math.abs(animatedFrame.width - hostLayoutState.width) <= 2 && Math.abs(animatedFrame.height - hostLayoutState.height) <= 2
    // 收起进度到点（或弹簧到位）：先撤工作台内容（它叠在插件之上），剩下的交给空胶囊；
    // 再切插件 mini 内容（早切就是"内容先缩进岛里"）。
    transitions.sample(animatedFrame.width, settled)
    if (pendingMiniReveal) {
      if (settled) applyPendingMiniReveal('frame')
    }
  }

  async function applySettingsLayout(change: SettingsLayoutChange): Promise<void> {
    if (disposed) return
    const state = islandState.value
    if (change === 'idle-mode') {
      if (state.mode === 'idle' || state.mode === 'compact') await showRest()
    } else if (change === 'top') {
      if (state.mode === 'idle') await showIdle(pointer.idleHover)
      else if (state.mode === 'compact') await showRest(pointer.inside)
      else if ((state.mode === 'expanded' || state.mode === 'detail') && state.activePluginId) {
        const plugin = options.plugins.get(state.activePluginId)
        if (plugin) await showActive(plugin, state.mode)
      } else if (state.mode === 'custom') await enterCustomMode()
    } else if (change === 'scale') {
      if (state.mode === 'compact') await showRest(pointer.inside)
      else if (state.mode === 'idle') await showIdle(pointer.idleHover)
    } else if (state.mode === 'compact' && !alertActive) await showRest(pointer.inside)
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
  /** Close the console. The next layout sync hides it; this also does it now. */
  function hideWorkbench(): void {
    cancelDeferredWorkbenchHide()
    options.host.views?.endWorkbenchCollapse()
    workbenchStage = null
    options.host.views?.setWorkbenchStage(null)
  }

  function armWorkbenchHideThreshold(): void {
    if (workbenchStage) transitions.armWorkbenchHide(workbenchStage.width, hostLayoutState.width)
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
  const workbenchSizing = createWorkbenchSize()

  async function enterCustomMode(): Promise<void> {
    if (disposed) return
    if (!options.host.window || !options.host.views) return
    options.transfers.hide()
    clearAlertCarry()
    cancelCollapse()
    cancelDeferredWorkbenchHide()
    // 若上一次收起动画中途被打断，zoom 可能停在 <1：重新打开前必须恢复。
    options.host.views.endWorkbenchCollapse()
    // 控制台是最高优先级的"用户操作"：提醒与独占都让位（排队的提醒保留）。
    arbiter.interrupt()
    pointer.setHover('idle', false)
    pointer.setHover('compact', false)
    const serial = transitions.begin()
    const view = await options.workbench.ensure()
    if (!view || serial !== transitions.serial) return
    for (const plugin of options.plugins.list()) options.host.views.hide(plugin.manifest.id)
    const { width, height } = workbenchSizing.current()
    const stage = stageOrigin(width, height, options.settings.islandTop)
    workbenchStage = { x: stage.x, y: stage.y, width, height }
    // 从这里开始，页面量到的就是宿主真正排布出来的尺寸，它的 resize 请求才有意义。
    workbenchLaidOutOnce = true
    const bounds = centerBounds(width, height, options.settings.islandTop)
    if (!bounds) return
    islandState.patch({ mode: 'custom', activePluginId: null, visiblePluginIds: [], sticky: false })
    setHitRegion(stageHitRegion(stage, 28))
    // clipPlugins: the renderer must stream its spring frames so the native clip
    // rect tracks the growing island and uncovers the console with it.
    sendLayout('custom', undefined, [], false, { width, height }, stage.y, [], { width, height }, true)
    await animateWindow(bounds)
    if (serial !== transitions.serial) return
    options.host.layer.show()
  }

  /**
   * 小岛的静止状态：收起模式只剩屏幕顶端的触发条，浮动模式显示插件内容。
   * 启动、以及切换"空闲表现/顶部位置/缩放"这类会影响静止尺寸的设置时都走这里。
   */
  async function showRest(hovered = false): Promise<void> {
    if (disposed) return
    if (options.transfers.open || options.transfers.dragging) return
    if (options.transfers.showProgress()) return
    if (options.settings.idleMode === 'collapsed') {
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
    const plugin = options.plugins.get(alert.pluginId)
    if (!plugin) return
    alertActive = true
    alertCarry = false
    alertCarryOwner = null
    // 档位与自定义颜色单独推给渲染层，岛壳据此画描边/光晕。不走 sendLayout：那条通道带 12 个位置参数
    // 和弹簧动画语义，塞进去会牵动动效路径。
    sendAlert(alert.level, alert.color)
    await showCompact(pointer.inside, plugin, alert.width)
  }

  /** 把当前提醒档位告诉岛壳；null 表示提醒已结束（撤掉描边光晕）。 */
  function sendAlert(level: AlertLevel | null, color?: string | null): void {
    currentAlertLevel = level
    currentAlertColor = level ? (color ?? null) : null
    options.host.send('host:alert', level ? { level, color: currentAlertColor } : null)
  }

  /** 撤掉"光圈跟随展开"状态；没有别的提醒在显示时顺带把岛壳的光圈撤掉。 */
  function clearAlertCarry(): void {
    alertCarry = false
    alertCarryOwner = null
    if (!alertActive) sendAlert(null)
  }

  /** 仲裁器批准独占：真的把小岛展开到中岛/大岛。 */
  function grantFocus(request: { pluginId: string; view: 'medium' | 'large' }): boolean {
    if (options.transfers.open || options.transfers.dragging) return false
    const plugin = options.plugins.get(request.pluginId)
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
    if (disposed) return
    const manager = options.host.views
    if (!manager) return
    const small = options.plugins.ordered()
    const scale = options.settings.miniScale
    const top = options.settings.islandTop
    const { placements, baseWidth, height } = compactLayout(small, scale)
    const layout: AnimatedLayout = { width: baseWidth, height, top, placements, clipPlugins: true }
    await Promise.all(small.map(plugin => manager.ensure(plugin)))
    if (disposed || islandState.value.mode !== 'idle' || options.settings.idleMode !== 'collapsed') return
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
    if (disposed) return
    if (options.transfers.open || options.transfers.dragging) return
    if (options.transfers.showProgress()) return
    if (!options.host.window || !options.host.views) return
    // 悬停状态必须跟布局同步：否则鼠标离开后 pointer.idleHover 残留为 true，
    // 下一次悬停触发条会被 `!pointer.idleHover` 挡住（表现为"悬停没反应/慢半拍"）。
    pointer.setHover('idle', hovered)
    if (!hovered) pointer.setHover('compact', false)
    clearAlertCarry()
    clearPendingMiniReveal()
    cancelCollapse()
    const serial = transitions.begin()
    pointer.setHover('idle', hovered)
    pointer.setHover('compact', false)
    // 从工作台收回 mini 要走"吸入"（见 deferWorkbenchHide）：必须在下面的 patch 改模式前记下来。
    const fromConsole = islandState.value.mode === 'custom'
    // 插件视图不隐藏：它们保持可见、由 syncPluginViews 的 1x1 裁剪窗藏住，
    // 页面持续出帧，下次展开内容能跟着胶囊一起长出来。
    if (fromConsole) {
      deferWorkbenchHide()
      if (workbenchStage) options.host.views?.beginWorkbenchCollapse(workbenchStage)
    }
    else hideWorkbench()
    const scale = options.settings.miniScale
    const baseSize = options.settings.idleMode === 'collapsed'
      ? (hovered ? SMALL_DEFAULT : { width: 64, height: 8 })
      : (hovered ? { width: 150, height: 46 } : SMALL_DEFAULT)
    const collapsed = options.settings.idleMode === 'collapsed' && !hovered
    const collapsedMode = options.settings.idleMode === 'collapsed'
    const size = { width: Math.round(baseSize.width * scale), height: Math.round(baseSize.height * scale) }
    const top = collapsed ? 0 : options.settings.islandTop
    const bounds = centerBounds(size.width, size.height, top)
    if (!bounds) return
    const stage = stageOrigin(size.width, size.height, top)
    islandState.patch({ mode: 'idle', activePluginId: null, visiblePluginIds: [], sticky: false })
    setHitRegion(stageHitRegion(stage, (collapsedMode ? 4 : 19) * scale))
    const showClock = options.plugins.ordered().length === 0
    sendLayout('idle', undefined, [], collapsed, size, stage.y, [], size, false, showClock)
    if (fromConsole) armWorkbenchHideThreshold()
    await animateWindow(bounds)
    if (serial !== transitions.serial) return
    options.host.layer.show()
    arbiter.noteIdle()
  }

  async function showCompact(hovered = false, solo?: PluginDescriptor, soloWidth?: number): Promise<void> {
    if (disposed) return
    if (options.transfers.open || options.transfers.dragging) return
    if (!solo && options.transfers.showProgress()) return
    if (!options.host.window || !options.host.views) return
    cancelCollapse()
    pointer.setHover('idle', false)
    // Keep the hover flag authoritative instead of sticky: the collapse paths
    // decide on it, and it used to stay true after an event re-laid out the island.
    pointer.setHover('compact', hovered)
    const visible = solo ? [solo] : options.plugins.ordered()
    if (visible.length === 0) { await showIdle(); return }

    const scale = options.settings.miniScale
    const top = options.settings.islandTop
    const currentCompactIds = animatedLayout.placements.map(item => item.pluginId)
    const visibleIds = visible.map(item => item.manifest.id)
    const sameSet = !solo && !alertActive && islandState.value.mode === 'compact'
      && currentCompactIds.length === visibleIds.length
      && currentCompactIds.every((id, index) => id === visibleIds[index] && options.host.views!.has(id) && options.host.views!.modeOf(id) === 'small')

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
      for (const plugin of visible) options.host.views.setZoom(plugin.manifest.id, scale)
      compactScale = scale
      compactTop = top
      const shellWidth = baseWidth + (hovered ? 10 : 0)
      const shellHeight = baseHeight + (hovered ? 4 : 0)
      const stage = stageOrigin(shellWidth, shellHeight, top)
      setHitRegion(stageHitRegion(stage, 28 * scale), false)
      sendLayout('compact', 'small', separators, false, { width: shellWidth, height: shellHeight }, stage.y, placements, { width: baseWidth, height: baseHeight, top }, true, false, true, { overflow, chipX, quickActions })
      return
    }

    const serial = transitions.begin()
    const { layout, quickActions } = hovered && !solo && !alertActive
      ? compactLayoutWithQuickActions(visible, scale, true)
      : { layout: compactLayout(visible, scale, { solo: !!solo, soloWidth }), quickActions: false }
    const { placements, separators, baseWidth, height, overflow, chipX } = layout
    for (const plugin of visible) await options.host.views.ensure(plugin)
    if (serial !== transitions.serial) return
    for (const plugin of visible) options.host.views.setZoom(plugin.manifest.id, scale)
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
      if (workbenchStage) options.host.views?.beginWorkbenchCollapse(workbenchStage)
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
      && visible.every(plugin => options.host.views!.modeOf(plugin.manifest.id) === 'small')
    {
      await Promise.all(visible.map(async plugin => {
        const placement = placements.find(item => item.pluginId === plugin.manifest.id)!
        const geometry = pluginGeometry(targetLayout, placement)
        if (collapsing || prewarmed) return
        options.host.views!.prepare(plugin.manifest.id, 'small', geometry)
        let ready = await options.host.views!.waitForModeReady(plugin.manifest.id, 'small', 1200)
        if (!ready && serial === transitions.serial) {
          options.host.views!.prepare(plugin.manifest.id, 'small', geometry, { forceModeReady: true })
          ready = await options.host.views!.waitForModeReady(plugin.manifest.id, 'small', 1200)
        }
        if (!ready) options.host.logger?.append(plugin.manifest.id, 'warn', 'mini 布局切换未及时确认')
      }))
    }
    if (serial !== transitions.serial) return
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
    if (serial !== transitions.serial) return
    options.host.layer.show()
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
    if (!pending || !options.host.views) return
    const serial = transitions.serial
    clearPendingMiniReveal()
    for (const id of pending.ids) {
      const placement = pending.target.placements.find(item => item.pluginId === id)
      if (!placement) { options.host.views.hide(id); continue }
      const bounds = pluginGeometry(pending.target.layout, placement)
      options.host.views.prepare(id, 'small', bounds)
      // Low-end machines can need longer than the expanded-mode budget to
      // repaint a file:// plugin page after the viewport has just collapsed.
      // Keep the native view hidden until the page confirms that its small DOM
      // is active; otherwise the old medium title can be clipped into the mini bar.
      let ready = await options.host.views.waitForModeReady(id, 'small', 1200)
      if (!ready && serial === transitions.serial && islandState.value.mode === 'compact') {
        // Re-send once for slow renderers. The preload acknowledges every mode
        // message, including one whose requested mode is already selected.
        options.host.views.prepare(id, 'small', bounds, { forceModeReady: true })
        ready = await options.host.views.waitForModeReady(id, 'small', 1200)
      }
      if (serial !== transitions.serial || islandState.value.mode !== 'compact') return
      if (!ready) {
        options.host.views.hide(id)
        options.host.logger?.append(id, 'warn', 'mini 布局未及时就绪，已隐藏旧尺寸视图以避免内容错位')
        continue
      }
      options.host.views.show(id)
    }
    if (reason === 'timeout') options.host.views.publishContract({ islandMode: hostLayoutState.mode, activePluginId: islandState.value.activePluginId, scale: options.settings.miniScale })
  }

  function clearPendingMiniReveal(): void {
    if (pendingMiniReveal?.timer) clearTimeout(pendingMiniReveal.timer)
    pendingMiniReveal = null
  }

  async function showActive(plugin: PluginDescriptor, mode: Extract<IslandMode, 'expanded' | 'detail'>): Promise<void> {
    if (disposed) return
    if (options.transfers.open || options.transfers.dragging) return
    if (!options.host.window || !options.host.views) return
    // 展开的是别的插件 → 提醒光圈不跟随，撤掉；展开的就是提醒归属插件 → 光圈继续跟随。
    if (alertCarry && alertCarryOwner !== plugin.manifest.id) clearAlertCarry()
    clearPendingMiniReveal()
    cancelCollapse()
    pointer.setHover('idle', false)
    pointer.setHover('compact', false)
    const pluginMode: PluginMode = mode === 'expanded' ? 'medium' : 'large'
    const serial = transitions.begin()
    await options.host.views.ensure(plugin)
    if (serial !== transitions.serial) return
    const size = pluginSize(plugin, pluginMode)
    const top = options.settings.islandTop
    const placement: PluginPlacement = { pluginId: plugin.manifest.id, x: 0, width: size.width, height: size.height }
    const targetLayout: AnimatedLayout = { width: size.width, height: size.height, top, placements: [placement], clipPlugins: true }
    const geometry = pluginGeometry(targetLayout, placement)
    options.host.views.setZoom(plugin.manifest.id, 1)
    // 已经在收起态持续渲染的页面不要再次 hide/show；只在原生裁剪窗后切模式，
    // 否则 Chromium 合成器会丢掉这一次展开的首帧。冷页面才走隐藏等待握手。
    options.host.views.prepare(plugin.manifest.id, pluginMode, geometry, { preserveVisibility: options.host.views.isShown(plugin.manifest.id) })
    await options.host.views.waitForModeReady(plugin.manifest.id, pluginMode)
    if (serial !== transitions.serial) return
    for (const item of options.plugins.list()) if (item.manifest.id !== plugin.manifest.id) options.host.views.hide(item.manifest.id)
    hideWorkbench()
    const bounds = centerBounds(size.width, size.height, top)
    if (!bounds) return
    const stage = stageOrigin(size.width, size.height, top)
    pointer.holdOpen(400)
    islandState.patch({ mode, activePluginId: plugin.manifest.id, visiblePluginIds: [plugin.manifest.id], sticky: false })
    setHitRegion({ x: stage.x, y: stage.y, width: size.width, height: size.height, radius: 28 })
    // Defer the first native-view reveal to host:animation-frame. This keeps
    // the target large bounds hidden until the shell has started its spring, so
    // there is no large-left-edge flash before the medium-to-large animation.
    sendLayout(mode, pluginMode, [], false, size, stage.y, [placement], size, true, false, false)
    await animateWindow(bounds)
    if (serial !== transitions.serial) return
    pointer.recheck()
    options.host.layer.show()
  }

  const handlePluginCommand = createPluginCommands({
    get disposed() { return disposed },
    get hostMode() { return hostLayoutState.mode },
    host: options.host, settings: options.settings, state: islandState,
    arbiter, pointer, plugins: options.plugins, events: options.events,
    carryAlert(pluginId) {
      const showing = arbiter.showingAlert()
      alertCarry = !!showing && showing.pluginId === pluginId
      alertCarryOwner = alertCarry ? pluginId : null
    },
    clearAlertCarry, showActive, showCompact, stageOrigin, setHitRegion,
    sendLayout, centerBounds, animateWindow, mediaKey: options.mediaKey,
  })
  return {
    dispose() {
      if (disposed) return
      disposed = true
      transitions.dispose()
      clearPendingMiniReveal()
      arbiter.dispose()
      pointer.dispose()
    },
    get alertActive() { return alertActive },
    applySettingsLayout,
    get arbiter() { return arbiter },
    cancelCollapse,
    clearAlertCarry,
    clearPendingMiniReveal,
    invalidateLayout() { compactScale = Number.NaN; compactTop = Number.NaN },
    consoleVisible,
    restoreRenderer() {
      if (hostLayoutState.mode !== 'idle' || hostLayoutState.width !== SMALL_DEFAULT.width) options.host.send('host:layout', hostLayoutState)
      sendAlert(currentAlertLevel, currentAlertColor)
    },
    enterCustomMode,
    handlePluginCommand,
    hideWorkbench,
    get hitInside() { return pointer.inside },
    attachWindow() {
      const win = options.host.window
      if (!win) return
      islandLayout = new IslandLayoutManager(win)
      islandLayout.apply(islandLayout.center(WINDOW_SIZE.width, WINDOW_SIZE.height, 0))
    },
    detachWindow() { islandLayout = null },
    blur: pointer.blur,
    get islandState() { return islandState },
    sendAlert,
    sendLayout,
    setHitRegion,
    showCompact,
    showRest,
    stageHitRegion,
    stageOrigin,
    get transitionSerial() { return transitions.serial },
    beginTransition() { return transitions.begin() },
    updateHitTest,
    updatePluginAnimationFrame,
    warmPluginViews,
    get workbenchLaidOutOnce() { return workbenchLaidOutOnce },
    get workbenchSizing() { return workbenchSizing },
  }
}
