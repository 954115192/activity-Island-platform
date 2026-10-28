import { contextBridge, ipcRenderer } from 'electron'

/**
 * 工作台 preload。
 *
 * 工作台是**一整页 HTML**（内容模型 B）：宿主只给"能力与数据"，页面自己画。
 * 所以这里的接口是**通用能力**（http / run / open / storage），而**不是**逐个功能的白名单。
 *
 * 为什么不做专用接口：内置工作台当初要求宿主为它写 `deepseek.*`，宿主没写，于是那一整块
 * 功能静默死掉（调用返回 `unknown-api`，界面显示"未配置/保存失败"）。有了 `http` + `storage`，
 * 这类面板工作台自己能实现，不需要宿主介入，也不会再"接口没跟上就死一块"。
 *
 * ⚠️ 能力不是白给的：manifest 里声明了什么，宿主才放行什么。未声明会返回
 * `capability-not-declared:<name>`，**不是静默失败**。
 */

const invoke = (channel: string, ...args: unknown[]): Promise<unknown> => ipcRenderer.invoke(channel, ...args)

function text(message: unknown): string {
  if (typeof message === 'string') return message
  try { return JSON.stringify(message) } catch { return String(message) }
}

const workbench = {
  /** 退出工作台，回到小岛。 */
  exit: (): void => { ipcRenderer.send('workbench:exit') },
  /** 关闭整个控制台窗口（独立窗口模式下才需要）。 */
  close: (): void => { ipcRenderer.send('console:close') },

  /** 这个工作台实际被授予的能力（页面据此自己降级，而不是等调用失败）。 */
  capabilities: () => invoke('workbench:capabilities'),

  /** 自己的身份：定位随包资源（跑 resources/ 里的脚本要绝对路径）。 */
  self: () => invoke('workbench:self'),

  /**
   * 参数（workbench.json 的 `settings.fields`）：宿主在管理页渲染表单，页面读同一份。
   * **不要**自己再画一套设置界面 —— 和插件一样，参数界面是宿主的。
   */
  settings: {
    all: () => invoke('workbench:settings:get').then(result => (result as { values?: Record<string, unknown> })?.values ?? {}),
    get: (key: string) => invoke('workbench:settings:get').then(result => ((result as { values?: Record<string, unknown> })?.values ?? {})[key]),
    set: (key: string, value: unknown) => invoke('workbench:settings:set', { [key]: value }),
    patch: (values: Record<string, unknown>) => invoke('workbench:settings:set', values ?? {}),
    schema: () => invoke('workbench:settings:get').then(result => (result as { schema?: unknown })?.schema ?? null),
    /** 用户在管理页改了参数 → 这里收到（宿主推 host:settings）。 */
    onChange: (listener: (values: Record<string, unknown>) => void): (() => void) => {
      const handler = (_event: unknown, message: { values?: Record<string, unknown> }): void => { if (message?.values) listener(message.values) }
      ipcRenderer.on('host:settings', handler)
      return () => { ipcRenderer.removeListener('host:settings', handler) }
    },
  },

  system: {
    status: () => invoke('workbench:system:status'),
    network: () => invoke('workbench:system:network'),
  },

  /** 打开网址 / 程序 / 文件 / 文件夹；宿主按 scheme 分流，失败如实返回原因。 */
  open: (target: string) => invoke('workbench:open', String(target ?? '')),

  /** 访问网络（主进程发出，不受 CORS 限制，可访问本机服务）。只允许 http/https。 */
  http: (url: string, options?: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }) =>
    invoke('workbench:http', String(url ?? ''), options ?? {}),

  /** 执行本机命令或脚本，返回 { ok, code, stdout, stderr }。默认不经 shell。 */
  run: (command: string, args: string[] = [], options?: { cwd?: string; timeoutMs?: number; shell?: boolean }) =>
    invoke('workbench:run', String(command ?? ''), Array.isArray(args) ? args : [], options ?? {}),

  storage: {
    get: (key: string) => invoke('workbench:storage:get', String(key)),
    set: (key: string, value: unknown) => invoke('workbench:storage:set', String(key), value),
    delete: (key: string) => invoke('workbench:storage:delete', String(key)),
    all: () => invoke('workbench:storage:all'),
  },

  /** 「快捷启动」列表：宿主拥有的数据，**跨工作台共享**（换工作台时常用软件不丢）。 */
  shortcuts: {
    list: () => invoke('workbench:shortcuts:get'),
    add: (name: string, target: string) => invoke('workbench:shortcuts:add', String(name ?? ''), String(target ?? '')),
    update: (id: string, patch: { name?: string; path?: string }) => invoke('workbench:shortcuts:update', String(id ?? ''), patch ?? {}),
    remove: (id: string) => invoke('workbench:shortcuts:remove', String(id ?? '')),
  },

  /** 请求尺寸；宿主钳制后应用，返回真实生效的尺寸。 */
  resize: (size: { width: number; height: number }) => invoke('workbench:resize', size),

  log: {
    info: (message: unknown): void => { ipcRenderer.send('workbench:log', 'info', text(message)) },
    warn: (message: unknown): void => { ipcRenderer.send('workbench:log', 'warn', text(message)) },
    error: (message: unknown): void => { ipcRenderer.send('workbench:log', 'error', text(message)) },
  },
}

// 页面里没接住的异常也写进工作台日志，作者不必自己包 try/catch。
window.addEventListener('error', event => { ipcRenderer.send('workbench:log', 'error', `${event.message} @ ${event.filename}:${event.lineno}:${event.colno}`) })
window.addEventListener('unhandledrejection', event => { ipcRenderer.send('workbench:log', 'error', `unhandledrejection: ${String((event as PromiseRejectionEvent).reason)}`) })

contextBridge.exposeInMainWorld('workbench', workbench)

// 旧的 `window.activityIsland`（方法白名单式 `api()`）已随内置工作台迁移一并移除。
// 没有第三方工作台依赖它，留着只会让新页面继续照着白名单去写 —— 那正是
// 「DeepSeek 用量」整块烂掉的原因（调了宿主不存在的 method，静默返回 unknown-api）。
