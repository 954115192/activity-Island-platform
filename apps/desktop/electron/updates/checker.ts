import { app, net } from 'electron'

const UPDATE_REPO = '954115192/Activity-island'
export interface UpdateStatus {
  ok: boolean
  currentVersion: string
  latestVersion?: string
  hasUpdate?: boolean
  releaseUrl?: string
  publishedAt?: string | null
  checkedAt: number
  error?: string
}
export function createUpdateChecker(log: (level: 'info' | 'warn', message: string) => void) {
  let lastUpdateStatus: UpdateStatus | null = null
  let updateCheckPromise: Promise<UpdateStatus> | null = null

  function versionParts(value: string): number[] {
    return String(value ?? '').replace(/^v/i, '').split('-')[0].split('.').map(part => {
      const parsed = Number.parseInt(part, 10)
      return Number.isFinite(parsed) ? parsed : 0
    })
  }
  function versionNewer(candidate: string, current: string): boolean {
    const a = versionParts(candidate)
    const b = versionParts(current)
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
      const left = a[index] ?? 0
      const right = b[index] ?? 0
      if (left !== right) return left > right
    }
    return false
  }
  async function checkForUpdates(manual: boolean): Promise<UpdateStatus> {
    if (updateCheckPromise) return updateCheckPromise
    updateCheckPromise = (async () => {
      const currentVersion = app.getVersion()
      const checkedAt = Date.now()
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 12000)
      try {
        const response = await net.fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
          headers: { 'User-Agent': `Activity-Island/${currentVersion}`, Accept: 'application/vnd.github+json' },
          signal: controller.signal,
        })
        if (response.status === 404) {
          // 仓库还没发布 Release：不算失败，只是没有可比较的版本。
          const status: UpdateStatus = {
            ok: true, currentVersion, latestVersion: currentVersion, hasUpdate: false,
            releaseUrl: `https://github.com/${UPDATE_REPO}/releases`, checkedAt,
          }
          lastUpdateStatus = status
          return status
        }
        if (!response.ok) throw new Error(`GitHub 返回 HTTP ${response.status}`)
        const payload = await response.json() as { tag_name?: string; html_url?: string; published_at?: string }
        const latestVersion = String(payload.tag_name ?? '').replace(/^v/i, '')
        if (!latestVersion) throw new Error('Release 里没有版本号')
        const status: UpdateStatus = {
          ok: true, currentVersion, latestVersion,
          hasUpdate: versionNewer(latestVersion, currentVersion),
          releaseUrl: payload.html_url ?? `https://github.com/${UPDATE_REPO}/releases`,
          publishedAt: payload.published_at ?? null,
          checkedAt,
        }
        lastUpdateStatus = status
        if (manual) log('info', `检查更新：当前 v${currentVersion}，最新 v${latestVersion}`)
        return status
      } catch (error) {
        const status: UpdateStatus = {
          ok: false, currentVersion, checkedAt,
          error: String((error as Error)?.message ?? error),
        }
        lastUpdateStatus = status
        if (manual) log('warn', `检查更新失败：${status.error}`)
        return status
      } finally {
        clearTimeout(timeout)
        updateCheckPromise = null
      }
    })()
    return updateCheckPromise
  }

  return { checkForUpdates, get status(): UpdateStatus | null { return lastUpdateStatus } }

}
