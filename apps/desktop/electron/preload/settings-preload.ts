import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('islandSettings', {
  close: () => ipcRenderer.send('console:close'),
  get: () => ipcRenderer.invoke('settings:get'),
  setIdleMode: (mode: 'float' | 'collapsed') => ipcRenderer.invoke('settings:set-idle-mode', mode),
  setLaunchAtLogin: (enabled: boolean) => ipcRenderer.invoke('settings:set-launch-at-login', enabled),
  setIslandTop: (value: number) => ipcRenderer.invoke('settings:set-island-top', value),
  setMiniScale: (value: number) => ipcRenderer.invoke('settings:set-mini-scale', value),
  setPluginOrder: (ids: string[]) => ipcRenderer.invoke('settings:set-plugin-order', ids),
  setPluginMode: (id: string, mode: 'resident' | 'alert' | 'off') => ipcRenderer.invoke('host:plugins:mode:set', id, mode),
  runPluginToolAction: (id: string, toolId: string, actionId: string) => ipcRenderer.invoke('host:plugins:tool:run', id, toolId, actionId),
  revealPlugin: (id: string) => ipcRenderer.invoke('host:plugins:reveal', id),
  openPluginsDirectory: () => ipcRenderer.invoke('host:plugins:open-dir'),
  openHostLogs: () => ipcRenderer.invoke('host:logs:open-dir'),
  plugins: () => ipcRenderer.invoke('host:plugins:list'),
  issues: () => ipcRenderer.invoke('host:plugins:issues'),
  logs: (pluginId: string) => ipcRenderer.invoke('host:plugins:logs', pluginId),
  clearLogs: (pluginId: string) => ipcRenderer.invoke('host:plugins:logs:clear', pluginId),
  reload: (pluginId: string) => ipcRenderer.invoke('host:plugins:reload', pluginId),
  // 插件自定义设置面板（manifest.settings 为页面路径时控制台出「面板」按钮）。
  openPluginPanel: (pluginId: string) => ipcRenderer.invoke('settings:plugin-panel', pluginId),
  pluginSettings: (pluginId: string) => ipcRenderer.invoke('host:plugins:settings', pluginId),
  setPluginSettings: (pluginId: string, patch: Record<string, unknown>) => ipcRenderer.invoke('host:plugins:settings:set', pluginId, patch),
  setPluginEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke('host:plugins:enabled:set', id, enabled),
  uninstall: (id: string) => ipcRenderer.invoke('host:plugins:uninstall', id),
  // 说明页的外链（https / ms-settings），由宿主校验后交给系统打开。
  openExternal: (url: string) => ipcRenderer.invoke('settings:open-external', url),
  // 插件安装 / 导出 / Skill 包下载（原插件工坊的功能，已并入控制台「插件」页）。
  pickPluginDirectory: () => ipcRenderer.invoke('plugins:pick-directory'),
  installPlugin: (directory: string) => ipcRenderer.invoke('plugins:install', directory),
  pickPluginPackage: () => ipcRenderer.invoke('plugins:pick-package'),
  installPluginPackage: (filePath: string) => ipcRenderer.invoke('plugins:install-package', filePath),
  exportPluginPackage: (pluginId: string) => ipcRenderer.invoke('plugins:export-package', pluginId),
  downloadSkill: (kind: 'plugin' | 'workbench') => ipcRenderer.invoke('skill:download', kind),
  // 更新检查（关于页）。
  updateStatus: () => ipcRenderer.invoke('app:update-status'),
  checkForUpdates: () => ipcRenderer.invoke('app:check-updates'),
  setCheckUpdatesOnLaunch: (enabled: boolean) => ipcRenderer.invoke('settings:set-check-updates', enabled),
  // 内置通知能力（控制台「通知」页）：状态、令牌、历史入口。
  notificationStatus: () => ipcRenderer.invoke('notifications:snapshot', 1),
  copyNotificationToken: () => ipcRenderer.invoke('notifications:copy-token'),
  rotateNotificationToken: () => ipcRenderer.invoke('notifications:rotate-token'),
  openNotificationHistory: () => ipcRenderer.invoke('notifications:open-history'),
  clearNotifications: (clearWindows: boolean) => ipcRenderer.invoke('notifications:clear', { clearWindows }),
  clearNotificationsWithConfirm: () =>
    ipcRenderer.invoke('notifications:clear-confirm', 'history').then(async (choice: { action?: string } | null) => {
      if (!choice || choice.action === 'cancel') return { action: 'cancel' }
      const result = await ipcRenderer.invoke('notifications:clear', { clearWindows: choice.action === 'both' })
      return { action: choice.action, ...(result ?? {}) }
    }),
  // 说明页测试工具
  testLocalNotification: (input?: { title?: string; body?: string; level?: string; target?: string }) => ipcRenderer.invoke('notifications:test-local', input),
  testWindowsNotification: (input?: { title?: string; body?: string }) => ipcRenderer.invoke('notifications:test-windows', input),
  testIngestNotification: (input?: { title?: string; body?: string; level?: string }) => ipcRenderer.invoke('notifications:test-ingest', input),
  // 工作台管理（控制台「工作台」页）。工作台和插件是两套东西：这里只做**启用（独占）+ 能力确认**。
  workbenches: () => ipcRenderer.invoke('host:workbenches:list'),
  activateWorkbench: (id: string) => ipcRenderer.invoke('host:workbenches:activate', id),
  acknowledgeWorkbench: (id: string, capabilities: string[]) => ipcRenderer.invoke('host:workbenches:acknowledge', id, capabilities),
  installWorkbench: (directory: string) => ipcRenderer.invoke('host:workbenches:install', directory),
  uninstallWorkbench: (id: string) => ipcRenderer.invoke('host:workbenches:uninstall', id),
  reloadWorkbench: (id: string) => ipcRenderer.invoke('host:workbenches:reload', id),
  workbenchSettings: (id: string) => ipcRenderer.invoke('host:workbenches:settings', id),
  setWorkbenchSettings: (id: string, patch: Record<string, unknown>) => ipcRenderer.invoke('host:workbenches:settings:set', id, patch),
  exportWorkbenchPackage: (id: string) => ipcRenderer.invoke('host:workbenches:export-package', id),
  importWorkbenchPackage: () => ipcRenderer.invoke('host:workbenches:import-package'),
  pickWorkbenchDirectory: () => ipcRenderer.invoke('workbench:pick-directory'),
  onChanged: (listener: (settings: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => listener(value)
    ipcRenderer.on('settings:changed', handler)
    return () => ipcRenderer.removeListener('settings:changed', handler)
  },
  onTab: (listener: (tab: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, tab: string) => listener(tab)
    ipcRenderer.on('settings:tab', handler)
    return () => ipcRenderer.removeListener('settings:tab', handler)
  },
  /** 插件用 island.tools.set 推来的实时工具数据。 */
  onPluginTools: (listener: (payload: { pluginId: string; tools: unknown[] }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: { pluginId: string; tools: unknown[] }) => listener(value)
    ipcRenderer.on('settings:plugin-tools', handler)
    return () => ipcRenderer.removeListener('settings:plugin-tools', handler)
  },
})
