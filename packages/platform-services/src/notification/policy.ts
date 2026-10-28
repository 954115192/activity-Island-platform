import type { NotificationLevel, NotificationPayload, NotificationPolicy } from '@activity-island/platform-contracts'

export const DEFAULT_POLICY: NotificationPolicy = {
  paused: false,
  allowApps: [],
  ignoreApps: [],
  quietHoursEnabled: false,
  quietStart: '23:00',
  quietEnd: '07:00',
  criticalOverridesQuiet: true,
}

/** 未指定停留时长时按级别取默认值 */
export const DEFAULT_TTL_SECONDS: Record<NotificationLevel, number> = {
  info: 8,
  warn: 10,
  critical: 15,
}

/** 解析 "HH:MM"，返回当日分钟数；格式非法返回 null */
export function parseHm(text: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

export function inQuietHours(policy: NotificationPolicy, now: Date): boolean {
  if (!policy.quietHoursEnabled) return false
  const start = parseHm(policy.quietStart)
  const end = parseHm(policy.quietEnd)
  if (start === null || end === null || start === end) return false
  const current = now.getHours() * 60 + now.getMinutes()
  return start < end ? current >= start && current < end : current >= start || current < end
}

/** 应用名或应用标识的不区分大小写包含匹配 */
export function matchesAppList(list: string[], appId: string, appName: string): boolean {
  const haystack = `${appId} ${appName}`.toLowerCase()
  return list.some((pattern) => {
    const needle = pattern.trim().toLowerCase()
    return needle.length > 0 && haystack.includes(needle)
  })
}

/**
 * 提醒分发判定：只决定是否在岛上提醒，不影响历史记录。
 * 优先级：总暂停 > 忽略名单 > 允许名单 > 免打扰时段。
 */
export function shouldAlert(policy: NotificationPolicy, payload: NotificationPayload, now: Date): boolean {
  if (policy.paused) return false
  if (matchesAppList(policy.ignoreApps, payload.appId, payload.appName)) return false
  if (policy.allowApps.length > 0 && !matchesAppList(policy.allowApps, payload.appId, payload.appName)) return false
  if (inQuietHours(policy, now) && !(policy.criticalOverridesQuiet && payload.level === 'critical')) return false
  return true
}
