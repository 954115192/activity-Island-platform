// 同步自 packages/platform-services/src/notification/sources/local-trigger.ts（双向同步）
import { createHash, timingSafeEqual } from 'node:crypto'
import { NOTIFICATION_CONTRACT_VERSION } from './contracts'
import type {
  NotificationAction,
  NotificationLevel,
  NotificationPayload,
  NotificationSourceState,
  NotificationSourceStatus,
  ServiceErrorCode,
} from './contracts'
import { ServiceFault } from './service-fault'
import type { NotificationIngestResult, IngestOptions } from './service'
import { NodeHttpTransport } from './local-trigger-node'

export interface LocalHttpRequest {
  method: string
  path: string
  query: URLSearchParams
  headers: Record<string, string | string[] | undefined>
  body: Buffer
  /** 请求来源 IP，用于按来源限速（局域网模式下有意义） */
  remoteAddress?: string
}

export interface LocalHttpResponse {
  status: number
  headers?: Record<string, string>
  body?: string
}

export interface LocalHttpTransport {
  listen(options: { host: string; port: number }): Promise<{ actualPort: number }>
  onRequest(handler: (request: LocalHttpRequest) => Promise<LocalHttpResponse>): void
  close(): Promise<void>
}

export const LOCAL_TRIGGER_DEFAULTS = {
  /** 仅本机可访问 */
  host: '127.0.0.1',
  /** 局域网内所有设备可访问 */
  lanHost: '0.0.0.0',
  port: 5720,
  maxBodyBytes: 64 * 1024,
  /** 每个来源 IP 每分钟最多推送条数；局域网模式下的防刷屏兜底 */
  rateLimitPerMinute: 120,
} as const

export const DEFAULT_LOCAL_TRIGGER_PORT: number = LOCAL_TRIGGER_DEFAULTS.port

/** 可访问范围：仅本机 / 局域网内所有设备 */
export type LocalTriggerScope = 'local' | 'lan'

export function hostForScope(scope: LocalTriggerScope): string {
  return scope === 'lan' ? LOCAL_TRIGGER_DEFAULTS.lanHost : LOCAL_TRIGGER_DEFAULTS.host
}

/** 触发源需要的接入能力（ingestEntry + 撤回） */
export type TriggerIngress = {
  ingestEntry(payload: NotificationPayload, options?: IngestOptions): Promise<NotificationIngestResult>
  dismissHistory(eventId: string): Promise<boolean>
}

export interface LocalTriggerOptions {
  ingress: TriggerIngress
  token: string
  host?: string
  port?: number
  maxBodyBytes?: number
  /** 局域网模式下展示给用户的地址列表（本机网卡 IP），用于拼接端点提示 */
  displayHosts?: string[]
  rateLimitPerMinute?: number
}

export interface LocalTriggerHandlerDeps {
  ingress: TriggerIngress
  resolveToken: () => Promise<string>
  maxBodyBytes: number
}

const TITLE_MAX = 200
const BODY_MAX = 4000

interface TriggerFields {
  title: string
  body: string
  level?: NotificationLevel
  ttl?: number
  appId?: string
  appName?: string
  dedupeKey?: string
  group?: string
  icon?: string
  actions?: NotificationAction[]
}

/** 本地触发接口 v1：GET health / POST notifications / DELETE notifications/{id} */
export async function handleLocalTriggerRequest(
  request: LocalHttpRequest,
  deps: LocalTriggerHandlerDeps,
): Promise<LocalHttpResponse> {
  const method = request.method.toUpperCase()
  const path = request.path

  if (path === '/api/v1/health' && (method === 'GET' || method === 'HEAD')) {
    return json(200, { ok: true, service: 'notification-local-trigger', contractVersion: NOTIFICATION_CONTRACT_VERSION })
  }

  if (method === 'OPTIONS') {
    return json(405, faultBody('invalid-request', 'OPTIONS 未支持'))
  }

  if (path === '/api/v1/notifications' && method === 'POST') {
    return handleCreate(request, deps)
  }

  if (path.startsWith('/api/v1/notifications/') && method === 'DELETE') {
    const denied = await checkAuth(request, deps.resolveToken)
    if (denied) return denied
    const eventId = decodeURIComponent(path.slice('/api/v1/notifications/'.length))
    try {
      const dismissed = await deps.ingress.dismissHistory(eventId)
      return dismissed ? json(200, { ok: true }) : json(404, faultBody('not-found', '通知不存在或已被移除'))
    } catch (cause) {
      return faultResponse(cause)
    }
  }

  if (path === '/api/v1/notifications' || path.startsWith('/api/v1/notifications/')) {
    return json(405, faultBody('invalid-request', `方法 ${method} 不支持`))
  }

  return json(404, faultBody('not-found', '未知路径'))
}

async function handleCreate(request: LocalHttpRequest, deps: LocalTriggerHandlerDeps): Promise<LocalHttpResponse> {
  const denied = await checkAuth(request, deps.resolveToken)
  if (denied) return denied

  if (request.body.length > deps.maxBodyBytes) {
    return json(413, faultBody('invalid-request', '请求体超过大小上限'))
  }

  const fields = extractTriggerFields(request)
  if (!fields.title && !fields.body) {
    return json(400, faultBody('invalid-request', '需要 title 或 content 字段'))
  }
  if (!fields.title) {
    fields.title = fields.body.split('\n')[0].slice(0, 80)
  }

  try {
    const result = await deps.ingress.ingestEntry({
      sourceKind: 'local-trigger',
      appId: fields.appId ?? 'local.script',
      appName: fields.appName ?? '本地接口',
      title: fields.title,
      body: fields.body,
      level: fields.level ?? 'info',
      ttlSeconds: fields.ttl,
      dedupeKey: fields.dedupeKey,
      group: fields.group,
      icon: fields.icon,
      actions: fields.actions,
    })
    return json(202, {
      ok: true,
      eventId: result.event.eventId,
      occurredAt: result.event.occurredAt,
      deduped: result.deduped,
    })
  } catch (cause) {
    return faultResponse(cause)
  }
}

async function checkAuth(
  request: LocalHttpRequest,
  resolveToken: () => Promise<string>,
): Promise<LocalHttpResponse | undefined> {
  const expected = await resolveToken()
  const header = headerValue(request.headers, 'authorization')
  const match = /^Bearer\s+(.+)$/i.exec(header)
  const provided = match?.[1]?.trim() ?? ''
  if (!provided || !safeEqual(provided, expected)) {
    return json(401, faultBody('permission-denied', '缺少或无效的访问令牌'))
  }
  return undefined
}

function safeEqual(provided: string, expected: string): boolean {
  const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest()
  return timingSafeEqual(digest(provided), digest(expected))
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string {
  const value = headers[name]
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

function extractTriggerFields(request: LocalHttpRequest): TriggerFields {
  const out: TriggerFields = { title: '', body: '' }
  const bodyText = request.body.toString('utf8')
  const contentType = headerValue(request.headers, 'content-type').toLowerCase()
  const trimmed = bodyText.trimStart()

  let obj: Record<string, unknown> | undefined
  if (bodyText && (contentType.includes('json') || trimmed.startsWith('{'))) {
    obj = tryParseObject(bodyText)
  }

  const values = new URLSearchParams(request.query)
  if (contentType.includes('x-www-form-urlencoded') && bodyText) {
    for (const [key, value] of new URLSearchParams(bodyText)) values.append(key, value)
  }

  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      if (obj) {
        const value = obj[key]
        // JSON 字段可能是数字（如 ttl: 20），统一转成字符串
        if (typeof value === 'string' && value.trim()) return value.trim()
        if (typeof value === 'number' && Number.isFinite(value)) return String(value)
      }
      const value = values.get(key)
      if (value && value.trim()) return value.trim()
    }
    return ''
  }

  out.title = pick('title', 'Title', 'name', 'subject')
  out.body = pick('content', 'Content', 'message', 'text', 'body', 'desc')
  out.level = normalizeLevel(pick('level', 'Level'))
  out.ttl = normalizeTtl(pick('ttl', 'Ttl'))
  out.dedupeKey = pick('dedupeKey', 'dedupe_key') || undefined
  out.group = pick('group') || undefined
  out.icon = pick('icon') || undefined
  out.appId = pick('appId', 'app_id') || undefined
  out.appName = pick('appName', 'app_name') || undefined

  const appRaw = obj?.['app']
  if (typeof appRaw === 'string' && appRaw.trim()) {
    out.appId = out.appId || appRaw.trim()
    out.appName = out.appName || appRaw.trim()
  } else if (appRaw && typeof appRaw === 'object') {
    const app = appRaw as Record<string, unknown>
    if (hasText(app['id'])) out.appId = out.appId || textOf(app['id']).trim()
    if (hasText(app['name'])) out.appName = out.appName || textOf(app['name']).trim()
  }

  if (Array.isArray(obj?.['actions'])) out.actions = sanitizeActions(obj['actions'])

  if (!out.title && !out.body && bodyText && !obj) {
    const lines = bodyText.split(/\r?\n/)
    out.title = (lines[0] ?? '').trim().slice(0, TITLE_MAX)
    out.body = lines.slice(1).join('\n').trim().slice(0, BODY_MAX)
  }
  return out
}

function tryParseObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // 解析失败按纯文本处理
  }
  return undefined
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function normalizeLevel(value: string): NotificationLevel | undefined {
  const level = value.trim().toLowerCase()
  return level === 'info' || level === 'warn' || level === 'critical' ? level : undefined
}

function normalizeTtl(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return undefined
  return Math.min(60, Math.max(3, parsed))
}

function sanitizeActions(raw: unknown): NotificationAction[] | undefined {
  const actions = (raw as unknown[])
    .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
    .map((entry) => ({
      id: textOf(entry['id']).trim().slice(0, 60),
      label: textOf(entry['label']).trim().slice(0, 40),
      url: hasText(entry['url']) ? textOf(entry['url']).trim() : undefined,
    }))
    .filter((action) => action.id && action.label)
    .slice(0, 4)
  return actions.length > 0 ? actions : undefined
}

const STATUS_BY_CODE: Record<ServiceErrorCode, number> = {
  'invalid-request': 400,
  'permission-denied': 403,
  'not-found': 404,
  conflict: 409,
  unavailable: 503,
  cancelled: 400,
  internal: 500,
}

function faultResponse(cause: unknown): LocalHttpResponse {
  const fault = cause instanceof ServiceFault ? cause : new ServiceFault('internal', '处理请求失败')
  return json(STATUS_BY_CODE[fault.code], {
    ok: false,
    error: { code: fault.code, message: fault.message, retryable: fault.retryable },
  })
}

function faultBody(code: ServiceErrorCode, message: string): Record<string, unknown> {
  return { ok: false, error: { code, message, retryable: false } }
}

function json(status: number, data: unknown): LocalHttpResponse {
  return {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(data),
  }
}

/** 本地触发通知来源：回环或局域网 HTTP 端点，接收本机/局域网程序推送的通知 */
export class LocalTriggerSource {
  readonly kind = 'local-trigger' as const

  private readonly options: LocalTriggerOptions
  private readonly transport: LocalHttpTransport
  private state: NotificationSourceState = 'stopped'
  private detail: string | undefined
  private endpoints: string[] = []
  private lastEventAt: string | undefined
  private started = false
  /** 每个来源 IP 的滑动窗口计数，防止局域网内单个来源刷屏 */
  private readonly buckets = new Map<string, { count: number; windowStart: number }>()

  constructor(options: LocalTriggerOptions, transport: LocalHttpTransport = new NodeHttpTransport()) {
    this.options = options
    this.transport = transport
  }

  async start(): Promise<void> {
    if (this.started) return
    this.state = 'starting'
    this.transport.onRequest(async (request) => {
      if (!this.allowRequest(request.remoteAddress)) {
        return {
          status: 429,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '60' },
          body: '{"ok":false,"error":{"code":"invalid-request","message":"请求过于频繁，请稍后再试","retryable":true}}',
        }
      }
      const response = await handleLocalTriggerRequest(request, {
        ingress: this.options.ingress,
        resolveToken: async () => this.options.token,
        maxBodyBytes: this.options.maxBodyBytes ?? LOCAL_TRIGGER_DEFAULTS.maxBodyBytes,
      })
      if (response.status === 202) this.lastEventAt = new Date().toISOString()
      return response
    })
    try {
      const host = this.options.host ?? LOCAL_TRIGGER_DEFAULTS.host
      const { actualPort } = await this.transport.listen({
        host,
        port: this.options.port ?? LOCAL_TRIGGER_DEFAULTS.port,
      })
      this.started = true
      this.state = 'running'
      // 局域网绑定时对外提示用本机网卡地址；没有可用地址就退回回环。
      const displayHosts = host === LOCAL_TRIGGER_DEFAULTS.lanHost
        ? (this.options.displayHosts?.length ? this.options.displayHosts : [LOCAL_TRIGGER_DEFAULTS.host])
        : [LOCAL_TRIGGER_DEFAULTS.host]
      this.endpoints = displayHosts.map((item) => `http://${item}:${actualPort}/api/v1/notifications`)
      this.detail = this.endpoints[0]
    } catch (cause) {
      this.state = 'error'
      this.detail = describeBindError(cause)
      this.endpoints = []
      throw new ServiceFault('conflict', this.detail, { retryable: true })
    }
  }

  /** 全部可访问端点（局域网模式下可能有多个网卡地址），供设置页展示 */
  endpointList(): string[] {
    return [...this.endpoints]
  }

  private allowRequest(remoteAddress: string | undefined): boolean {
    const limit = this.options.rateLimitPerMinute ?? LOCAL_TRIGGER_DEFAULTS.rateLimitPerMinute
    if (limit <= 0) return true
    const key = remoteAddress || 'unknown'
    const now = Date.now()
    const bucket = this.buckets.get(key)
    if (!bucket || now - bucket.windowStart >= 60_000) {
      this.buckets.set(key, { count: 1, windowStart: now })
      return true
    }
    if (bucket.count >= limit) return false
    bucket.count += 1
    return true
  }

  async stop(): Promise<void> {
    if (this.started) await this.transport.close()
    this.started = false
    this.state = 'stopped'
    this.detail = undefined
    this.endpoints = []
    this.buckets.clear()
  }

  status(): NotificationSourceStatus {
    return {
      kind: this.kind,
      state: this.state,
      detail: this.detail,
      lastEventAt: this.lastEventAt,
    }
  }
}

function describeBindError(cause: unknown): string {
  const code = (cause as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EADDRINUSE') return '监听端口已被占用，请在设置中更换端口'
  if (code === 'EACCES') return '监听端口被拒绝，该端口需要管理员权限或已被系统保留'
  return '本地触发接口监听失败'
}
