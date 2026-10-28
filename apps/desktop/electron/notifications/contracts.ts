// 同步自 packages/platform-contracts/src/events.ts 与 notification.ts
// （Electron 主进程为 CommonJS 编译，无法直接消费 ESM 源码包；改动需双向同步。）

export type EventSensitivity = 'public' | 'private' | 'sensitive'

export type EventSource = 'desktop' | 'phone' | 'platform' | 'module' | 'extension' | 'external'

export interface DomainEvent<TPayload = unknown> {
  eventId: string
  type: string
  version: number
  occurredAt: string
  source: EventSource
  subject?: string
  sensitivity: EventSensitivity
  payload: TPayload
}

export type ServiceErrorCode =
  | 'permission-denied'
  | 'not-found'
  | 'unavailable'
  | 'conflict'
  | 'invalid-request'
  | 'cancelled'
  | 'internal'

export interface ServiceError {
  code: ServiceErrorCode
  message: string
  retryable: boolean
  requestId?: string
}

export const NOTIFICATION_CONTRACT_VERSION = 1

export type NotificationLevel = 'info' | 'warn' | 'critical'

export type NotificationSourceKind = 'windows' | 'local-trigger' | 'phone' | 'extension'

export interface NotificationAction {
  id: string
  label: string
  url?: string
}

export interface NotificationPayload {
  sourceKind: NotificationSourceKind
  appId: string
  appName: string
  title: string
  body: string
  level: NotificationLevel
  group?: string
  icon?: string
  ttlSeconds?: number
  dedupeKey?: string
  actions?: NotificationAction[]
  raw?: string
}

export const NOTIFICATION_EVENT = {
  received: 'notification.received',
  updated: 'notification.updated',
  dismissed: 'notification.dismissed',
  actioned: 'notification.actioned',
} as const

export interface NotificationRecord {
  event: DomainEvent<NotificationPayload>
  repeatCount: number
  dismissedAt?: string
  actionedAt?: string
  actionedId?: string
}

export type NotificationSourceState = 'stopped' | 'starting' | 'running' | 'degraded' | 'error'

export type NotificationAccessState = 'unspecified' | 'denied' | 'allowed' | 'unavailable'

export interface NotificationSourceStatus {
  kind: NotificationSourceKind
  state: NotificationSourceState
  access?: NotificationAccessState
  detail?: string
  lastEventAt?: string
}

export interface NotificationPolicy {
  paused: boolean
  allowApps: string[]
  ignoreApps: string[]
  quietHoursEnabled: boolean
  quietStart: string
  quietEnd: string
  criticalOverridesQuiet: boolean
}

export interface NotificationHistoryQuery {
  sourceKinds?: NotificationSourceKind[]
  appIds?: string[]
  levels?: NotificationLevel[]
  search?: string
  since?: string
  until?: string
  limit?: number
  offset?: number
}

export interface NotificationHistoryPage {
  items: NotificationRecord[]
  total: number
}

export interface NotificationAlert {
  event: DomainEvent<NotificationPayload>
  ttlSeconds: number
}

export type Unsubscribe = () => void
