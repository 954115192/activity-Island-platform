// 通知功能编排：两个来源（Windows 通知中心、本地触发接口）→ 统一管道 → 历史 + 岛上提醒。
// 显示层是内置模块 modules/system-notifications 的视图，通过 host:event 接收这里的推送。
import type {
  NotificationLevel,
  NotificationPolicy,
  NotificationRecord,
  NotificationSourceStatus,
} from './contracts'
import { JsonFileHistoryStore } from './history'
import { NotificationServiceImpl } from './service'
import { DEFAULT_TTL_SECONDS } from './policy'
import { LocalTriggerSource, DEFAULT_LOCAL_TRIGGER_PORT, hostForScope, type LocalTriggerScope } from './local-trigger'
import { WindowsNotificationSource } from './windows-source'
import { loadOrCreateToken, rotateToken } from './token'
import { networkInterfaces } from 'node:os'

export const BUILTIN_NOTIFICATIONS_ID = 'system-notifications'

export interface NotificationModuleOptions {
  /** userData/notifications */
  baseDir: string
  /** listener.ps1 的绝对路径（asar 之外）：C# 监听器缺失时的兜底 */
  listenerScript: string
  /** notify-listener.exe 的绝对路径（可选，优先于 PowerShell） */
  listenerExe?: string
  /** clear.ps1 的绝对路径（asar 之外） */
  clearScript: string
  /** 推给内置模块视图的事件（host:event） */
  emit: (name: string, payload: unknown) => void
  log: (level: 'info' | 'warn' | 'error', message: string) => void
  onStatusChange?: () => void
}

export interface NotificationModuleStatus {
  windows: NotificationSourceStatus
  localTrigger: NotificationSourceStatus
  /** 当前端点（局域网模式下为主网卡地址） */
  endpoint: string | null
  /** 全部可用端点：局域网模式下可能有多块网卡 */
  endpoints: string[]
  /** 可访问范围：仅本机 / 局域网 */
  scope: LocalTriggerScope
  token: string
  policy: NotificationPolicy
  totalRecords: number
}

export interface NotificationItem {
  id: string
  app: string
  title: string
  content: string
  ts: number
  level: NotificationLevel
  source: string
  repeat: number
  dismissedAt?: string
}

const MAX_HISTORY = 500

export class NotificationModule {
  private readonly options: NotificationModuleOptions
  private readonly history: JsonFileHistoryStore
  private readonly service: NotificationServiceImpl
  private readonly windowsSource: WindowsNotificationSource
  private localTrigger: LocalTriggerSource
  private readonly tokenFile: string
  private readonly token: string
  private started = false
  private localTriggerDesired = true
  private currentPort: number = DEFAULT_LOCAL_TRIGGER_PORT
  private currentScope: LocalTriggerScope = 'local'
  private windowsDesired = true

  constructor(options: NotificationModuleOptions) {
    this.options = options
    this.tokenFile = `${options.baseDir}/token`
    this.history = new JsonFileHistoryStore({ filePath: `${options.baseDir}/history.json`, maxRecords: MAX_HISTORY })
    this.service = new NotificationServiceImpl({ history: this.history })
    this.token = loadOrCreateToken(this.tokenFile)

    this.windowsSource = new WindowsNotificationSource({
      script: options.listenerScript,
      listenerExe: options.listenerExe,
      clearScript: options.clearScript,
      log: options.log,
      ingress: {
        ingest: async (payload, ingestOptions) => {
          const result = await this.service.ingestEntry(payload, ingestOptions)
          return { eventId: result.event.eventId, deduped: result.deduped }
        },
        dismiss: async (eventId) => this.service.dismissHistory(eventId),
      },
      onStatus: (status) => {
        this.options.emit('notif:status', this.statusPayload())
        this.options.log(status.access === 'denied' ? 'warn' : 'info', `Windows 通知：${status.message}`)
        this.options.onStatusChange?.()
      },
      onRemoved: (ids) => this.options.emit('notif:removed', { ids }),
    })

    this.localTrigger = this.createLocalTrigger()

    this.service.onEvent((record) => {
      this.options.emit('notif:item', toItem(record))
      this.options.onStatusChange?.()
    })
    this.service.onAlert((alert) => {
      // 提醒由视图发起：它量过内容宽度后调用 island.alert，宽度自适应才和插件版一致。
      this.options.log('info', `提醒分发：${alert.event.payload.title}（${alert.event.payload.level}）`)
      this.options.emit('notif:alert', {
        id: alert.event.eventId,
        level: alert.event.payload.level,
        ttlSeconds: alert.ttlSeconds,
      })
    })
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    if (this.windowsDesired) void this.windowsSource.start()
    if (this.localTriggerDesired) await this.startLocalTrigger()
    this.options.emit('notif:status', this.statusPayload())
  }

  async stop(): Promise<void> {
    this.started = false
    await this.windowsSource.stop()
    await this.localTrigger.stop()
    this.history.saveNow()
  }

  /** 来自设置表单的值 → 管道策略与来源启停 */
  async applySettings(values: Record<string, unknown>): Promise<void> {
    const policy: Partial<NotificationPolicy> = {
      paused: values.alertEnabled === false,
      allowApps: parseAppList(values.allowApps),
      ignoreApps: parseAppList(values.ignoreApps),
      quietHoursEnabled: values.quietEnabled === true,
    }
    const quietStart = typeof values.quietStart === 'string' && values.quietStart.trim() ? values.quietStart.trim() : undefined
    const quietEnd = typeof values.quietEnd === 'string' && values.quietEnd.trim() ? values.quietEnd.trim() : undefined
    if (quietStart) policy.quietStart = quietStart
    if (quietEnd) policy.quietEnd = quietEnd
    try {
      await this.service.updatePolicy(policy)
    } catch (cause) {
      this.options.log('warn', `通知策略更新失败：${String(cause)}`)
    }

    // 各级别停留时长：接口载荷里显式带 ttl 的通知不受这些默认值影响
    this.service.setDefaultTtl({
      info: normalizeTtlSetting(values.ttlInfo, DEFAULT_TTL_SECONDS.info),
      warn: normalizeTtlSetting(values.ttlWarn, DEFAULT_TTL_SECONDS.warn),
      critical: normalizeTtlSetting(values.ttlCritical, DEFAULT_TTL_SECONDS.critical),
    })

    // Windows 监听开关
    const windowsEnabled = values.windowsEnabled !== false
    if (windowsEnabled !== this.windowsDesired) {
      this.windowsDesired = windowsEnabled
      if (windowsEnabled) void this.windowsSource.start()
      else await this.windowsSource.stop()
    }

    // 本地接口：开关、端口与可访问范围（任一变化都重建监听）
    const localEnabled = values.localApiEnabled !== false
    const nextPort = normalizePort(values.localApiPort)
    const nextScope = normalizeScope(values.localApiScope)
    const portChanged = nextPort !== this.currentPort
    const scopeChanged = nextScope !== this.currentScope
    if (!localEnabled && this.localTriggerDesired) {
      this.localTriggerDesired = false
      await this.localTrigger.stop()
    } else if (localEnabled) {
      this.localTriggerDesired = true
      if (portChanged || scopeChanged || this.localTrigger.status().state !== 'running') {
        await this.stopLocalTrigger()
        this.currentPort = nextPort
        this.currentScope = nextScope
        this.localTrigger = this.createLocalTrigger()
        await this.startLocalTrigger()
      }
    }
    this.options.emit('notif:status', this.statusPayload())
  }

  /** 按当前端口与范围构造触发源；范围变化时整体替换实例 */
  private createLocalTrigger(): LocalTriggerSource {
    return new LocalTriggerSource({
      ingress: {
        ingestEntry: (payload) => this.service.ingestEntry(payload),
        dismissHistory: (eventId) => this.service.dismissHistory(eventId),
      },
      token: this.token,
      port: this.currentPort,
      host: hostForScope(this.currentScope),
      displayHosts: this.currentScope === 'lan' ? lanAddresses() : undefined,
    })
  }

  status(): NotificationModuleStatus {
    return this.statusPayload()
  }

  async snapshot(limit = 30): Promise<{ status: NotificationModuleStatus; items: NotificationItem[] }> {
    const page = await this.service.queryHistory({ limit })
    return { status: this.statusPayload(), items: page.items.map(toItem) }
  }

  async queryHistory(query: Record<string, unknown>): Promise<{ items: NotificationItem[]; total: number }> {
    const page = await this.service.queryHistory(query as never)
    return { items: page.items.map(toItem), total: page.total }
  }

  /**
   * 清空历史。clearWindows 为 true 时一并清空 Windows 通知中心。
   * Windows 只能整体清空，无法按单条删除；通知中心清空失败不影响应用内历史的清空。
   */
  async clearHistory(options: { clearWindows?: boolean } = {}): Promise<{ clearedWindows: boolean; error?: string }> {
    let clearedWindows = false
    let error: string | undefined
    if (options.clearWindows) {
      const result = await this.windowsSource.clearAll()
      clearedWindows = result.ok
      error = result.error
      if (!result.ok) this.options.log('warn', result.error ?? '清空 Windows 通知中心失败')
    }
    await this.service.clearHistory()
    this.options.emit('notif:removed', { ids: [], clear: true })
    this.options.onStatusChange?.()
    return { clearedWindows, error }
  }

  async dismiss(eventId: string): Promise<boolean> {
    return this.service.dismissHistory(eventId)
  }

  /** 测试工具：直接经管道注入一条通知（跳过 HTTP，用于验证展示与提醒样式）。 */
  async testIngest(input: { title?: string; body?: string; level?: NotificationLevel } = {}): Promise<{ eventId: string }> {
    const event = await this.service.ingest({
      sourceKind: 'local-trigger',
      appId: 'test.tool',
      appName: '测试工具',
      title: input.title || '测试通知',
      body: input.body || '这条通知由控制台的测试工具发出，用于验证小岛预览与中岛详情。',
      level: input.level ?? 'info',
    })
    return { eventId: event.eventId }
  }

  /** 重新生成访问令牌：旧令牌立即失效，返回新值 */
  rotateToken(): string {
    const next = rotateToken(this.tokenFile)
    this.options.log('warn', '本地接口访问令牌已重置，旧令牌立即失效')
    return next
  }

  tokenValue(): string {
    return this.token
  }

  private statusPayload(): NotificationModuleStatus {
    const local = this.localTrigger.status()
    const endpoints = this.localTrigger.endpointList()
    return {
      windows: this.windowsSource.status(),
      localTrigger: local,
      endpoint: local.detail ?? null,
      endpoints,
      scope: this.currentScope,
      token: this.token,
      policy: this.service.getPolicy(),
      totalRecords: this.history.size(),
    }
  }

  private async startLocalTrigger(): Promise<void> {
    try {
      await this.localTrigger.start()
    } catch (cause) {
      this.options.log('warn', `本地触发接口未能启动：${String(cause)}`)
      this.options.emit('notif:status', this.statusPayload())
    }
  }

  private async stopLocalTrigger(): Promise<void> {
    try {
      await this.localTrigger.stop()
    } catch {
      // 关闭失败不阻断切换
    }
  }
}

function toItem(record: NotificationRecord): NotificationItem {
  const payload = record.event.payload
  return {
    id: record.event.eventId,
    app: payload.appName || payload.appId,
    title: payload.title,
    content: payload.body,
    ts: Date.parse(record.event.occurredAt) || Date.now(),
    level: payload.level,
    source: payload.sourceKind,
    repeat: record.repeatCount,
    dismissedAt: record.dismissedAt,
  }
}

function parseAppList(value: unknown): string[] {
  return String(value ?? '')
    .split(/[,，;；\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function normalizePort(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_LOCAL_TRIGGER_PORT
  const port = Math.round(parsed)
  if (port < 1024 || port > 65535) return DEFAULT_LOCAL_TRIGGER_PORT
  return port
}

function normalizeScope(value: unknown): LocalTriggerScope {
  return value === 'lan' ? 'lan' : 'local'
}

/** 停留时长设置：非法值回落到该级别的默认值；范围 3–120 秒 */
function normalizeTtlSetting(value: unknown, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(120, Math.max(3, Math.round(parsed)))
}

/** 虚拟网卡名称特征：WSL / Hyper-V / VPN 虚拟交换机等，它们的地址局域网设备根本访问不到 */
const VIRTUAL_ADAPTER_PATTERN = /vethernet|wsl|hyper-?v|virtualbox|vmware|loopback|tunnel|tap[\s_-]|tun[\s_-]|bluetooth/i
/** 物理网卡名称特征：优先展示，局域网设备最可能通过它访问 */
const PHYSICAL_ADAPTER_PATTERN = /ethernet|以太网|wlan|wi-?\s?fi|无线/i

/** 本机局域网可达的 IPv4 地址：过滤虚拟网卡与链路本地地址，物理网卡排前面 */
function lanAddresses(): string[] {
  const candidates: Array<{ physical: boolean; address: string }> = []
  try {
    for (const [name, entries] of Object.entries(networkInterfaces())) {
      if (VIRTUAL_ADAPTER_PATTERN.test(name)) continue
      for (const entry of entries ?? []) {
        if (entry.family !== 'IPv4' || entry.internal) continue
        // 169.254.x.x 是自动私有地址，没有网关，别的设备到不了
        if (entry.address.startsWith('169.254.')) continue
        candidates.push({ physical: PHYSICAL_ADAPTER_PATTERN.test(name), address: entry.address })
      }
    }
  } catch {
    // 取不到网卡信息时退回空列表，端点提示回落回环地址
  }
  candidates.sort((a, b) => Number(b.physical) - Number(a.physical))
  return candidates.map((item) => item.address)
}
