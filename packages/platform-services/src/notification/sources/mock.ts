import type {
  DomainEvent,
  NotificationAccessState,
  NotificationPayload,
  NotificationSourceKind,
  NotificationSourceState,
  NotificationSourceStatus,
} from '@activity-island/platform-contracts'
import type { NotificationSource, SourceIngress } from './source.ts'
const SAMPLES: Array<Partial<NotificationPayload>> = [
  {
    appId: 'com.example.pipeline',
    appName: '流水线',
    title: '构建完成',
    body: 'main 分支 #128 通过，用时 42 秒。',
    level: 'info',
  },
  {
    appId: 'com.example.backup',
    appName: '备份',
    title: '磁盘空间不足',
    body: 'C 盘剩余空间低于 10%，请清理临时文件。',
    level: 'warn',
  },
  {
    appId: 'com.example.mail',
    appName: '邮件',
    title: '新邮件',
    body: '这是一封用于验证展示流程的示例邮件。',
    level: 'info',
  },
]

export interface MockNotificationSourceOptions {
  /** 模拟的来源种类，默认 windows */
  kind?: NotificationSourceKind
  appName?: string
  /** 大于 0 时周期性发送内置样例通知 */
  intervalMs?: number
}

/** 模拟通知来源：开发与测试工具，使界面与管道不依赖真实 Windows 通知状态 */
export class MockNotificationSource implements NotificationSource {
  readonly kind: NotificationSourceKind
  private readonly ingress: SourceIngress
  private readonly appName: string
  private readonly intervalMs: number
  private state: NotificationSourceState = 'stopped'
  private access: NotificationAccessState = 'allowed'
  private lastEventAt: string | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private seq = 0

  constructor(ingress: SourceIngress, options: MockNotificationSourceOptions = {}) {
    this.ingress = ingress
    this.kind = options.kind ?? 'windows'
    this.appName = options.appName ?? '模拟通知'
    this.intervalMs = options.intervalMs ?? 0
  }

  async start(): Promise<void> {
    if (this.timer) return
    this.state = 'running'
    if (this.intervalMs > 0) {
      const tick = async (): Promise<void> => {
        const sample = SAMPLES[this.seq % SAMPLES.length]
        this.seq += 1
        try {
          await this.emit(sample)
        } catch {
          // 模拟来源的周期发送失败不影响后续轮次
        }
        this.timer = setTimeout(() => void tick(), this.intervalMs)
      }
      this.timer = setTimeout(() => void tick(), this.intervalMs)
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.state = 'stopped'
  }

  status(): NotificationSourceStatus {
    return {
      kind: this.kind,
      state: this.state,
      access: this.access,
      detail: '内置模拟来源，用于开发与测试',
      lastEventAt: this.lastEventAt,
    }
  }

  /** 手工发送一条模拟通知；patch 只覆盖给出的字段 */
  async emit(patch: Partial<NotificationPayload> = {}): Promise<DomainEvent<NotificationPayload>> {
    const payload = this.buildPayload(patch)
    const result = await this.ingress.ingestEntry(payload)
    this.lastEventAt = result.event.occurredAt
    return result.event
  }

  private buildPayload(patch: Partial<NotificationPayload>): NotificationPayload {
    const base: NotificationPayload = {
      sourceKind: this.kind,
      appId: 'com.example.mock',
      appName: this.appName,
      title: `模拟通知 ${this.seq + 1}`,
      body: '这是一条模拟通知，用于在没有真实系统通知时开发和测试展示流程。',
      level: 'info',
    }
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) Object.assign(base, { [key]: value })
    }
    return base
  }
}
