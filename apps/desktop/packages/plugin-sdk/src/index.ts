/**
 * Activity Island 插件 SDK —— 类型定义。
 *
 * 运行时由宿主注入（`electron/preload/plugin-preload.ts` → `window.dynamicIsland`），
 * 插件是普通网页，不需要打包工具；本包只提供类型给 TS 作者。
 * 契约全文见 docs/plugin-contract.md。
 */

export const CONTRACT_VERSION = 2

export type IslandMode = 'small' | 'medium' | 'large'
export type VisibilityReason = 'mini' | 'expanded' | 'hidden' | 'obscured'

export interface ThemeTokens {
  surface: string
  ink: string
  inkDim: string
  accent: string
  /** 灵动岛当前实际生效的圆角（已被短边压缩，不是声明值）。 */
  radius: number
  gap: number
  font: string
  dark: boolean
}

export interface PluginMetrics {
  /** 宿主 mini 缩放设置。 */
  scale: number
  /** 本插件视图的 zoom 因子（真实生效值）。 */
  zoom: number
  /** 显示器缩放因子（信息性）；canvas 请用 window.devicePixelRatio，它已包含 zoom。 */
  deviceScaleFactor: number
  /** 插件页面的 CSS 像素尺寸。 */
  width: number
  height: number
}

export interface HelloPayload {
  contractVersion: number
  hostVersion: string
  hostName: string
  capabilities: string[]
  theme: ThemeTokens
  pluginId: string
  /** 该插件声明的设置项（等同 island.settings.schema()）。 */
  settings?: { fields?: Array<Record<string, unknown>> } | null
}

export interface VisibilityState {
  /** 是否真的显示在小/中/大岛上。 */
  visible: boolean
  reason: VisibilityReason
  /** 宿主是否允许页面继续更新；收起时可为 true（页面被 1x1 裁剪但在预热）。 */
  rendering?: boolean
}

export interface PluginToolMetric {
  label: string
  value: string
  tone?: 'default' | 'warn'
}

/** 控制台「工具」页的数据视图；宿主负责渲染，插件只提供数据。 */
export type PluginToolView =
  | { type: 'stats'; items: PluginToolMetric[]; spark?: number[] }
  | { type: 'list'; items: Array<{ name: string; meta?: string; tone?: 'default' | 'bad' }> }
  | { type: 'focus'; value: string; note?: string; rounds?: number; done?: number }
  | { type: 'media'; track: string; source?: string; progress?: number }
  | { type: 'text'; text: string }

export interface PluginToolActionEvent {
  toolId: string
  actionId: string
}

export type IntentKind = 'alert' | 'focus'
export type IntentResult = 'granted' | 'queued' | 'denied' | 'expired' | 'dismissed' | 'preempted'

export interface IntentMessage {
  kind: IntentKind
  result: IntentResult
  key?: string
  reason?: string
}

export interface AlertOptions {
  /** 同一 key 的提醒会覆盖而不是排队。 */
  key?: string
  level?: 'info' | 'warn' | 'critical'
  /** 显示时长（毫秒，1000~60000；默认按 level 取 4000/6000/9000）。 */
  ttl?: number
  badge?: string
  /** 可选自定义光圈色：#RGB / #RRGGBB / #RRGGBBAA。不传按 level 取语义色。 */
  color?: string
  /**
   * 可选申请的覆盖条宽度（逻辑 px）：实际宽度 = max(清单 small.width, width)，
   * 按 miniScale 缩放并钳到岛最大宽。长通知量好内容宽度再传；不传用清单声明的推荐宽度。
   * 插件的 small 视图要能自适应更宽的画布（100% 布局）。
   */
  width?: number
}

export interface FocusOptions {
  view?: 'medium' | 'large'
  reason?: string
}

export interface DynamicIslandApi {
  pluginId: string
  /** 握手结果；页面脚本可以早于宿主推送，await 它即可。 */
  ready: Promise<HelloPayload | null>
  readonly hello: HelloPayload | null
  readonly contractVersion: number | null
  /** 宿主是否授予了某项能力（process / media / ...）。 */
  can(capability: string): boolean

  ui: {
    getMode(): IslandMode
    onModeChange(listener: (mode: IslandMode) => void): () => void
    expand(): void
    collapse(): void
    close(): void
    requestSize(size: { width: number; height: number }): void
  }

  /**
   * 声明一条提醒：宿主让 mini 条整条覆盖显示这一条，ttl 到期自动退场（或调 ui.close() 主动结束）。
   * 多个提醒按队列（上限 3）依次显示，同 key 覆盖。结果通过 onIntent 回执。
   */
  alert(options?: AlertOptions): void
  /**
   * 请求独占展开。granted = 现在归你；queued = 排在别人后面；denied = 被拒（busy/no-view）；
   * preempted = 你在展开中被用户操作打断。结果通过 onIntent 回执。
   */
  focus(options?: FocusOptions): void
  onIntent(listener: (intent: IntentMessage) => void): () => void

  /** 我是否真的显示在岛上；rendering=false 时 SDK 会停止轮询与动画。 */
  visibility(): VisibilityState
  onVisibility(listener: (state: VisibilityState) => void): () => void
  onVisible(listener: () => void): () => void
  onHidden(listener: () => void): () => void

  metrics(): PluginMetrics
  onMetrics(listener: (metrics: PluginMetrics) => void): () => void
  theme(): ThemeTokens | null
  onTheme(listener: (theme: ThemeTokens) => void): () => void
  onHello(listener: (hello: HelloPayload) => void): () => void

  /** 宿主允许渲染时运行的轮询；rendering=false 时自动暂停。 */
  every(ms: number, fn: () => void): () => void
  /** 宿主允许渲染时运行的动画循环，回调收到毫秒间隔。 */
  raf(fn: (dt: number) => void): () => void
  /** canvas 像素尺寸对齐 devicePixelRatio，并在尺寸/缩放变化时重绘（绘制在插件自己的 context 里）。 */
  fitCanvas(canvas: HTMLCanvasElement, draw: (width: number, height: number, dpr: number) => void): () => void
  redraw(): void

  events: {
    emit(name: string, payload: unknown): void
    on(name: string, listener: (payload: unknown) => void): () => void
  }
  /**
   * 控制台「工具」页。view 是宿主渲染的数据视图；actions 的点击会以
   * `tools.onAction` 发给插件，插件执行后调 `tools.set` 更新视图。
   * 工具只是控制台里的操作入口，不会改变上岛方式。
   */
  tools: {
    set(toolId: string, patch: { view?: PluginToolView; notice?: string | null }): void
    onAction(listener: (event: PluginToolActionEvent) => void): () => void
  }
  storage: {
    get<T = unknown>(key: string): Promise<T | undefined>
    set(key: string, value: unknown): Promise<{ ok: true }>
  }
  /**
   * 插件参数：在 plugin.json 的 `settings.fields` 里声明，宿主控制台负责渲染表单，
   * 插件用同一份数据读写（用户在设置里改了会通过 onChange 通知插件）。
   */
  settings: {
    /** manifest 里声明的字段定义（用于在 medium/large 里自己画设置界面）。 */
    schema(): Array<{ key: string; label: string; type?: string; description?: string; placeholder?: string; default?: unknown; options?: Array<{ value: string; label: string }>; min?: number; max?: number }>
    all(): Promise<Record<string, unknown>>
    get<T = unknown>(key: string): Promise<T | undefined>
    set(key: string, value: unknown): Promise<Record<string, unknown>>
    patch(values: Record<string, unknown>): Promise<Record<string, unknown>>
    onChange(listener: (values: Record<string, unknown>) => void): () => void
  }
}

declare global {
  interface Window { dynamicIsland: DynamicIslandApi }
}

export const plugin: DynamicIslandApi = window.dynamicIsland

export function onModeChange(listener: (mode: IslandMode) => void): () => void {
  return plugin.ui.onModeChange(listener)
}
