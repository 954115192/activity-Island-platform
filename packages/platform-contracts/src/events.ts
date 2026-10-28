// 领域事件与错误公共结构
// 所有跨服务事件使用统一结构，使用方按 eventId 保证幂等处理。

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
