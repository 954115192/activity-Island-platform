import { contextBridge, ipcRenderer } from 'electron'

/** 通知历史窗口专用桥：只暴露查询/清空/撤回与令牌操作，不提供任何插件能力。 */
contextBridge.exposeInMainWorld('notificationHistory', {
  query: (query: Record<string, unknown>): Promise<{ items: Array<Record<string, unknown>>; total: number }> =>
    ipcRenderer.invoke('notifications:query', query),
  snapshot: (): Promise<{ status: Record<string, unknown> | null; items: Array<Record<string, unknown>> }> =>
    ipcRenderer.invoke('notifications:snapshot', 200),
  clear: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('notifications:clear', { clearWindows: false }),
  /** 清空前询问范围（应用内 / 连同 Windows 通知中心），确认后返回结果 */
  clearWithConfirm: (): Promise<{ action: 'cancel' | 'app-only' | 'both'; ok?: boolean; clearedWindows?: boolean; error?: string }> =>
    ipcRenderer.invoke('notifications:clear-confirm', 'history').then(async (choice) => {
      if (!choice || choice.action === 'cancel') return { action: 'cancel' as const }
      const result = await ipcRenderer.invoke('notifications:clear', { clearWindows: choice.action === 'both' })
      return { action: choice.action as 'app-only' | 'both', ...(result ?? {}) }
    }),
  dismiss: (eventId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('notifications:dismiss', eventId),
  copyToken: (): Promise<{ ok: boolean; token?: string }> => ipcRenderer.invoke('notifications:copy-token'),
  rotateToken: (): Promise<{ ok: boolean; token?: string }> => ipcRenderer.invoke('notifications:rotate-token'),
})
