import type { ServiceError, ServiceErrorCode } from '@activity-island/platform-contracts'

/** 结构化错误：平台服务内部统一抛出，调用方按 code 处理 */
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
