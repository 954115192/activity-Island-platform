// 同步自 packages/platform-services/src/util/service-fault.ts（双向同步）
import type { ServiceError, ServiceErrorCode } from './contracts'

export class ServiceFault extends Error implements ServiceError {
  code: ServiceErrorCode
  retryable: boolean
  requestId?: string

  constructor(code: ServiceErrorCode, message: string, options?: { retryable?: boolean; requestId?: string }) {
    super(message)
    this.name = 'ServiceFault'
    this.code = code
    this.retryable = options?.retryable ?? false
    this.requestId = options?.requestId
  }
}

export function isServiceFault(cause: unknown): cause is ServiceFault {
  return cause instanceof ServiceFault
}
