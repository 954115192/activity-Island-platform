import { contextBridge, ipcRenderer } from 'electron'

type Mode = 'small' | 'medium' | 'large'
type VisibilityReason = 'mini' | 'expanded' | 'hidden' | 'obscured'

interface ThemeTokens {
  surface: string
  ink: string
  inkDim: string
  accent: string
  radius: number
  gap: number
  font: string
  dark: boolean
}

interface PluginMetrics {
  scale: number
  zoom: number
  deviceScaleFactor: number
  width: number
  height: number
}

interface HelloPayload {
  contractVersion: number
  hostVersion: string
  hostName: string
  capabilities: string[]
  theme: ThemeTokens
  pluginId: string
  /** 该插件在 plugin.json 里声明的设置项（settings.fields）。 */
  settings?: { fields?: Array<Record<string, unknown>> } | null
}

interface VisibilityState { visible: boolean; reason: VisibilityReason; rendering?: boolean }

type Listener<T> = (value: T) => void

function params(): URLSearchParams { return new URLSearchParams(location.search) }
function pluginId(): string { return params().get('pluginId') ?? 'unknown' }

let currentMode: Mode = (params().get('mode') as Mode) || 'small'
/** 插件自报的"我现在有没有内容"（island.ui.setPresence）。 */
let presence = true
let hello: HelloPayload | null = null
let visibility: VisibilityState = { visible: false, reason: 'hidden', rendering: false }
let metrics: PluginMetrics = {
  scale: 1, zoom: 1, deviceScaleFactor: window.devicePixelRatio || 1,
  width: window.innerWidth, height: window.innerHeight,
}
let theme: ThemeTokens | null = null

const modeListeners = new Set<Listener<Mode>>()
const eventListeners = new Map<string, Set<Listener<unknown>>>()
const helloListeners = new Set<Listener<HelloPayload>>()
const visibilityListeners = new Set<Listener<VisibilityState>>()
const metricsListeners = new Set<Listener<PluginMetrics>>()
const themeListeners = new Set<Listener<ThemeTokens>>()
const intentListeners = new Set<Listener<IntentMessage>>()
const toolActionListeners = new Set<Listener<{ toolId: string; actionId: string }>>()
const settingsListeners = new Set<Listener<Record<string, unknown>>>()

interface IntentMessage { kind: 'alert' | 'focus'; result: 'granted' | 'queued' | 'denied' | 'expired' | 'dismissed' | 'preempted'; key?: string; reason?: string }

// ---------------------------------------------------------------- 主题
// 宿主下发的设计 token 直接落到 :root 上的 CSS 变量，插件零成本跟随主题。
function applyThemeVars(next: ThemeTokens): void {
  const root = document.documentElement
  if (!root) return
  root.style.setProperty('--island-surface', next.surface)
  root.style.setProperty('--island-ink', next.ink)
  root.style.setProperty('--island-ink-dim', next.inkDim)
  root.style.setProperty('--island-accent', next.accent)
  root.style.setProperty('--island-radius', `${next.radius}px`)
  root.style.setProperty('--island-gap', `${next.gap}px`)
  root.style.setProperty('--island-font', next.font)
}

// ---------------------------------------------------------------- 定时器助手
// 插件用 sdk.every()/sdk.raf() 就自动满足"隐藏时不空转"的性能契约。
interface EveryHandle { ms: number; fn: () => void; timer: ReturnType<typeof setInterval> | null }
const everyHandles = new Set<EveryHandle>()
const rafHandles = new Set<{ fn: (dt: number) => void; frame: number | null; last: number }>()

function startEvery(handle: EveryHandle): void {
  if (handle.timer !== null) return
  handle.fn()
  handle.timer = setInterval(handle.fn, handle.ms)
}
function stopEvery(handle: EveryHandle): void {
  if (handle.timer === null) return
  clearInterval(handle.timer)
  handle.timer = null
}
function startRaf(handle: { fn: (dt: number) => void; frame: number | null; last: number }): void {
  if (handle.frame !== null) return
  handle.last = performance.now()
  const step = (now: number): void => {
    const dt = now - handle.last
    handle.last = now
    handle.fn(dt)
    handle.frame = requestAnimationFrame(step)
  }
  handle.frame = requestAnimationFrame(step)
}
function stopRaf(handle: { fn: (dt: number) => void; frame: number | null; last: number }): void {
  if (handle.frame === null) return
  cancelAnimationFrame(handle.frame)
  handle.frame = null
}

function applyVisibility(next: VisibilityState): void {
  const rendering = next.rendering ?? next.visible
  const changed = next.visible !== visibility.visible || next.reason !== visibility.reason || rendering !== !!visibility.rendering
  visibility = { ...next, rendering }
  if (changed) {
    for (const listener of visibilityListeners) listener({ ...visibility })
    if (rendering) {
      for (const handle of everyHandles) startEvery(handle)
      for (const handle of rafHandles) startRaf(handle)
      refreshCanvases()
    } else {
      for (const handle of everyHandles) stopEvery(handle)
      for (const handle of rafHandles) stopRaf(handle)
    }
  }
}

function applyHello(next: HelloPayload): void {
  hello = next
  if (next.theme) {
    theme = next.theme
    applyThemeVars(next.theme)
    for (const listener of themeListeners) listener(next.theme)
  }
  for (const listener of helloListeners) listener(next)
}

function applyMode(mode: Mode): void {
  if (currentMode === mode) return
  currentMode = mode
  for (const listener of modeListeners) listener(currentMode)
}

function notifyModeReady(mode: Mode): void {
  let sent = false
  const send = (): void => {
    if (sent) return
    sent = true
    ipcRenderer.send('plugin:mode-ready', pluginId(), mode)
  }
  requestAnimationFrame(() => requestAnimationFrame(send))
  setTimeout(send, 100)
}

ipcRenderer.on('host:hello', (_event, message: HelloPayload) => { if (message?.contractVersion) applyHello(message) })
ipcRenderer.on('host:mode', (_event, message: { mode: Mode }) => {
  if (!message?.mode) return
  applyMode(message.mode)
  notifyModeReady(message.mode)
})
ipcRenderer.on('host:visibility', (_event, message: VisibilityState) => applyVisibility({
  visible: !!message?.visible,
  reason: message?.reason ?? 'hidden',
  rendering: message?.rendering,
}))
ipcRenderer.on('host:metrics', (_event, message: PluginMetrics) => {
  if (!message || !Number.isFinite(message.width)) return
  const changed = JSON.stringify(message) !== JSON.stringify(metrics)
  metrics = message
  if (changed) {
    for (const listener of metricsListeners) listener(metrics)
    refreshCanvases()
  }
})
ipcRenderer.on('host:theme', (_event, message: { theme: ThemeTokens }) => {
  if (!message?.theme) return
  theme = message.theme
  applyThemeVars(message.theme)
  for (const listener of themeListeners) listener(message.theme)
})
ipcRenderer.on('host:settings', (_event, message: { values?: Record<string, unknown> }) => {
  if (message?.values) for (const listener of settingsListeners) listener(message.values)
})
ipcRenderer.on('host:intent', (_event, message: IntentMessage) => { if (message?.kind) for (const listener of intentListeners) listener(message) })
ipcRenderer.on('host:event', (_event, message: { name: string; payload: unknown }) => {
  for (const listener of eventListeners.get(message.name) ?? []) listener(message.payload)
})
ipcRenderer.on('host:tool-action', (_event, message: { toolId?: unknown; actionId?: unknown }) => {
  if (typeof message?.toolId !== 'string' || typeof message?.actionId !== 'string') return
  for (const listener of toolActionListeners) listener({ toolId: message.toolId, actionId: message.actionId })
})

// 主动握手：页面脚本可能早于宿主推送 host:hello 运行，所以这里反查一次。
const helloReady: Promise<HelloPayload | null> = ipcRenderer
  .invoke('plugin:hello')
  .then((payload: HelloPayload | null) => { if (payload?.contractVersion) applyHello(payload); return hello })
  .catch(() => null)

// ---------------------------------------------------------------- canvas 助手
// 注意：canvas 的 2D context 不能跨 contextBridge 传递（拿到的不是真 context），
// 所以 SDK 只负责把 canvas 的像素尺寸对齐 devicePixelRatio，绘制回调在插件自己的
// 上下文里执行、自己取 context。
interface CanvasBinding { canvas: HTMLCanvasElement; draw: (width: number, height: number, dpr: number) => void }
const canvasBindings = new Set<CanvasBinding>()

function drawCanvas(binding: CanvasBinding): void {
  const { canvas, draw } = binding
  const rect = canvas.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  const width = Math.max(1, rect.width)
  const height = Math.max(1, rect.height)
  const pixelWidth = Math.max(1, Math.round(width * dpr))
  const pixelHeight = Math.max(1, Math.round(height * dpr))
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight
  draw(width, height, dpr)
}

function refreshCanvases(): void {
  if (!visibility.rendering) return
  for (const binding of canvasBindings) drawCanvas(binding)
}

function command(name: string, args: unknown[] = []): void { ipcRenderer.send('host:command', pluginId(), name, args) }

/** 插件日志：落到 <userData>/island-plugins/logs/<id>.log，设置页可看。 */
function log(level: 'info' | 'warn' | 'error', message: unknown): void {
  const text = typeof message === 'string' ? message : (() => { try { return JSON.stringify(message) } catch { return String(message) } })()
  ipcRenderer.send('plugin:log', pluginId(), level, text)
}

// 页面里没接住的异常也写进插件日志，作者不必自己包 try/catch。
window.addEventListener('error', (event) => log('error', `${event.message} @ ${event.filename}:${event.lineno}:${event.colno}`))
window.addEventListener('unhandledrejection', (event) => log('error', `unhandledrejection: ${String((event as PromiseRejectionEvent).reason)}`))

const sdk = {
  pluginId: pluginId(),
  /** 契约握手结果（宿主版本、能力集、主题）。 */
  ready: helloReady,
  get hello(): HelloPayload | null { return hello },
  get contractVersion(): number | null { return hello?.contractVersion ?? null },
  /** 宿主授予的能力集；未授予的能力调用会返回 capability-not-granted。 */
  can: (capability: string): boolean => hello?.capabilities?.includes(capability) ?? false,

  ui: {
    getMode: (): Mode => currentMode,
    onModeChange: (listener: Listener<Mode>) => { modeListeners.add(listener); return () => modeListeners.delete(listener) },
    expand: () => command('ui:expand'),
    collapse: () => command('ui:collapse'),
    close: () => command('ui:close'),
    requestSize: (size: { width: number; height: number }) => command('ui:request-size', [size]),
    /** 设置面板专用：面板页让宿主把自己关掉（岛上视图没有面板，调用无效果）。 */
    closePanel: () => ipcRenderer.send('panel:close'),
    /**
     * 自报"我现在有没有内容"：false = 从 mini 条里把自己拿掉（例如没有正在播放的媒体），
     * true = 回来。判断依据最好来自后台脚本推来的事件 —— 拿掉之后 island.every() 会暂停，
     * 靠定时轮询是醒不过来的。
     */
    setPresence: (present: boolean) => {
      presence = present !== false
      command('ui:presence', [presence])
    },
    presence: (): boolean => presence,
  },

  /** 声明一条提醒：整条覆盖显示 mini 条，ttl 到期自动退场。结果见 onIntent。color：可选自定义光圈色；width：可选申请覆盖条宽度（实际 = max(清单 small 宽, width)），长通知用它变长显示。 */
  alert: (options: { key?: string; level?: 'info' | 'warn' | 'critical'; ttl?: number; badge?: string; color?: string; width?: number } = {}) => command('alert', [options]),
  /** 请求独占展开：granted / queued / denied(busy|no-view) / preempted，结果见 onIntent。 */
  focus: (options: { view?: 'medium' | 'large'; reason?: string } = {}) => command('focus', [options]),
  onIntent: (listener: Listener<IntentMessage>) => { intentListeners.add(listener); return () => intentListeners.delete(listener) },

  /**
   * 全局媒体键：所有播放器都认（Windows 上等价于键盘上的多媒体键）。
   * 媒体类插件不需要自己起后台进程就能控制播放。
   */
  media: {
    command: (action: 'previous' | 'toggle' | 'next') => command('media:command', [action]),
  },

  /** 我是否真的显示在岛上；false 时应停止一切轮询与动画。 */
  visibility: (): VisibilityState => ({ ...visibility }),
  onVisibility: (listener: Listener<VisibilityState>) => { visibilityListeners.add(listener); return () => visibilityListeners.delete(listener) },
  onVisible: (listener: () => void) => {
    const wrapped = (state: VisibilityState): void => { if (state.visible) listener() }
    visibilityListeners.add(wrapped)
    if (visibility.visible) listener()
    return () => visibilityListeners.delete(wrapped)
  },
  onHidden: (listener: () => void) => {
    const wrapped = (state: VisibilityState): void => { if (!state.visible) listener() }
    visibilityListeners.add(wrapped)
    if (!visibility.visible) listener()
    return () => visibilityListeners.delete(wrapped)
  },

  /** 真实渲染参数：css 像素尺寸、zoom、deviceScaleFactor 与 mini 缩放。 */
  metrics: (): PluginMetrics => ({ ...metrics }),
  onMetrics: (listener: Listener<PluginMetrics>) => { metricsListeners.add(listener); return () => metricsListeners.delete(listener) },
  theme: (): ThemeTokens | null => theme,
  onTheme: (listener: Listener<ThemeTokens>) => { themeListeners.add(listener); return () => themeListeners.delete(listener) },
  onHello: (listener: Listener<HelloPayload>) => { helloListeners.add(listener); if (hello) listener(hello); return () => helloListeners.delete(listener) },

  /** 宿主允许渲染时运行的轮询；rendering=false 时自动暂停。 */
  every: (ms: number, fn: () => void): (() => void) => {
    const handle: EveryHandle = { ms: Math.max(16, ms), fn, timer: null }
    everyHandles.add(handle)
    if (visibility.rendering) startEvery(handle)
    return () => { stopEvery(handle); everyHandles.delete(handle) }
  },
  /** 宿主允许渲染时运行的动画循环；收起状态页面虽不可见但会保持预热。 */
  raf: (fn: (dt: number) => void): (() => void) => {
    const handle = { fn, frame: null as number | null, last: 0 }
    rafHandles.add(handle)
    if (visibility.rendering) startRaf(handle)
    return () => { stopRaf(handle); rafHandles.delete(handle) }
  },
  /** 让 canvas 的像素尺寸对齐 devicePixelRatio，并在尺寸/缩放变化时重绘。 */
  fitCanvas: (canvas: HTMLCanvasElement, draw: CanvasBinding['draw']): (() => void) => {
    const binding: CanvasBinding = { canvas, draw }
    canvasBindings.add(binding)
    drawCanvas(binding)
    const observer = new ResizeObserver(() => refreshCanvases())
    observer.observe(canvas)
    return () => { observer.disconnect(); canvasBindings.delete(binding) }
  },
  redraw: () => refreshCanvases(),

  events: {
    emit: (name: string, payload: unknown) => ipcRenderer.send('host:event', pluginId(), name, payload),
    on: (name: string, listener: Listener<unknown>) => {
      const listeners = eventListeners.get(name) ?? new Set<Listener<unknown>>()
      listeners.add(listener)
      eventListeners.set(name, listeners)
      return () => listeners.delete(listener)
    },
  },
  /** 控制台「工具」页：推送数据视图，接收按钮点击。 */
  tools: {
    set: (toolId: string, patch: { view?: unknown; notice?: string | null }) => command('tools:set', [toolId, patch]),
    onAction: (listener: Listener<{ toolId: string; actionId: string }>) => {
      toolActionListeners.add(listener)
      return () => toolActionListeners.delete(listener)
    },
  },
  storage: {
    get: <T = unknown>(key: string): Promise<T | undefined> => ipcRenderer.invoke('plugin:storage:get', pluginId(), key),
    set: (key: string, value: unknown): Promise<{ ok: true }> => ipcRenderer.invoke('plugin:storage:set', pluginId(), key, value),
  },
  /** 插件日志：写入 <userData>/island-plugins/logs/<id>.log，设置 → 插件 → 日志可查看。 */
  log: {
    info: (message: unknown) => log('info', message),
    warn: (message: unknown) => log('warn', message),
    error: (message: unknown) => log('error', message),
  },
  /**
   * 插件参数（声明在 plugin.json 的 settings.fields）：宿主在控制台渲染表单，
   * 插件用同一份数据读写 —— 用户在设置里改，插件通过 onChange 立刻知道。
   */
  settings: {
    schema: (): Array<Record<string, unknown>> => (hello?.settings as { fields?: Array<Record<string, unknown>> } | null | undefined)?.fields ?? [],
    all: async (): Promise<Record<string, unknown>> => {
      const result = await ipcRenderer.invoke('plugin:settings:get', pluginId()) as { values?: Record<string, unknown> }
      return result?.values ?? {}
    },
    get: async <T = unknown>(key: string): Promise<T | undefined> => {
      const result = await ipcRenderer.invoke('plugin:settings:get', pluginId()) as { values?: Record<string, unknown> }
      return (result?.values ?? {})[key] as T | undefined
    },
    set: async (key: string, value: unknown): Promise<Record<string, unknown>> => {
      const result = await ipcRenderer.invoke('plugin:settings:set', pluginId(), { [key]: value }) as { values?: Record<string, unknown> }
      return result?.values ?? {}
    },
    patch: async (values: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const result = await ipcRenderer.invoke('plugin:settings:set', pluginId(), values) as { values?: Record<string, unknown> }
      return result?.values ?? {}
    },
    onChange: (listener: Listener<Record<string, unknown>>) => { settingsListeners.add(listener); return () => settingsListeners.delete(listener) },
  },
  /**
   * 内置通知能力（仅内置模块 system-notifications 使用）。
   * 通知数据的解析、去重、过滤与历史都在主进程完成，视图只拿已归一化的记录。
   */
  notifications: {
    /** 监听状态 + 当前最新一条，用于首次渲染 */
    snapshot: (): Promise<{ status: Record<string, unknown> | null; items: Array<Record<string, unknown>> }> =>
      ipcRenderer.invoke('notifications:snapshot'),
    query: (query: Record<string, unknown>): Promise<{ items: Array<Record<string, unknown>>; total: number }> =>
      ipcRenderer.invoke('notifications:query', query),
    clearHistory: (): Promise<{ ok: boolean; clearedWindows?: boolean; error?: string }> =>
      ipcRenderer.invoke('notifications:clear', { clearWindows: false }),
    /** 清空前询问范围（应用内 / 连同 Windows 通知中心），确认后返回结果 */
    clearWithConfirm: (): Promise<{ action: 'cancel' | 'app-only' | 'both'; ok?: boolean; clearedWindows?: boolean; error?: string }> =>
      ipcRenderer.invoke('notifications:clear-confirm', 'island').then(async (choice) => {
        if (!choice || choice.action === 'cancel') return { action: 'cancel' as const }
        const result = await ipcRenderer.invoke('notifications:clear', { clearWindows: choice.action === 'both' })
        return { action: choice.action as 'app-only' | 'both', ...(result ?? {}) }
      }),
    dismiss: (eventId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('notifications:dismiss', eventId),
    copyToken: (): Promise<{ ok: boolean; token?: string }> => ipcRenderer.invoke('notifications:copy-token'),
    rotateToken: (): Promise<{ ok: boolean; token?: string }> => ipcRenderer.invoke('notifications:rotate-token'),
    /** 打开托盘同款的独立通知历史窗口 */
    openHistory: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('notifications:open-history'),
  },
}

contextBridge.exposeInMainWorld('dynamicIsland', sdk)
