export type EventSensitivity = 'public' | 'private' | 'sensitive'

export type EventSource = 'desktop' | 'phone' | 'platform' | 'module' | 'extension'

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
