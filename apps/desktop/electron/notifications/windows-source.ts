// Windows 通知监听来源：托管 resources/notifications/listener.ps1 子进程。
// 协议沿用已验证的 NDJSON 事件流：status / notify / snapshot / removed / tick。
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import type {
  NotificationAccessState,
  NotificationPayload,
  NotificationSourceState,
  NotificationSourceStatus,
} from './contracts'
import type { IngestOptions } from './service'

export interface WindowsIngress {
  ingest(payload: NotificationPayload, options?: IngestOptions): Promise<{ eventId: string; deduped: boolean }>
  dismiss(eventId: string): Promise<boolean>
}

export interface WindowsSourceOptions {
  /** listener.ps1 的绝对路径（打包后位于 asar 之外）：兜底实现 */
  script: string
  /** notify-listener.exe 的绝对路径：优先使用，轮询间隔压到 120ms */
  listenerExe?: string
  /** clear.ps1 的绝对路径：一次性清空通知中心 */
  clearScript: string
  ingress: WindowsIngress
  log: (level: 'info' | 'warn' | 'error', message: string) => void
  onStatus: (status: { access: NotificationAccessState; message: string }) => void
  /** 通知中心里被删除的通知（已映射为平台 eventId） */
  onRemoved: (eventIds: string[]) => void
}

/** 与 notify-island-bridge 相同的关键词级别猜测：Windows 通知本身没有级别概念 */
const WARN_WORDS = [
  '失败', '错误', '异常', '警告', '超时', '断开', '拒绝', '已停止', '中断', '不足',
  'failed', 'failure', 'error', 'warning', 'timeout', 'timed out', 'denied', 'crash', 'aborted',
]

const RESTART_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000]
const SILENCE_RESTART_MS = 90_000

interface ListenerItem {
  id?: string
  app?: string
  title?: string
  content?: string
  ts?: number
}

export class WindowsNotificationSource {
  readonly kind = 'windows' as const

  private readonly options: WindowsSourceOptions
  private state: NotificationSourceState = 'stopped'
  private access: NotificationAccessState = 'unspecified'
  private detail: string | undefined
  private lastEventAt: string | undefined
  private child: ChildProcess | null = null
  private buffer = ''
  private restarts = 0
  private restartTimer: ReturnType<typeof setTimeout> | undefined
  private silenceTimer: ReturnType<typeof setInterval> | undefined
  private lastLineAt = 0
  private stopping = false
  /** 监听脚本的原始 id（如 "123@456"）→ 平台 eventId */
  private readonly idMap = new Map<string, string>()

  constructor(options: WindowsSourceOptions) {
    this.options = options
  }

  async start(): Promise<void> {
    if (process.platform !== 'win32') {
      this.state = 'error'
      this.access = 'unavailable'
      this.detail = '仅支持 Windows'
      return
    }
    this.stopping = false
    this.state = 'starting'
    this.spawnListener()
    // 静默看门狗：脚本自身有 15s tick；长时间一行输出都没有视为卡死，重启进程
    this.silenceTimer = setInterval(() => {
      if (this.state !== 'running' && this.state !== 'degraded') return
      if (this.lastLineAt && Date.now() - this.lastLineAt > SILENCE_RESTART_MS) {
        this.options.log('warn', 'Windows 通知监听长时间无心跳，重启监听进程')
        this.respawn()
      }
    }, 15_000)
    this.silenceTimer.unref?.()
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    if (this.silenceTimer) clearInterval(this.silenceTimer)
    this.restartTimer = undefined
    this.silenceTimer = undefined
    this.killTree()
    this.state = 'stopped'
    this.idMap.clear()
  }

  status(): NotificationSourceStatus {
    return {
      kind: this.kind,
      state: this.state,
      access: this.access,
      detail: this.detail,
      lastEventAt: this.lastEventAt,
    }
  }

  /**
   * 清空 Windows 通知中心。WinRT 只支持整体清空，无法按单条删除。
   * 用一次性脚本而不是复用监听进程：清空是低频用户操作，避免给监听循环加命令通道。
   */
  async clearAll(): Promise<{ ok: boolean; error?: string }> {
    if (process.platform !== 'win32') return { ok: false, error: '仅支持 Windows' }
    return new Promise((resolve) => {
      let output = ''
      let settled = false
      const finish = (result: { ok: boolean; error?: string }): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.options.clearScript],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      )
      const timer = setTimeout(() => {
        try {
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        } catch {
          // 已退出
        }
        finish({ ok: false, error: '清空通知中心超时' })
      }, 12_000)
      timer.unref?.()
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => { output += String(chunk) })
      child.on('error', (error) => finish({ ok: false, error: String(error) }))
      child.on('close', () => {
        const line = output.trim().split(/\r?\n/).filter(Boolean).pop() ?? ''
        try {
          const parsed = JSON.parse(line) as { ok?: boolean; reason?: string; message?: string; removed?: number; failed?: number }
          if (parsed.ok) {
            // 通知中心已清空：丢弃本地映射，避免后续 removed 事件指向已删除的记录
            this.idMap.clear()
            finish({ ok: true })
          } else {
            const detail = typeof parsed.removed === 'number' && typeof parsed.failed === 'number'
              ? `已删除 ${parsed.removed} 条，${parsed.failed} 条删除失败`
              : undefined
            finish({ ok: false, error: describeClearFailure(parsed.reason, parsed.message) || detail || '清空通知中心失败' })
          }
        } catch {
          finish({ ok: false, error: '清空通知中心失败' })
        }
      })
    })
  }

  private spawnListener(): void {
    this.state = 'starting'
    // 优先 C# 监听器：轮询间隔 120ms（PowerShell 版 2000ms），延迟低一个数量级。
    // 缺失时回退 PowerShell，保证功能不因构建产物缺失而不可用。
    const exe = this.options.listenerExe
    const useExe = Boolean(exe && existsSync(exe))
    const child = useExe
      ? spawn(exe!, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.options.script],
          { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
        )
    if (!useExe) this.options.log('info', 'C# 监听器缺失，回退 PowerShell 轮询（延迟约 2 秒）')
    this.child = child
    this.buffer = ''
    this.lastLineAt = Date.now()
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.consume(chunk))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      const text = String(chunk).trim()
      if (text) this.options.log('warn', `[listener] ${text.slice(0, 300)}`)
    })
    child.on('error', (error) => {
      this.options.log('error', `监听进程启动失败：${String(error)}`)
      this.scheduleRestart()
    })
    child.on('close', (code) => {
      if (this.child === child) this.child = null
      if (this.stopping) return
      this.options.log('warn', `监听进程退出（code=${code ?? 'null'}），将自动重启`)
      this.scheduleRestart()
    })
  }

  private respawn(): void {
    this.killTree()
    this.spawnListener()
  }

  private scheduleRestart(): void {
    if (this.stopping || this.restartTimer) return
    const delay = RESTART_BACKOFF_MS[Math.min(this.restarts, RESTART_BACKOFF_MS.length - 1)]
    this.restarts += 1
    this.state = 'degraded'
    this.detail = `监听进程异常退出，${Math.round(delay / 1000)} 秒后重试`
    this.options.onStatus({ access: this.access, message: this.detail })
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      if (!this.stopping) this.spawnListener()
    }, delay)
    this.restartTimer.unref?.()
  }

  private consume(chunk: string): void {
    this.lastLineAt = Date.now()
    this.buffer += chunk
    const lines = this.buffer.split(/\r?\n/)
    this.buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        this.handleLine(JSON.parse(trimmed) as Record<string, unknown>)
      } catch {
        // 非 JSON 行忽略：脚本自身已把日志走 stderr
      }
    }
  }

  private handleLine(data: Record<string, unknown>): void {
    const type = String(data['type'] ?? '')
    if (type === 'status') {
      const access = normalizeAccess(data['access'])
      const changed = access !== this.access || this.state !== 'running'
      this.access = access
      this.state = access === 'allowed' ? 'running' : 'degraded'
      this.detail = String(data['message'] ?? '')
      if (access === 'allowed') this.restarts = 0
      if (changed) this.options.onStatus({ access, message: this.detail ?? '' })
    } else if (type === 'notify') {
      void this.ingestItem(data, {})
    } else if (type === 'snapshot') {
      const items = Array.isArray(data['items']) ? (data['items'] as ListenerItem[]) : []
      // 存量回填：只入历史，不提醒
      for (const item of items) void this.ingestItem(item, { suppressAlert: true })
    } else if (type === 'removed') {
      this.handleRemoved(data)
    } else if (type === 'tick') {
      this.lastEventAt = new Date().toISOString()
    }
  }

  private async ingestItem(item: ListenerItem, options: IngestOptions): Promise<void> {
    const rawId = String(item.id ?? '')
    const title = String(item.title ?? '').trim()
    if (!rawId || !title) return
    const app = String(item.app ?? '').trim() || '系统'
    const content = String(item.content ?? '')
    const text = `${title} ${content}`.toLowerCase()

    try {
      const result = await this.options.ingress.ingest(
        {
          sourceKind: 'windows',
          appId: app,
          appName: app,
          title,
          body: content,
          level: WARN_WORDS.some((word) => text.includes(word.toLowerCase())) ? 'warn' : 'info',
          dedupeKey: `win:${rawId}`,
        },
        options,
      )
      this.idMap.set(rawId, result.eventId)
      this.lastEventAt = new Date().toISOString()
    } catch (cause) {
      this.options.log('error', `接入 Windows 通知失败：${String(cause)}`)
    }
  }

  private handleRemoved(data: Record<string, unknown>): void {
    const rawIds = Array.isArray(data['ids']) ? (data['ids'] as unknown[]) : []
    const removedEventIds: string[] = []
    for (const raw of rawIds) {
      const rawId = String(raw)
      const eventId = this.idMap.get(rawId)
      if (!eventId) continue
      this.idMap.delete(rawId)
      removedEventIds.push(eventId)
      void this.options.ingress.dismiss(eventId).catch(() => {})
    }
    if (removedEventIds.length > 0) this.options.onRemoved(removedEventIds)
  }

  /** Windows 上只杀直接子进程不够：整棵进程树一起收掉（见 PluginBackgroundManager 同款教训） */
  private killTree(): void {
    const child = this.child
    this.child = null
    if (!child) return
    const pid = child.pid
    try {
      child.kill()
    } catch {
      // 已退出
    }
    for (const listener of ['close', 'error']) child.removeAllListeners(listener)
    if (pid && process.platform === 'win32') {
      try {
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } catch {
        // 已经没了就算了
      }
    }
  }
}

function normalizeAccess(value: unknown): NotificationAccessState {
  const access = String(value ?? '')
  return access === 'allowed' || access === 'denied' || access === 'unspecified' || access === 'unavailable'
    ? (access as NotificationAccessState)
    : 'unspecified'
}

function describeClearFailure(reason: string | undefined, message: string | undefined): string | undefined {
  switch (reason) {
    case 'access-denied':
      return '没有通知访问权限，无法清空 Windows 通知中心'
    case 'unavailable':
      return '当前系统不支持读取通知中心'
    case 'timeout':
      return '清空通知中心超时'
    case 'error':
      return message ? `清空通知中心失败：${message}` : '清空通知中心失败'
    default:
      // 部分失败时 reason 为空，由调用方用 removed/failed 计数描述
      return message ? `清空通知中心失败：${message}` : undefined
  }
}
