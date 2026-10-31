import { ipcMain, clipboard, Notification, type BrowserWindow } from 'electron'
import { request as httpRequest } from 'node:http'
import { BUILTIN_NOTIFICATIONS_ID, type NotificationModule } from './module'
import { parseTestTarget } from './test-target'
import type { PluginViewManager } from '../plugins/plugin-view-manager'
import type { PluginDescriptor } from '../plugins/types'

type ClearAction = 'app-only' | 'both' | 'cancel'
export interface NotificationIpcContext {
  readonly settingsWindow: BrowserWindow | null
  readonly viewManager: PluginViewManager | null
  readonly notificationView: PluginDescriptor | null
  readonly notificationModule: NotificationModule | null
  readonly notificationHistoryWindow: BrowserWindow | null
  readonly clearConfirmReply: ((action: ClearAction) => void) | null
  pluginSettingsValues(id: string): Record<string, unknown>
  saveNotificationSettings(patch: Record<string, unknown>): Record<string, unknown>
  showClearConfirm(parent: BrowserWindow | null, available: boolean): Promise<ClearAction>
  createNotificationHistoryWindow(): BrowserWindow
}

function testLevel(value: unknown): 'info' | 'warn' | 'critical' {
  return value === 'warn' || value === 'critical' ? value : 'info'
}

export function registerNotificationIpc(ctx: NotificationIpcContext): void {
  // ---- 内置通知能力：只有 system-notifications 视图与历史窗口会调用 ----
  const canManageNotificationSettings = (event: Electron.IpcMainInvokeEvent): boolean => {
    if (ctx.settingsWindow && !ctx.settingsWindow.isDestroyed() && event.sender === ctx.settingsWindow.webContents) return true
    const sender = ctx.viewManager?.helloFor(event.sender) as { pluginId?: string } | null
    return sender?.pluginId === BUILTIN_NOTIFICATIONS_ID
  }
  ipcMain.handle('notifications:settings', event => canManageNotificationSettings(event)
    ? ({ ok: true, values: ctx.pluginSettingsValues(BUILTIN_NOTIFICATIONS_ID), schema: ctx.notificationView?.manifest.settings ?? null })
    : ({ ok: false, error: '没有通知设置访问权限' }))
  ipcMain.handle('notifications:settings:set', (event, patch: Record<string, unknown>) => canManageNotificationSettings(event)
    ? ({ ok: true, values: ctx.saveNotificationSettings(patch ?? {}) })
    : ({ ok: false, error: '没有通知设置访问权限' }))
  ipcMain.handle('notifications:snapshot', async (_event, limit?: number) => ctx.notificationModule?.snapshot(limit) ?? { status: null, items: [] })
  ipcMain.handle('notifications:query', async (_event, query: Record<string, unknown>) => ctx.notificationModule?.queryHistory(query ?? {}) ?? { items: [], total: 0 })
  ipcMain.handle('notifications:clear', async (_event, options?: { clearWindows?: boolean }) => {
    const result = await ctx.notificationModule?.clearHistory({ clearWindows: options?.clearWindows === true })
    return { ok: true, ...(result ?? {}) }
  })
  /** 清空前确认：自绘深色对话框（与岛/控制台一致），返回用户选择的清空范围。 */
  ipcMain.handle('notifications:clear-confirm', async (_event, source: 'island' | 'history') => {
    const windowsAvailable = ctx.notificationModule?.status().windows.access === 'allowed'
    const parent = source === 'history' && ctx.notificationHistoryWindow && !ctx.notificationHistoryWindow.isDestroyed()
      ? ctx.notificationHistoryWindow
      : null
    const action = await ctx.showClearConfirm(parent, windowsAvailable)
    return { action }
  })
  ipcMain.handle('notifications:dismiss', async (_event, eventId: string) => ({ ok: await (ctx.notificationModule?.dismiss(eventId) ?? Promise.resolve(false)) }))
  ipcMain.handle('notifications:copy-code', (event, code: unknown) => {
    const sender = ctx.viewManager?.helloFor(event.sender) as { pluginId?: string } | null
    if (sender?.pluginId !== BUILTIN_NOTIFICATIONS_ID || typeof code !== 'string' || !/^[A-Za-z0-9]{4,8}$/.test(code) || !/\d/.test(code)) return { ok: false }
    try { clipboard.writeText(code); return { ok: true } } catch { return { ok: false } }
  })
  ipcMain.handle('notifications:copy-token', async () => {
    const token = ctx.notificationModule?.tokenValue() ?? ''
    if (!token) return { ok: false }
    try { await clipboard.writeText(token) } catch { return { ok: false } }
    return { ok: true, token }
  })
  ipcMain.handle('notifications:rotate-token', async () => {
    const token = ctx.notificationModule?.rotateToken() ?? ''
    return token ? { ok: true, token } : { ok: false }
  })
  ipcMain.on('notifications:confirm-reply', (_event, action: unknown) => {
    if (action === 'app-only' || action === 'both' || action === 'cancel') ctx.clearConfirmReply?.(action)
  })
  ipcMain.handle('notifications:open-history', () => { ctx.createNotificationHistoryWindow(); return { ok: true } })
  // ---- 说明页的测试工具 ----
  // 本地接口：真的走一遍 HTTP + 令牌 + 管道，验证的是完整链路而不是内部调用。
  ipcMain.handle('notifications:test-local', async (_event, input?: { title?: string; body?: string; level?: string; target?: string }) => {
    const status = ctx.notificationModule?.status()
    if (!status) return { ok: false, error: '通知模块未就绪' }
    if (status.localTrigger.state !== 'running') return { ok: false, error: '触发接口未启用，请先在「通知」页打开' }

    const target = parseTestTarget(input?.target, status.endpoint)
    if (!target.ok) return { ok: false, error: target.error }

    const payload = JSON.stringify({
      title: input?.title || '端口测试',
      content: input?.body || '这条通知通过真实 HTTP 接口发送，验证端口、令牌与管道的完整链路。',
      level: testLevel(input?.level),
      app: { id: 'test.tool', name: '测试工具' },
    })
    return await new Promise((resolve) => {
      const req = httpRequest(
        {
          host: target.host,
          port: target.port,
          path: target.path,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(payload),
            Authorization: `Bearer ${status.token}`,
          },
        },
        (res) => {
          let data = ''
          res.setEncoding('utf8')
          res.on('data', (chunk) => { data += chunk })
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data) as { ok?: boolean; eventId?: string; error?: { message?: string } }
              if (res.statusCode === 202 && parsed.ok) resolve({ ok: true, eventId: parsed.eventId, httpStatus: res.statusCode, target: `${target.host}:${target.port}` })
              else resolve({ ok: false, error: parsed.error?.message || `HTTP ${res.statusCode}` })
            } catch {
              resolve({ ok: false, error: `HTTP ${res.statusCode}` })
            }
          })
        },
      )
      req.on('error', (error) => {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ECONNREFUSED') resolve({ ok: false, error: `连接被拒绝：${target.host}:${target.port} 上没有监听（局域网模式是否已开启？防火墙是否放行？）` })
        else if (code === 'EHOSTUNREACH' || code === 'ETIMEDOUT') resolve({ ok: false, error: `无法到达 ${target.host}:${target.port}` })
        else resolve({ ok: false, error: String((error as Error).message || error) })
      })
      req.setTimeout(5000, () => { req.destroy(); resolve({ ok: false, error: '请求超时' }) })
      req.write(payload)
      req.end()
    })
  })
  // 系统通知：发起一条真实的 Windows toast，用于验证「通知中心 → 监听 → 上岛」。
  ipcMain.handle('notifications:test-windows', (_event, input?: { title?: string; body?: string }) => {
    try {
      new Notification({
        title: input?.title || '系统通知测试',
        body: input?.body || '这是一条真实的 Windows 通知。开发环境下若未出现在通知中心，是 AUMID 未注册所致；安装版正常。',
      }).show()
      return { ok: true }
    } catch (error) {
      return { ok: false, error: String((error as Error)?.message ?? error) }
    }
  })
  // 直接注入：跳过 HTTP 与系统通知中心，只验证展示与提醒样式，最稳定。
  ipcMain.handle('notifications:test-ingest', async (_event, input?: { title?: string; body?: string; level?: string }) => {
    if (!ctx.notificationModule) return { ok: false, error: '通知模块未就绪' }
    try {
      const result = await ctx.notificationModule.testIngest({
        title: input?.title,
        body: input?.body,
        level: testLevel(input?.level),
      })
      return { ok: true, eventId: result.eventId }
    } catch (error) {
      return { ok: false, error: String((error as Error)?.message ?? error) }
    }
  })
  ipcMain.handle('notifications:reveal-token', async () => {
    const token = ctx.notificationModule?.tokenValue() ?? ''
    try { if (token) await clipboard.writeText(token) } catch { /* 忽略 */ }
    return { ok: Boolean(token), token }
  })
}
