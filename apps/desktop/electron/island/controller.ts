import { screen, type BrowserWindow } from 'electron'
import { IntentArbiter, type AlertLevel } from './intent-arbiter'
import { IslandState } from './island-state'
import { IslandLayoutManager } from './layout-manager'
import { SMALL_DEFAULT, WINDOW_SIZE, MODE_DEFAULTS, pluginSize, pluginGeometry, compactLayout, compactLayoutWithQuickActions, type PluginPlacement, type AnimatedLayout } from './geometry'
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

  let collapseTimer: NodeJS.Timeout | null = null

  let transitionSerial = 0

  let hitInside = false

  let idleHover = false

  let compactHover = false

  let openGraceUntil = 0

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
      void showRest(hitInside)
    },
    canAlert: () => islandState.value.mode === 'idle' || islandState.value.mode === 'compact',
    grantFocus: request => grantFocus(request),
    releaseFocus: () => { clearAlertCarry(); void showRest(hitInside) },
    sendIntent: (pluginId, message) => options.host.views?.sendIntent(pluginId, message),
  })

  let hitRegion = { x: 0, y: 0, width: SMALL_DEFAULT.width, height: SMALL_DEFAULT.height, radius: 23, interactive: true }

  function syncPluginViews(frame = animatedFrame): void {
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
    const quickActions = bar.quickActions ?? (!options.transfers.progressVisible && !options.transfers.dragging && !alertActive && ((mode === 'idle' && idleHover) || (mode === 'compact' && compactHover)))
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
    if (pendingWorkbenchHide && (animatedFrame.width <= pendingWorkbenchHide.belowWidth || settled)) hideWorkbench()
    if (pendingMiniReveal) {
      if (settled) applyPendingMiniReveal('frame')
    }
  }

  async function applySettingsLayout(change: SettingsLayoutChange): Promise<void> {
    const state = islandState.value
    if (change === 'idle-mode') {
      if (state.mode === 'idle' || state.mode === 'compact') await showRest()
    } else if (change === 'top') {
      if (state.mode === 'idle') await showIdle(idleHover)
      else if (state.mode === 'compact') await showRest(hitInside)
      else if ((state.mode === 'expanded' || state.mode === 'detail') && state.activePluginId) {
        const plugin = options.plugins.get(state.activePluginId)
        if (plugin) await showActive(plugin, state.mode)
      } else if (state.mode === 'custom') await enterCustomMode()
    } else if (change === 'scale') {
      if (state.mode === 'compact') await showRest(hitInside)
      else if (state.mode === 'idle') await showIdle(idleHover)
    } else if (state.mode === 'compact' && !alertActive) await showRest(hitInside)
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
  const workbenchSizing = createWorkbenchSize()

  async function enterCustomMode(): Promise<void> {
    if (!options.host.window || !options.host.views) return
    options.transfers.hide()
    clearAlertCarry()
    cancelCollapse()
    cancelDeferredWorkbenchHide()
    // 若上一次收起动画中途被打断，zoom 可能停在 <1：重新打开前必须恢复。
    options.host.views.endWorkbenchCollapse()
    // 控制台是最高优先级的"用户操作"：提醒与独占都让位（排队的提醒保留）。
    arbiter.interrupt()
    idleHover = false
    compactHover = false
    const serial = ++transitionSerial
    const view = await options.workbench.ensure()
    if (!view || serial !== transitionSerial) return
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
    if (serial !== transitionSerial) return
    options.host.layer.show()
  }

  function roundedRectContains(x: number, y: number): boolean {
    if (!options.host.window || options.host.window.isDestroyed() || !hitRegion.interactive) return false
    const bounds = options.host.window.getBounds()
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
    if (!options.host.window || options.host.window.isDestroyed() || options.host.layer.hidden) return
    const point = screen.getCursorScreenPoint()
    // Prefer the utility window only where it actually overlaps the cursor.
    // The rest of the island remains clickable and stays above ordinary apps.
    if (options.host.layer.contains(point)) {
      if (hitInside) {
        hitInside = false
        islandState.patch({ pointerInside: false })
        options.host.send('host:cursor', false)
      }
      options.host.window.setIgnoreMouseEvents(true, { forward: true })
      return
    }
    const inside = roundedRectContains(point.x, point.y)
    if (inside === hitInside) return
    hitInside = inside
    islandState.patch({ pointerInside: inside })
    options.host.window.setIgnoreMouseEvents(!inside, { forward: true })
    options.host.send('host:cursor', inside)
    // 传输面板是用户任务；移出、拖动和普通通知均不能把接收确认或文件草稿自动收走。
    if (options.transfers.open || options.transfers.dragging) return
    if (inside) {
      cancelCollapse()
      const state = islandState.value
      if (state.mode === 'expanded' || state.mode === 'detail' || state.mode === 'custom') islandState.patch({ sticky: false })
      else if (state.mode === 'idle' && !idleHover) {
        idleHover = true
        // 收起模式：从触发条展开时直接把插件一起带出来。idle 是空胶囊（插件视图
        // 被 1x1 裁剪窗藏住、但保持渲染），只有 compact 才把裁剪窗放开。
        if (options.settings.idleMode === 'collapsed') { compactHover = true; void showCompact(true) }
        else void showIdle(true)
      } else if (state.mode === 'compact' && !compactHover) {
        compactHover = true
        void showCompact(true)
      }
      return
    }

    const state = islandState.value
    if (state.mode !== 'compact' && state.mode !== 'idle') options.host.send('host:pointer-outside')
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
      if (options.settings.idleMode === 'collapsed' && !state.sticky) {
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
    if (options.settings.idleMode !== 'collapsed') return { x: stage.x, y: stage.y, width: stage.width, height: stage.height, radius }
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

  function cancelCollapse(): void { if (collapseTimer) clearTimeout(collapseTimer); collapseTimer = null }

  function scheduleTransientCollapse(): void {
    cancelCollapse()
    if (islandState.value.sticky || islandState.value.pointerInside) return
    // 提醒自己带 ttl，别被活动计时器提前收掉。
    if (alertActive) return
    // 收起模式：常住插件("resident")也不能让小岛一直摊开，活动结束就回到触发条。
    // 只有浮动模式才允许常住插件把内容长期留在岛上；自己声明"没内容"的插件不算常住。
    const hasResident = options.plugins.ordered().length > 0
    if (hasResident && options.settings.idleMode !== 'collapsed') return
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
    await showCompact(hitInside, plugin, alert.width)
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
    const manager = options.host.views
    if (!manager) return
    const small = options.plugins.ordered()
    const scale = options.settings.miniScale
    const top = options.settings.islandTop
    const { placements, baseWidth, height } = compactLayout(small, scale)
    const layout: AnimatedLayout = { width: baseWidth, height, top, placements, clipPlugins: true }
    await Promise.all(small.map(plugin => manager.ensure(plugin)))
    if (islandState.value.mode !== 'idle' || options.settings.idleMode !== 'collapsed') return
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
    if (options.transfers.open || options.transfers.dragging) return
    if (options.transfers.showProgress()) return
    if (!options.host.window || !options.host.views) return
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
    if (serial !== transitionSerial) return
    options.host.layer.show()
    arbiter.noteIdle()
  }

  async function showCompact(hovered = false, solo?: PluginDescriptor, soloWidth?: number): Promise<void> {
    if (options.transfers.open || options.transfers.dragging) return
    if (!solo && options.transfers.showProgress()) return
    if (!options.host.window || !options.host.views) return
    cancelCollapse()
    idleHover = false
    // Keep the hover flag authoritative instead of sticky: the collapse paths
    // decide on it, and it used to stay true after an event re-laid out the island.
    compactHover = hovered
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

    const serial = ++transitionSerial
    const { layout, quickActions } = hovered && !solo && !alertActive
      ? compactLayoutWithQuickActions(visible, scale, true)
      : { layout: compactLayout(visible, scale, { solo: !!solo, soloWidth }), quickActions: false }
    const { placements, separators, baseWidth, height, overflow, chipX } = layout
    for (const plugin of visible) await options.host.views.ensure(plugin)
    if (serial !== transitionSerial) return
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
        if (!ready && serial === transitionSerial) {
          options.host.views!.prepare(plugin.manifest.id, 'small', geometry, { forceModeReady: true })
          ready = await options.host.views!.waitForModeReady(plugin.manifest.id, 'small', 1200)
        }
        if (!ready) options.host.logger?.append(plugin.manifest.id, 'warn', 'mini 布局切换未及时确认')
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
    const serial = transitionSerial
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
      if (!ready && serial === transitionSerial && islandState.value.mode === 'compact') {
        // Re-send once for slow renderers. The preload acknowledges every mode
        // message, including one whose requested mode is already selected.
        options.host.views.prepare(id, 'small', bounds, { forceModeReady: true })
        ready = await options.host.views.waitForModeReady(id, 'small', 1200)
      }
      if (serial !== transitionSerial || islandState.value.mode !== 'compact') return
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
    if (options.transfers.open || options.transfers.dragging) return
    if (!options.host.window || !options.host.views) return
    // 展开的是别的插件 → 提醒光圈不跟随，撤掉；展开的就是提醒归属插件 → 光圈继续跟随。
    if (alertCarry && alertCarryOwner !== plugin.manifest.id) clearAlertCarry()
    clearPendingMiniReveal()
    cancelCollapse()
    idleHover = false
    compactHover = false
    const pluginMode: PluginMode = mode === 'expanded' ? 'medium' : 'large'
    const serial = ++transitionSerial
    await options.host.views.ensure(plugin)
    if (serial !== transitionSerial) return
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
    if (serial !== transitionSerial) return
    for (const item of options.plugins.list()) if (item.manifest.id !== plugin.manifest.id) options.host.views.hide(item.manifest.id)
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
    options.host.layer.show()
  }

  function handlePluginCommand(pluginId: string, command: string, args: unknown[]): void {
    const plugin = options.plugins.get(pluginId)
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
      options.plugins.tools.update(pluginId, args[0], args[1])
    } else if (command === 'ui:request-size' && state.activePluginId === pluginId && options.host.window) {
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
      const stage = stageOrigin(width, height, options.settings.islandTop)
      options.host.views?.setBounds(pluginId, { x: stage.x, y: stage.y, width, height })
      setHitRegion({ x: stage.x, y: stage.y, width, height, radius: 30 })
      sendLayout(state.mode, mode, [], false, { width, height }, stage.y)
      const bounds = centerBounds(width, height)
      if (bounds) void animateWindow(bounds, 260)
    } else if (command === 'media:command') {
      // 全局媒体键：任何播放器都认，插件不需要自己的后台脚本也能控制播放。
      const action = args[0]
      if (action === 'previous' || action === 'toggle' || action === 'next') {
        options.mediaKey(action)
        options.events.emit('media:command', { pluginId, action })
      }
    } else if (command === 'ui:presence') {
      // 插件自报"我现在有没有内容"：false = 别占着 mini 条（例如没有正在播放的媒体）。
      const present = args[0] !== false
      if (present !== !options.plugins.hidden.has(pluginId)) {
        if (present) options.plugins.hidden.delete(pluginId)
        else options.plugins.hidden.add(pluginId)
        if (!present) {
          options.host.views?.hide(pluginId)
          // 立刻让插件知道"你已经不在岛上了"，它的 island.every() 会自动暂停。
          options.host.views?.publishContract({ islandMode: hostLayoutState.mode, activePluginId: islandState.value.activePluginId, scale: options.settings.miniScale })
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
        else if (islandState.value.mode === 'idle' && options.settings.idleMode !== 'collapsed') void showCompact(false)
      }
    }
  }
  return {
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
    get hitInside() { return hitInside },
    attachWindow() {
      const win = options.host.window
      if (!win) return
      islandLayout = new IslandLayoutManager(win)
      islandLayout.apply(islandLayout.center(WINDOW_SIZE.width, WINDOW_SIZE.height, 0))
    },
    detachWindow() { islandLayout = null },
    blur() {
      hitInside = false
      islandState.patch({ pointerInside: false })
      options.host.send('host:blur')
      const state = islandState.value
      if ((state.mode === 'expanded' || state.mode === 'detail') && state.sticky) {
        islandState.patch({ sticky: false })
        arbiter.releaseFocus('preempted')
      }
    },
    get islandState() { return islandState },
    sendAlert,
    sendLayout,
    setHitRegion,
    showCompact,
    showRest,
    stageHitRegion,
    stageOrigin,
    get transitionSerial() { return transitionSerial },
    beginTransition() { return ++transitionSerial },
    updateHitTest,
    updatePluginAnimationFrame,
    warmPluginViews,
    get workbenchLaidOutOnce() { return workbenchLaidOutOnce },
    get workbenchSizing() { return workbenchSizing },
  }
}
