// 同步自 packages/platform-services/src/notification/history.ts（双向同步）
import type {
  DomainEvent,
  NotificationHistoryPage,
  NotificationHistoryQuery,
  NotificationPayload,
  NotificationRecord,
} from './contracts'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface HistoryStore {
  append(event: DomainEvent<NotificationPayload>): NotificationRecord
  get(eventId: string): NotificationRecord | undefined
  update(eventId: string, patch: Partial<Omit<NotificationRecord, 'event'>>): NotificationRecord | undefined
  bumpRepeat(eventId: string): NotificationRecord | undefined
  /** dedupeKey 命中查找：跨服务实例（应用重启后的存量回填）也能与旧记录合并 */
  findLatestByDedupeKey(payload: NotificationPayload): NotificationRecord | undefined
  query(query?: NotificationHistoryQuery): NotificationHistoryPage
  clear(): void
  size(): number
}

export interface InMemoryHistoryStoreOptions {
  maxRecords?: number
  maxAgeMs?: number
  clock?: () => Date
}

export class InMemoryHistoryStore implements HistoryStore {
  protected readonly records: NotificationRecord[] = []
  private readonly maxRecords: number
  private readonly maxAgeMs: number | undefined
  private readonly clock: () => Date

  constructor(options: InMemoryHistoryStoreOptions = {}) {
    this.maxRecords = Math.max(1, options.maxRecords ?? 500)
    this.maxAgeMs = options.maxAgeMs
    this.clock = options.clock ?? (() => new Date())
  }

  append(event: DomainEvent<NotificationPayload>): NotificationRecord {
    const payload: NotificationPayload =
      event.sensitivity === 'sensitive' && event.payload.raw !== undefined
        ? { ...event.payload, raw: undefined }
        : event.payload
    const record: NotificationRecord = { event: { ...event, payload }, repeatCount: 0 }
    this.records.unshift(record)
    this.trim()
    return record
  }

  get(eventId: string): NotificationRecord | undefined {
    return this.records.find((record) => record.event.eventId === eventId)
  }

  update(eventId: string, patch: Partial<Omit<NotificationRecord, 'event'>>): NotificationRecord | undefined {
    const record = this.get(eventId)
    if (!record) return undefined
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) Object.assign(record, { [key]: value })
    }
    return record
  }

  bumpRepeat(eventId: string): NotificationRecord | undefined {
    const record = this.get(eventId)
    if (!record) return undefined
    record.repeatCount += 1
    return record
  }

  findLatestByDedupeKey(payload: NotificationPayload): NotificationRecord | undefined {
    if (!payload.dedupeKey) return undefined
    return this.records.find((record) => {
      const candidate = record.event.payload
      return (
        candidate.dedupeKey === payload.dedupeKey &&
        candidate.sourceKind === payload.sourceKind &&
        candidate.appId === payload.appId
      )
    })
  }

  query(query: NotificationHistoryQuery = {}): NotificationHistoryPage {
    const search = query.search?.trim().toLowerCase() ?? ''
    const filtered = this.records.filter((record) => {
      const payload = record.event.payload
      if (query.sourceKinds && !query.sourceKinds.includes(payload.sourceKind)) return false
      if (query.appIds && !query.appIds.includes(payload.appId)) return false
      if (query.levels && !query.levels.includes(payload.level)) return false
      if (query.since && record.event.occurredAt < query.since) return false
      if (query.until && record.event.occurredAt > query.until) return false
      if (search) {
        const haystack = `${payload.title} ${payload.body} ${payload.appName} ${payload.appId}`.toLowerCase()
        if (!haystack.includes(search)) return false
      }
      return true
    })
    const offset = Math.max(0, query.offset ?? 0)
    const limit = query.limit && query.limit > 0 ? query.limit : filtered.length
    return { items: filtered.slice(offset, offset + limit), total: filtered.length }
  }

  clear(): void {
    this.records.length = 0
  }

  size(): number {
    return this.records.length
  }

  exportAll(): NotificationRecord[] {
    return [...this.records]
  }

  restore(records: NotificationRecord[]): void {
    this.records.length = 0
    this.records.push(...records)
    this.trim()
  }

  private trim(): void {
    if (this.maxAgeMs !== undefined) {
      const cutoff = this.clock().getTime() - this.maxAgeMs
      for (let index = this.records.length - 1; index >= 0; index -= 1) {
        if (Date.parse(this.records[index].event.occurredAt) < cutoff) this.records.length = index
      }
    }
    if (this.records.length > this.maxRecords) this.records.length = this.maxRecords
  }
}

export interface JsonFileHistoryStoreOptions extends InMemoryHistoryStoreOptions {
  filePath: string
  saveDelayMs?: number
}

const HISTORY_FILE_VERSION = 1

/** JSON 文件历史存储：内存 + 延迟全量落盘（临时文件 + 原子替换）。 */
export class JsonFileHistoryStore implements HistoryStore {
  private readonly inner: InMemoryHistoryStore
  private readonly filePath: string
  private readonly saveDelayMs: number
  private saveTimer: ReturnType<typeof setTimeout> | undefined

  constructor(options: JsonFileHistoryStoreOptions) {
    this.filePath = options.filePath
    this.saveDelayMs = options.saveDelayMs ?? 500
    this.inner = new InMemoryHistoryStore(options)
    mkdirSync(dirname(this.filePath), { recursive: true })
    this.load()
  }

  private load(): void {
    let text: string
    try {
      text = readFileSync(this.filePath, 'utf8')
    } catch {
      return
    }
    try {
      const parsed = JSON.parse(text) as { version?: number; records?: NotificationRecord[] }
      if (parsed.version === HISTORY_FILE_VERSION && Array.isArray(parsed.records)) {
        this.inner.restore(parsed.records)
      }
    } catch {
      // 损坏文件视为空历史，等待下次保存覆盖
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      this.saveNow()
    }, this.saveDelayMs)
    this.saveTimer.unref?.()
  }

  saveNow(): void {
    const data = { version: HISTORY_FILE_VERSION, records: this.inner.exportAll() }
    const temporary = `${this.filePath}.tmp`
    writeFileSync(temporary, JSON.stringify(data), 'utf8')
    renameSync(temporary, this.filePath)
  }

  append(event: DomainEvent<NotificationPayload>): NotificationRecord {
    const record = this.inner.append(event)
    this.scheduleSave()
    return record
  }

  get(eventId: string): NotificationRecord | undefined {
    return this.inner.get(eventId)
  }

  update(eventId: string, patch: Partial<Omit<NotificationRecord, 'event'>>): NotificationRecord | undefined {
    const record = this.inner.update(eventId, patch)
    if (record) this.scheduleSave()
    return record
  }

  bumpRepeat(eventId: string): NotificationRecord | undefined {
    const record = this.inner.bumpRepeat(eventId)
    if (record) this.scheduleSave()
    return record
  }

  findLatestByDedupeKey(payload: NotificationPayload): NotificationRecord | undefined {
    return this.inner.findLatestByDedupeKey(payload)
  }

  query(query?: NotificationHistoryQuery): NotificationHistoryPage {
    return this.inner.query(query)
  }

  clear(): void {
    this.inner.clear()
    this.scheduleSave()
  }

  size(): number {
    return this.inner.size()
  }
}
