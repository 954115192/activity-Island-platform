// 通知领域契约
// 版本：载荷与事件结构出现不兼容变更时递增 NOTIFICATION_CONTRACT_VERSION。
// 所有来源（Windows 通知中心、本地触发接口、手机同步、扩展）产出同一结构，
// 下游只依赖本契约，不关心来源。

import type { DomainEvent } from './events.ts'

export const NOTIFICATION_CONTRACT_VERSION = 1

export type NotificationLevel = 'info' | 'warn' | 'critical'

export type NotificationSourceKind = 'windows' | 'local-trigger' | 'phone' | 'extension'

export interface NotificationAction {
  id: string
  label: string
  url?: string
}

export interface NotificationPayload {
  /** 来源种类，决定事件 source 的映射与界面徽标 */
  sourceKind: NotificationSourceKind
  /** 来源应用或脚本标识 */
  appId: string
  /** 展示名 */
  appName: string
  title: string
  body: string
  level: NotificationLevel
  group?: string
  /** emoji 或 dataURL */
  icon?: string
  /** 提醒停留秒数；缺省按级别取默认值 */
  ttlSeconds?: number
  /** 同 key 在合并窗口内折叠为同一条通知 */
  dedupeKey?: string
  actions?: NotificationAction[]
  /** 原始载荷，仅诊断用途；标记 sensitive，默认不写入历史 */
  raw?: string
}

export const NOTIFICATION_EVENT = {
  received: 'notification.received',
  updated: 'notification.updated',
  dismissed: 'notification.dismissed',
  actioned: 'notification.actioned',
} as const

export type NotificationEventType = (typeof NOTIFICATION_EVENT)[keyof typeof NOTIFICATION_EVENT]

/** 历史中的一条通知记录，随事件生命周期更新 */
export interface NotificationRecord {
  event: DomainEvent<NotificationPayload>
  /** dedupeKey 合并的重复推送次数 */
  repeatCount: number
  dismissedAt?: string
  actionedAt?: string
  actionedId?: string
}

export type NotificationSourceState = 'stopped' | 'starting' | 'running' | 'degraded' | 'error'

/** Windows 通知监听等来源的系统授权状态 */
export type NotificationAccessState = 'unspecified' | 'denied' | 'allowed' | 'unavailable'

export interface NotificationSourceStatus {
  kind: NotificationSourceKind
  state: NotificationSourceState
  access?: NotificationAccessState
  /** 面向用户的状态说明，只含标识与状态，不含通知内容 */
  detail?: string
  lastEventAt?: string
}

/** 提醒分发策略：只决定是否在岛上提醒，不影响历史记录 */
export interface NotificationPolicy {
  paused: boolean
  /** 模糊匹配应用名或应用标识；空列表 = 全部允许 */
  allowApps: string[]
  /** 优先于 allowApps */
  ignoreApps: string[]
  quietHoursEnabled: boolean
  /** "HH:MM"，支持跨零点区间 */
  quietStart: string
  quietEnd: string
  criticalOverridesQuiet: boolean
}

export interface NotificationHistoryQuery {
  sourceKinds?: NotificationSourceKind[]
  appIds?: string[]
  levels?: NotificationLevel[]
  /** 对标题、正文、应用名、应用标识做不区分大小写的包含匹配 */
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

/** 允许提醒的事件：灵动岛提醒通道只收到通过策略的事件 */
export interface NotificationAlert {
  event: DomainEvent<NotificationPayload>
  /** 已解析的停留秒数 */
  ttlSeconds: number
}

export type Unsubscribe = () => void

export interface NotificationService {
  /** 唯一接入点：归一化、幂等去重、写入历史、按策略分发 */
  ingest(payload: NotificationPayload): Promise<DomainEvent<NotificationPayload>>
  getPolicy(): NotificationPolicy
  updatePolicy(patch: Partial<NotificationPolicy>): Promise<NotificationPolicy>
  /** 全量事件流：历史变更（新通知、合并、撤回）都会经过 */
  onEvent(listener: (record: NotificationRecord) => void): Unsubscribe
  /** 提醒通道：只收到通过分发策略的事件 */
  onAlert(listener: (alert: NotificationAlert) => void): Unsubscribe
  queryHistory(query?: NotificationHistoryQuery): Promise<NotificationHistoryPage>
  dismissHistory(eventId: string): Promise<boolean>
  clearHistory(): Promise<void>
  listSources(): NotificationSourceStatus[]
}

/** 能力标识，供权限服务与扩展 SDK 使用 */
export const NOTIFICATION_CAPABILITIES = {
  readMetadata: 'notifications.read:metadata',
  readContent: 'notifications.read:content',
  queryHistory: 'notifications.query:history',
  manageHistory: 'notifications.manage:history',
  /** 本地触发接口调用方使用的创建能力 */
  createExternal: 'notifications.create:external',
} as const
