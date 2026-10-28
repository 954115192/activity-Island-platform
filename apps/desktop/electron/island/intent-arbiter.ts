/**
 * 意图仲裁器：插件只声明意图（alert / focus），宿主决定结果并回执（host:intent）。
 *
 * 规则（与 docs/plugin-contract.md §5 一致）：
 * - alert：整条覆盖式提醒。队列长度 3，同 key 覆盖不排队；ttl 到期 → expired。
 * - focus：独占展开。同一时刻只有一个；被占用时排队 1 个，再来的直接 denied('busy')。
 * - 用户操作 / 岛被切到别处（控制台、别的插件展开）→ 当前持有者收到 preempted，排队的补位。
 *
 * 这里是纯状态机：所有"让小岛做事"的动作都通过宿主回调，方便单测。
 */

export type IntentKind = 'alert' | 'focus'
export type IntentResult = 'granted' | 'queued' | 'denied' | 'expired' | 'dismissed' | 'preempted'
export type AlertLevel = 'info' | 'warn' | 'critical'
export type FocusView = 'medium' | 'large'

export interface IntentMessage {
  kind: IntentKind
  result: IntentResult
  key?: string
  reason?: string
}

export interface AlertRequest {
  pluginId: string
  key: string
  level: AlertLevel
  ttl: number
  /** 可选自定义光圈色（#RGB/#RRGGBB/#RRGGBBAA）。空 = 按 level 取语义色。 */
  color?: string
  /**
   * 可选申请的覆盖条宽度（逻辑 px）。实际宽度 = max(清单 small.width, width)，
   * 并钳到 mini 条最大宽 —— 只能加宽，不能把推荐尺寸以下的声明宽缩掉。
   */
  width?: number
}

export interface FocusRequest {
  pluginId: string
  view: FocusView
  reason?: string
}

export interface IntentHost {
  /** 让 mini 条只显示这条提醒（覆盖式）。 */
  showAlert(alert: AlertRequest): void
  /** 提醒结束，恢复静止/环境态。 */
  endAlert(): void
  /** 现在能不能让提醒上岛（展开态/控制台占用时为 false，提醒改排队）。 */
  canAlert(): boolean
  /** 尝试展开为中岛/大岛；返回 false 表示该插件没有这个视图。 */
  grantFocus(request: FocusRequest): boolean
  /** 收回展开（回到 mini 条）。 */
  releaseFocus(): void
  sendIntent(pluginId: string, message: IntentMessage): void
}

export const ALERT_QUEUE_MAX = 3
export const FOCUS_QUEUE_MAX = 1
const DEFAULT_TTL: Record<AlertLevel, number> = { info: 4000, warn: 6000, critical: 9000 }
const TTL_MIN = 1000
const TTL_MAX = 60000

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))
const normalizeLevel = (level: unknown): AlertLevel => (level === 'warn' || level === 'critical' ? level : 'info')
/** 自定义颜色只接受十六进制，防止把任意 CSS 注入进岛壳的 box-shadow。 */
const normalizeColor = (color: unknown): string | undefined =>
  (typeof color === 'string' && /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(color.trim()) ? color.trim() : undefined)

export class IntentArbiter {
  private readonly alerts: AlertRequest[] = []
  private showing: AlertRequest | null = null
  private alertTimer: ReturnType<typeof setTimeout> | null = null
  private focus: FocusRequest | null = null
  private queuedFocus: FocusRequest | null = null

  constructor(private readonly host: IntentHost) {}

  // ---------------------------------------------------------------- alert
  requestAlert(input: { pluginId: string; key?: string; level?: unknown; ttl?: unknown; color?: unknown; width?: unknown }): void {
    const pluginId = input.pluginId
    const key = typeof input.key === 'string' && input.key.trim() ? input.key.trim() : `${pluginId}:default`
    const level = normalizeLevel(input.level)
    const requested = Number(input.ttl)
    const ttl = clamp(Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_TTL[level], TTL_MIN, TTL_MAX)
    const color = normalizeColor(input.color)
    const widthRaw = Number(input.width)
    const width = Number.isFinite(widthRaw) && widthRaw > 0 ? Math.round(widthRaw) : undefined
    const alert: AlertRequest = { pluginId, key, level, ttl, ...(color ? { color } : {}), ...(width ? { width } : {}) }

    // 同 key 覆盖：正在显示的重新计时；排队中的替换，不占新位置。
    if (this.showing && this.showing.pluginId === pluginId && this.showing.key === key) {
      this.showing = alert
      this.host.showAlert(alert)
      this.restartTimer()
      this.host.sendIntent(pluginId, { kind: 'alert', result: 'granted', key })
      return
    }
    const queuedAt = this.alerts.findIndex((item) => item.pluginId === pluginId && item.key === key)
    if (queuedAt >= 0) {
      this.alerts[queuedAt] = alert
      this.host.sendIntent(pluginId, { kind: 'alert', result: 'queued', key })
      return
    }
    if (!this.showing && this.host.canAlert()) {
      this.start(alert)
      this.host.sendIntent(pluginId, { kind: 'alert', result: 'granted', key })
      return
    }
    if (this.alerts.length >= ALERT_QUEUE_MAX) {
      this.host.sendIntent(pluginId, { kind: 'alert', result: 'denied', key, reason: 'busy' })
      return
    }
    this.alerts.push(alert)
    this.host.sendIntent(pluginId, { kind: 'alert', result: 'queued', key })
  }

  /** 插件主动收起自己这条提醒（`ui:close`）。 */
  dismissAlert(pluginId: string): boolean {
    if (!this.showing || this.showing.pluginId !== pluginId) return false
    this.finish('dismissed')
    return true
  }

  /** 岛被切到别处（控制台、别的插件展开），提醒让位但不丢队。 */
  interrupt(): void {
    if (this.showing) this.finish('preempted')
    if (this.focus) this.release('preempted')
  }

  /** 岛回到 mini/静止态：可以放行排在队里的提醒。 */
  noteIdle(): void {
    if (this.showing || this.focus) return
    const next = this.alerts.shift()
    if (!next) return
    if (!this.host.canAlert()) { this.alerts.unshift(next); return }
    this.start(next)
    this.host.sendIntent(next.pluginId, { kind: 'alert', result: 'granted', key: next.key })
  }

  /**
   * 用户操作直接把某个插件推上展开态（点自己的 mini 段）：立即生效，并让上一位独占者收到 preempted。
   * 用户操作优先级最高，不进队列。
   */
  claimFocus(request: FocusRequest): void {
    if (this.focus && this.focus.pluginId !== request.pluginId) {
      this.host.sendIntent(this.focus.pluginId, { kind: 'focus', result: 'preempted', reason: this.focus.reason })
    }
    if (this.showing) this.finish('preempted', false)
    this.focus = request
  }

  // ---------------------------------------------------------------- focus
  requestFocus(input: { pluginId: string; view?: unknown; reason?: unknown }): void {
    const pluginId = input.pluginId
    const view: FocusView = input.view === 'large' ? 'large' : 'medium'
    const reason = typeof input.reason === 'string' ? input.reason : undefined
    const request: FocusRequest = { pluginId, view, reason }

    if (this.focus && this.focus.pluginId === pluginId) {
      // 已经在独占：允许从 medium 升到 large。
      if (this.focus.view === view || (this.focus.view === 'large' && view === 'medium')) {
        this.host.sendIntent(pluginId, { kind: 'focus', result: 'granted', reason })
        return
      }
      this.focus = request
      if (this.host.grantFocus(request)) this.host.sendIntent(pluginId, { kind: 'focus', result: 'granted', reason })
      else this.host.sendIntent(pluginId, { kind: 'focus', result: 'denied', reason: 'no-view' })
      return
    }
    if (this.focus) {
      if (this.queuedFocus || FOCUS_QUEUE_MAX <= 0) {
        this.host.sendIntent(pluginId, { kind: 'focus', result: 'denied', reason: 'busy' })
        return
      }
      this.queuedFocus = request
      this.host.sendIntent(pluginId, { kind: 'focus', result: 'queued', reason })
      return
    }
    // 独占优先于提醒：正在显示的提醒让位（排队的提醒保留）。
    if (this.showing) this.finish('preempted', false)
    if (!this.host.grantFocus(request)) {
      this.host.sendIntent(pluginId, { kind: 'focus', result: 'denied', reason: 'no-view' })
      return
    }
    this.focus = request
    this.host.sendIntent(pluginId, { kind: 'focus', result: 'granted', reason })
  }

  /** 展开态结束（用户收起/点到别处/插件自己收起）。`pluginId` 省略表示由用户触发。 */
  releaseFocus(reason: 'self' | 'preempted' = 'preempted', pluginId?: string): void {
    if (!this.focus) return
    if (pluginId && this.focus.pluginId !== pluginId) return
    if (reason === 'preempted') this.release('preempted')
    else this.focus = null
    if (this.queuedFocus) this.promoteQueuedFocus()
    else this.noteIdle()
  }

  /** 岛当前是否被某插件独占。 */
  focusedPluginId(): string | null { return this.focus?.pluginId ?? null }
  /** 正在显示的提醒（宿主用于"提醒优先级高于普通 hover"等等判断）。 */
  showingAlert(): AlertRequest | null { return this.showing }

  dispose(): void {
    if (this.alertTimer) clearTimeout(this.alertTimer)
    this.alertTimer = null
    this.alerts.length = 0
    this.showing = null
    this.focus = null
    this.queuedFocus = null
  }

  // ---------------------------------------------------------------- 内部
  private start(alert: AlertRequest): void {
    this.showing = alert
    this.host.showAlert(alert)
    this.restartTimer()
  }

  private restartTimer(): void {
    if (this.alertTimer) clearTimeout(this.alertTimer)
    const current = this.showing
    if (!current) return
    this.alertTimer = setTimeout(() => {
      this.alertTimer = null
      if (this.showing?.key === current.key) this.finish('expired')
    }, current.ttl)
  }

  private finish(result: IntentResult, promote = true): void {
    const alert = this.showing
    this.showing = null
    if (this.alertTimer) { clearTimeout(this.alertTimer); this.alertTimer = null }
    this.host.endAlert()
    if (alert) this.host.sendIntent(alert.pluginId, { kind: 'alert', result, key: alert.key })
    if (!promote) return
    const next = this.alerts.shift()
    if (next) {
      this.start(next)
      this.host.sendIntent(next.pluginId, { kind: 'alert', result: 'granted', key: next.key })
    }
  }

  private release(result: IntentResult): void {
    const focus = this.focus
    this.focus = null
    this.host.releaseFocus()
    if (focus) this.host.sendIntent(focus.pluginId, { kind: 'focus', result, reason: focus.reason })
  }

  private promoteQueuedFocus(): void {
    const next = this.queuedFocus
    if (!next) return
    if (!this.host.grantFocus(next)) {
      this.queuedFocus = null
      this.host.sendIntent(next.pluginId, { kind: 'focus', result: 'denied', reason: 'no-view' })
      return
    }
    this.queuedFocus = null
    this.focus = next
    this.host.sendIntent(next.pluginId, { kind: 'focus', result: 'granted', reason: next.reason })
  }
}
