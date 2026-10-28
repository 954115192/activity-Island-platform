// 同步自 packages/platform-services/src/notification/policy.ts（双向同步）
import type { NotificationLevel, NotificationPayload, NotificationPolicy } from './contracts'

export const DEFAULT_POLICY: NotificationPolicy = {
  paused: false,
  allowApps: [],
  ignoreApps: [],
  quietHoursEnabled: false,
  quietStart: '23:00',
  quietEnd: '07:00',
  criticalOverridesQuiet: true,
}

export const DEFAULT_TTL_SECONDS: Record<NotificationLevel, number> = {
  info: 8,
  warn: 10,
  critical: 15,
}

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

export function matchesAppList(list: string[], appId: string, appName: string): boolean {
  const haystack = `${appId} ${appName}`.toLowerCase()
  return list.some((pattern) => {
    const needle = pattern.trim().toLowerCase()
    return needle.length > 0 && haystack.includes(needle)
  })
}

export function shouldAlert(policy: NotificationPolicy, payload: NotificationPayload, now: Date): boolean {
  if (policy.paused) return false
  if (matchesAppList(policy.ignoreApps, payload.appId, payload.appName)) return false
  if (policy.allowApps.length > 0 && !matchesAppList(policy.allowApps, payload.appId, payload.appName)) return false
  if (inQuietHours(policy, now) && !(policy.criticalOverridesQuiet && payload.level === 'critical')) return false
  return true
}
