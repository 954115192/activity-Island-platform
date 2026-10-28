import type {
  NotificationPayload,
  NotificationSourceKind,
  NotificationSourceStatus,
} from '@activity-island/platform-contracts'
import type { NotificationIngestResult } from '../service.ts'

/** 来源适配器：把一种外部通知流接入统一管道 */
export interface NotificationSource {
  readonly kind: NotificationSourceKind
  start(): Promise<void>
  stop(): Promise<void>
  status(): NotificationSourceStatus
}

/** 来源构造事件时需要的最小接入能力 */
export type SourceIngress = {
  ingestEntry(payload: NotificationPayload): Promise<NotificationIngestResult>
}
