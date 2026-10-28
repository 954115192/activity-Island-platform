import {
  NOTIFICATION_CONTRACT_VERSION,
  NOTIFICATION_EVENT,
} from '@activity-island/platform-contracts'
import type {
  DomainEvent,
  EventSource,
  NotificationAction,
  NotificationAlert,
  NotificationHistoryPage,
  NotificationHistoryQuery,
  NotificationLevel,
  NotificationPayload,
  NotificationPolicy,
  NotificationRecord,
  NotificationService,
  NotificationSourceKind,
  NotificationSourceStatus,
  Unsubscribe,
} from '@activity-island/platform-contracts'
import { ServiceFault } from '../util/service-fault.ts'
import { DEFAULT_POLICY, DEFAULT_TTL_SECONDS, parseHm, shouldAlert } from './policy.ts'
import type { HistoryStore } from './history.ts'
import { InMemoryHistoryStore } from './history.ts'
import type { NotificationSource } from './sources/source.ts'

/** 历史查询与撤回能力：本地触发接口等内部使用方依赖此子集 */
export interface NotificationHistoryAccess {
  ingestEntry(payload: NotificationPayload): Promise<NotificationIngestResult>
  dismissHistory(eventId: string): Promise<boolean>
}

export interface NotificationIngestResult {
  event: DomainEvent<NotificationPayload>
  /** dedupeKey 命中合并时为 true，eventId 为已有通知 */
  deduped: boolean
}

/** 来源适配器的接入入口 */
export type NotificationIngress = Pick<NotificationHistoryAccess, 'ingestEntry'>

const DEDUPE_WINDOW_MS = 60_000
const SOURCE_KINDS: NotificationSourceKind[] = ['windows', 'local-trigger', 'phone', 'extension']
const TITLE_MAX = 200
const BODY_MAX = 4000
const APP_ID_MAX = 120
const APP_NAME_MAX = 60
const TTL_MAX = 300
const ACTIONS_MAX = 4

/** 来源种类 → 事件来源字段的映射 */
export function sourceKindToEventSource(kind: NotificationSourceKind): EventSource {
  switch (kind) {
    case 'windows':
      return 'desktop'
    case 'phone':
      return 'phone'
    case 'local-trigger':
      return 'external'
    case 'extension':
      return 'extension'
  }
}

export interface NotificationServiceOptions {
  history?: HistoryStore
  policy?: Partial<NotificationPolicy>
  clock?: () => Date
  idFactory?: () => string
  /** dedupeKey 合并窗口，默认 60 秒 */
  dedupeWindowMs?: number
  /** 各级别的默认停留秒数（载荷未带 ttl 时生效），缺省 info=8 / warn=10 / critical=15 */
  defaultTtl?: Partial<Record<NotificationLevel, number>>
}

/**
 * 通知服务：唯一接入点。
 * 管道顺序：归一化 → eventId 幂等 → dedupeKey 合并 → 写入历史 → 按策略分发。
 * 历史全量保留（受存储保留策略约束），分发策略只影响提醒通道。
 */
export class NotificationServiceImpl implements NotificationService {
  private readonly history: HistoryStore
  private policy: NotificationPolicy
  private readonly clock: () => Date
  private readonly idFactory: () => string
  private readonly dedupeWindowMs: number
  private defaultTtl: Record<NotificationLevel, number>
  private readonly dedupeIndex = new Map<string, { eventId: string; at: number }>()
  private readonly eventListeners = new Set<(record: NotificationRecord) => void>()
  private readonly alertListeners = new Set<(alert: NotificationAlert) => void>()
  private readonly sources = new Set<NotificationSource>()

  constructor(options: NotificationServiceOptions = {}) {
    this.history = options.history ?? new InMemoryHistoryStore()
    this.policy = { ...DEFAULT_POLICY, ...options.policy }
    this.clock = options.clock ?? (() => new Date())
    this.idFactory = options.idFactory ?? defaultIdFactory
    this.dedupeWindowMs = Math.max(0, options.dedupeWindowMs ?? DEDUPE_WINDOW_MS)
    this.defaultTtl = { ...DEFAULT_TTL_SECONDS, ...options.defaultTtl }
  }

  /** 更新各级别的默认停留秒数；接口载荷里显式带的 ttl 不受影响 */
  setDefaultTtl(ttl: Partial<Record<NotificationLevel, number>>): void {
    for (const level of ['info', 'warn', 'critical'] as NotificationLevel[]) {
      const seconds = ttl[level]
      if (typeof seconds === 'number' && Number.isFinite(seconds)) {
        this.defaultTtl[level] = clamp(Math.round(seconds), 1, TTL_MAX)
      }
    }
  }

  getDefaultTtl(): Record<NotificationLevel, number> {
    return { ...this.defaultTtl }
  }

  async ingest(payload: NotificationPayload): Promise<DomainEvent<NotificationPayload>> {
    return (await this.ingestEntry(payload)).event
  }

  async ingestEntry(payload: NotificationPayload): Promise<NotificationIngestResult> {
    const normalized = normalizePayload(payload)
    const now = this.clock()

    if (normalized.dedupeKey) {
      const existing = this.findDeduped(normalized, now)
      if (existing) {
        const record = this.history.bumpRepeat(existing.eventId)
        if (record) {
          this.emitEvent(record)
          return { event: record.event, deduped: true }
        }
      }
    }

    const event: DomainEvent<NotificationPayload> = {
      eventId: this.idFactory(),
      type: NOTIFICATION_EVENT.received,
      version: NOTIFICATION_CONTRACT_VERSION,
      occurredAt: now.toISOString(),
      source: sourceKindToEventSource(normalized.sourceKind),
      subject: normalized.appId,
      sensitivity: normalized.raw !== undefined ? 'sensitive' : 'private',
      payload: normalized,
    }

    const record = this.history.append(event)
    if (normalized.dedupeKey) {
      this.dedupeIndex.set(dedupeIndexKey(normalized), { eventId: event.eventId, at: now.getTime() })
    }
    this.emitEvent(record)

    if (shouldAlert(this.policy, normalized, now)) {
      const alert: NotificationAlert = {
        event,
        ttlSeconds: normalized.ttlSeconds ?? this.defaultTtl[normalized.level],
      }
      for (const listener of this.alertListeners) listener(alert)
    }

    return { event, deduped: false }
  }

  getPolicy(): NotificationPolicy {
    return { ...this.policy }
  }

  async updatePolicy(patch: Partial<NotificationPolicy>): Promise<NotificationPolicy> {
    if (patch.quietStart !== undefined && parseHm(patch.quietStart) === null) {
      throw new ServiceFault('invalid-request', '免打扰开始时间的格式应为 HH:MM')
    }
    if (patch.quietEnd !== undefined && parseHm(patch.quietEnd) === null) {
      throw new ServiceFault('invalid-request', '免打扰结束时间的格式应为 HH:MM')
    }
    this.policy = { ...this.policy, ...patch }
    return this.getPolicy()
  }

  onEvent(listener: (record: NotificationRecord) => void): Unsubscribe {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onAlert(listener: (alert: NotificationAlert) => void): Unsubscribe {
    this.alertListeners.add(listener)
    return () => this.alertListeners.delete(listener)
  }

  async queryHistory(query?: NotificationHistoryQuery): Promise<NotificationHistoryPage> {
    return this.history.query(query)
  }

  async dismissHistory(eventId: string): Promise<boolean> {
    // 已撤回的通知无可再撤，视为不存在
    const existing = this.history.get(eventId)
    if (!existing || existing.dismissedAt) return false
    const record = this.history.update(eventId, { dismissedAt: this.clock().toISOString() })
    if (!record) return false
    this.emitEvent(record)
    return true
  }

  async clearHistory(): Promise<void> {
    this.history.clear()
    this.dedupeIndex.clear()
  }

  listSources(): NotificationSourceStatus[] {
    return [...this.sources].map((source) => source.status())
  }

  registerSource(source: NotificationSource): void {
    this.sources.add(source)
  }

  async startAllSources(): Promise<void> {
    for (const source of this.sources) await source.start()
  }

  async stopAllSources(): Promise<void> {
    for (const source of this.sources) await source.stop()
  }

  private findDeduped(payload: NotificationPayload, now: Date): { eventId: string } | undefined {
    const seen = this.dedupeIndex.get(dedupeIndexKey(payload))
    if (!seen) return undefined
    if (now.getTime() - seen.at >= this.dedupeWindowMs) {
      this.dedupeIndex.delete(dedupeIndexKey(payload))
      return undefined
    }
    return seen
  }

  private emitEvent(record: NotificationRecord): void {
    for (const listener of this.eventListeners) {
      try {
        listener(record)
      } catch (cause) {
        console.error('[notification] 事件监听器执行失败', cause)
      }
    }
  }
}

function dedupeIndexKey(payload: NotificationPayload): string {
  return `${payload.sourceKind}:${payload.appId}:${payload.dedupeKey ?? ''}`
}

function defaultIdFactory(): string {
  return crypto.randomUUID()
}

function normalizePayload(payload: NotificationPayload): NotificationPayload {
  if (payload === null || typeof payload !== 'object') {
    throw new ServiceFault('invalid-request', '通知载荷必须是对象')
  }
  if (!SOURCE_KINDS.includes(payload.sourceKind)) {
    throw new ServiceFault('invalid-request', `未知的通知来源种类：${String(payload.sourceKind)}`)
  }

  const title = textOf(payload.title).trim()
  const appId = textOf(payload.appId).trim()
  if (!title) throw new ServiceFault('invalid-request', '通知缺少标题')
  if (!appId) throw new ServiceFault('invalid-request', '通知缺少来源标识')

  const level: NotificationPayload['level'] =
    payload.level === 'warn' || payload.level === 'critical' ? payload.level : 'info'

  const normalized: NotificationPayload = {
    ...payload,
    appId: appId.slice(0, APP_ID_MAX),
    appName: textOf(payload.appName).slice(0, APP_NAME_MAX) || appId.slice(0, APP_NAME_MAX),
    title: title.slice(0, TITLE_MAX),
    body: textOf(payload.body).slice(0, BODY_MAX),
    level,
  }

  if (typeof payload.ttlSeconds === 'number' && Number.isFinite(payload.ttlSeconds)) {
    normalized.ttlSeconds = clamp(Math.round(payload.ttlSeconds), 1, TTL_MAX)
  }
  const actions = normalizeActions(payload.actions)
  if (actions) normalized.actions = actions
  return normalized
}

function normalizeActions(actions: NotificationAction[] | undefined): NotificationAction[] | undefined {
  if (!Array.isArray(actions)) return undefined
  const sanitized = actions
    .filter((action) => action !== null && typeof action === 'object')
    .map((action) => ({
      id: textOf(action.id).slice(0, 60),
      label: textOf(action.label).slice(0, 40),
      url: typeof action.url === 'string' && action.url.trim() ? action.url.trim() : undefined,
    }))
    .filter((action) => action.id && action.label)
    .slice(0, ACTIONS_MAX)
  return sanitized.length > 0 ? sanitized : undefined
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
