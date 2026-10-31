import { SETTINGS_KEY } from '../settings/parameters'
import type { BrowserWindow, WebContentsView } from 'electron'
import type { PluginManager } from './plugin-manager'
import type { PluginViewManager } from './plugin-view-manager'
import type { PluginBackgroundManager } from './plugin-background-manager'
import type { PluginStorage } from './plugin-storage'
import type { PluginLogger } from './plugin-logger'
import type { PluginWatcher } from './plugin-watcher'
import type { PluginDescriptor } from './types'
import { PluginReloader } from './reloader'
import { PluginToolState } from './tool-state'
import { orderPlugins, pruneOrder } from './plugin-order'
import { exportArtifactPackage } from './package-export'
import { BUILTIN_NOTIFICATIONS_ID } from '../notifications/module'
import type { createIslandController } from '../island/controller'
import type { SettingsStore } from '../settings/store'
import type { EventBus } from '../events/event-bus'

interface PluginCoordinatorOptions {
  settings: SettingsStore
  events: EventBus
  readonly island: ReturnType<typeof createIslandController>
  readonly notification: PluginDescriptor | null
  services: {
    readonly manager: PluginManager | null
    readonly views: PluginViewManager | null
    readonly background: PluginBackgroundManager | null
    readonly storage: PluginStorage | null
    readonly logger: PluginLogger | null
    readonly watcher: PluginWatcher | null
  }
  windows: {
    readonly settings: BrowserWindow | null
    readonly panel: { pluginId: string; view: WebContentsView } | null
    closePanel(): void
  }
  runtimeView(id: string): PluginDescriptor | undefined
  sendHost(channel: string, payload?: unknown): void
  settingsChanged(): void
}

/** Coordinates plugin preferences, runtime updates, background processes and events. */
export function createPluginCoordinator(options: PluginCoordinatorOptions) {

  /** 自己声明"我现在没内容、别占着 mini 条"的插件（island.ui.setPresence(false)）。 */
  const hiddenPlugins = new Set<string>()

  const pluginTools = new PluginToolState(
    id => options.services.manager?.get(id),
    (pluginId, tools) => {
      const target = options.windows.settings
      if (target && !target.isDestroyed()) target.webContents.send('settings:plugin-tools', { pluginId, tools })
    },
  )

  function plugins(): PluginDescriptor[] { return options.services.manager?.list() ?? [] }

  function pluginIssues() { return options.services.manager?.issues() ?? [] }

  function pluginEnabled(id: string): boolean { return !options.settings.value.disabledPlugins.includes(id) }

  /**
   * 用户选的"上岛方式"：resident = 常驻 mini 条；alert = 仅提醒。
   * 没存过就按清单 resident 默认；small 被作者关掉的插件不能常驻。
   */
  function pluginModeOf(plugin: PluginDescriptor): 'resident' | 'alert' {
    if (plugin.manifest.small?.enabled === false) return 'alert'
    const stored = options.settings.value.pluginModes[plugin.manifest.id]
    if (stored === 'resident' || stored === 'alert') return stored
    return plugin.manifest.resident === true ? 'resident' : 'alert'
  }

  function pluginSupportsResident(plugin: PluginDescriptor): boolean { return plugin.manifest.small?.enabled !== false }

  function pluginResident(plugin: PluginDescriptor): boolean { return pluginModeOf(plugin) === 'resident' }

  function pluginPublicMode(id: string): 'off' | 'resident' | 'alert' {
    if (!pluginEnabled(id)) return 'off'
    const plugin = options.services.manager?.get(id)
    return plugin ? pluginModeOf(plugin) : 'alert'
  }

  /** 控制台插件页需要的完整状态：清单 + 用户选择 + 实时工具数据。 */
  function pluginListPayload() {
    return plugins().map(item => ({
      ...item.manifest,
      enabled: pluginEnabled(item.manifest.id),
      mode: pluginPublicMode(item.manifest.id),
      resident: pluginResident(item),
      supportsResident: pluginSupportsResident(item),
      sourceDir: options.services.manager?.sourceOf(item.manifest.id) ?? null,
      tools: pluginTools.list(item.manifest.id),
    }))
  }

  function enabledPlugins(): PluginDescriptor[] { return plugins().filter(plugin => pluginEnabled(plugin.manifest.id)) }

  const pluginReloader = new PluginReloader({
    get manager() { return options.services.manager },
    get views() { return options.services.views },
    get background() { return options.services.background },
    get watcher() { return options.services.watcher },
    get logger() { return options.services.logger },
    enabled: pluginEnabled,
    syncSettingsSchemas,
    resetPlugin: id => {
      hiddenPlugins.delete(id)
      pluginTools.clear(id)
      if (options.windows.panel?.pluginId === id) options.windows.closePanel()
      options.island.invalidateLayout()
    },
    refreshIsland: () => options.island.showRest(options.island.hitInside),
    changed: manifests => options.sendHost('host:plugins-changed', manifests),
  })

  // ---------------------------------------------------------------- 插件参数（设置项）

  function pluginSettingsFields(pluginId: string): Array<Record<string, unknown>> {
    const settings = options.runtimeView(pluginId)?.manifest.settings
    const fields = typeof settings === 'object' && settings !== null ? settings.fields : null
    return Array.isArray(fields) ? (fields as unknown as Array<Record<string, unknown>>) : []
  }

  function pluginSettingsValues(pluginId: string): Record<string, unknown> {
    const stored = (options.services.storage?.get(pluginId, SETTINGS_KEY) as Record<string, unknown> | undefined) ?? {}
    const values: Record<string, unknown> = {}
    for (const field of pluginSettingsFields(pluginId)) {
      const key = String(field.key ?? '')
      if (key && field.default !== undefined) values[key] = field.default
    }
    return { ...values, ...stored }
  }

  function storeSettings(pluginId: string, patch: Record<string, unknown>): Record<string, unknown> {
    const allowed = new Set(pluginSettingsFields(pluginId).map(field => String(field.key ?? '')))
    const clean: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(patch)) if (allowed.has(key)) clean[key] = value
    const next = { ...pluginSettingsValues(pluginId), ...clean }
    options.services.storage?.set(pluginId, SETTINGS_KEY, next)
    return next
  }

  function savePluginSettings(pluginId: string, patch: Record<string, unknown>): Record<string, unknown> {
    const next = storeSettings(pluginId, patch)
    // 后台脚本在启动时读一次参数（端口监听甚至要在启动时绑定端口），保存后重启它让新值生效。
    const descriptor = options.services.manager?.get(pluginId)
    if (descriptor?.manifest.background?.entry && pluginEnabled(pluginId)) {
      options.services.background?.stop(pluginId)
      options.services.background?.start(descriptor)
    }
    // 插件侧立即收到；控制台窗口也刷新。
    options.services.views?.sendToPlugin(pluginId, 'host:settings', { values: next, schema: options.runtimeView(pluginId)?.manifest.settings ?? null })
    if (options.windows.panel && options.windows.panel.pluginId === pluginId && !options.windows.panel.view.webContents.isDestroyed()) {
      options.windows.panel.view.webContents.send('host:settings', { values: next })
    }
    return next
  }

  /** 插件设置项 schema 同步给视图管理器，hello 里会带给插件。 */
  function syncSettingsSchemas(): void {
    const schemas: Record<string, unknown> = {}
    for (const plugin of plugins()) if (plugin.manifest.settings) schemas[plugin.manifest.id] = plugin.manifest.settings
    if (options.notification?.manifest.settings) schemas[BUILTIN_NOTIFICATIONS_ID] = options.notification.manifest.settings
    options.services.views?.setSettingsSchemas(schemas)
  }

  /** mini 条里的插件顺序：用户拖拽顺序 > priority > 名字。 */
  function orderedPlugins(): PluginDescriptor[] {
    // hiddenPlugins：插件自己说"我现在没内容"（island.ui.setPresence(false)），就不占 mini 条。
    // 仅提醒的插件也不占 —— 它们只通过 alert/focus 出现。
    const visible = enabledPlugins().filter(plugin => pluginResident(plugin) && !hiddenPlugins.has(plugin.manifest.id))
    return orderPlugins(visible, options.settings.value.pluginOrder)
  }

  async function setPluginMode(pluginId: string, mode: 'resident' | 'alert' | 'off'): Promise<{ ok: boolean; enabled?: boolean; mode?: 'resident' | 'alert' | 'off'; error?: string }> {
    const plugin = options.services.manager?.get(pluginId)
    if (!plugin) return { ok: false, error: '插件未加载' }
    if (mode === 'resident' && !pluginSupportsResident(plugin)) return { ok: false, error: '这个插件没有提供小岛视图，只能仅提醒' }

    if (mode === 'off') {
      if (!options.settings.value.disabledPlugins.includes(pluginId)) options.settings.value.disabledPlugins.push(pluginId)
      options.services.background?.stop(pluginId)
      hiddenPlugins.delete(pluginId)
      options.services.views?.destroy(pluginId)
      if (options.island.islandState.value.activePluginId === pluginId) options.island.arbiter.interrupt()
    } else {
      options.settings.value.disabledPlugins = options.settings.value.disabledPlugins.filter(id => id !== pluginId)
      options.settings.value.pluginModes[pluginId] = mode
      options.services.background?.start(plugin)
      // 常驻 → 仅提醒：如果它正展开着，先把展开态收掉，回到 mini 条/静止。
      if (mode === 'alert' && options.island.islandState.value.activePluginId === pluginId
        && (options.island.islandState.value.mode === 'expanded' || options.island.islandState.value.mode === 'detail')) {
        options.island.clearAlertCarry()
        options.island.arbiter.interrupt()
      }
    }

    options.settings.save()
    pluginReloader.watch()
    await options.island.showRest(options.island.hitInside)
    options.settingsChanged()
    options.sendHost('host:plugins-changed', plugins().map(item => ({ ...item.manifest, enabled: pluginEnabled(item.manifest.id), mode: pluginPublicMode(item.manifest.id) })))
    return { ok: true, enabled: pluginEnabled(pluginId), mode: pluginPublicMode(pluginId) }
  }

  /** 兼容旧调用：true 按插件默认/上次选择恢复，false = 关闭。 */
  async function setPluginEnabled(pluginId: string, enabled: boolean): Promise<{ ok: boolean; enabled?: boolean; error?: string }> {
    const plugin = options.services.manager?.get(pluginId)
    if (!plugin) return { ok: false, error: '插件未加载' }
    if (!enabled) {
      const result = await setPluginMode(pluginId, 'off')
      return { ok: result.ok, enabled: false, error: result.error }
    }
    const stored = options.settings.value.pluginModes[pluginId]
    let mode = stored === 'resident' || stored === 'alert'
      ? stored
      : (plugin.manifest.resident === true ? 'resident' : 'alert')
    if (mode === 'resident' && !pluginSupportsResident(plugin)) mode = 'alert'
    const result = await setPluginMode(pluginId, mode)
    return { ok: result.ok, enabled: result.ok, error: result.error }
  }

  /**
   * 插件事件的中转站。
   * `toSelf` = 这个事件本来就是发给该插件自己的（它 resources/ 里后台脚本的 stdout、runtime:log/exit），
   * 必须也送到它自己的页面 —— 否则插件收不到自己后台脚本的输出。
   */
  function emitPluginEvent(pluginId: string, name: string, payload: unknown, delivery: { toSelf?: boolean } = {}): void {
    if (name === 'runtime:log') {
      const entry = payload as { level?: string; message?: unknown } | undefined
      const level = entry?.level === 'error' ? 'error' : entry?.level === 'warn' ? 'warn' : 'info'
      options.services.logger?.append(pluginId, level, entry?.message ?? '')
    } else if (name.startsWith('runtime:')) {
      const level = name === 'runtime:error' ? 'error' : name === 'runtime:exit' ? 'warn' : 'info'
      options.services.logger?.append(pluginId, level, `${name} ${typeof payload === 'string' ? payload : JSON.stringify(payload)}`)
    }
    options.events.emit(`${pluginId}:${name}`, payload)
    options.services.views?.broadcastEvent(name, payload, pluginId, delivery)
    // 设置面板不是岛上的插件视图，broadcastEvent 管不到；属于这个插件的事件（后台脚本
    // stdout、runtime:*）必须镜像给它，面板页才能和岛上视图收到同一份事件。
    if (options.windows.panel && options.windows.panel.pluginId === pluginId && !options.windows.panel.view.webContents.isDestroyed()) {
      options.windows.panel.view.webContents.send('host:event', { name, payload })
    }
    // 旧语义 ui:show / activity 收敛到 alert：带默认 ttl 的提醒，排队规则一致。
    if (name === 'ui:show' || name === 'activity') options.island.arbiter.requestAlert({ pluginId, key: name, level: 'info', ttl: 4000 })
  }

  async function exportPluginPackage(pluginId: string, targetPath: string): Promise<{ ok: boolean; path?: string; bytes?: number; entries?: number; error?: string }> {
    const plugin = options.services.manager?.get(pluginId)
    if (!plugin) return { ok: false, error: '插件未加载' }
    return exportArtifactPackage({
      rootDir: plugin.rootDir, manifestFile: 'plugin.json', entry: String(plugin.manifest.entry ?? ''),
      label: '插件包', logId: pluginId, version: plugin.manifest.version,
    }, targetPath, (id, message) => options.services.logger?.append(id, 'info', message))
  }
  function reconcileInstalledPlugins(discovered: PluginDescriptor[]): void {
    // 用户排序里丢掉已卸载的插件，避免顺序表无限增长。
    const hadLegacyNotificationPlugin = options.settings.value.disabledPlugins.includes(BUILTIN_NOTIFICATIONS_ID)
      || BUILTIN_NOTIFICATIONS_ID in options.settings.value.pluginModes || options.settings.value.pluginOrder.includes(BUILTIN_NOTIFICATIONS_ID)
    options.settings.value.pluginOrder = pruneOrder(options.settings.value.pluginOrder, discovered.map(item => item.manifest.id))
    options.settings.value.disabledPlugins = options.settings.value.disabledPlugins.filter(id => discovered.some(item => item.manifest.id === id))
    options.settings.value.pluginModes = Object.fromEntries(
      Object.entries(options.settings.value.pluginModes).filter(([id]) => discovered.some(item => item.manifest.id === id)),
    )
    if (hadLegacyNotificationPlugin) options.settings.save()
    // 旧版本没有"上岛方式"：升级时先把已有插件默认成常驻，保持原来的 mini 条行为。
    // 之后新装的插件才按清单 resident 默认（false = 仅提醒）。
    if (!options.settings.value.pluginModesMigrated) {
      for (const item of discovered) {
        if (!pluginSupportsResident(item)) continue
        if (!options.settings.value.pluginModes[item.manifest.id]) options.settings.value.pluginModes[item.manifest.id] = 'resident'
      }
      options.settings.value.pluginModesMigrated = true
      options.settings.save()
    }
  }

  return {
    reconcile: reconcileInstalledPlugins,
    list: plugins,
    issues: pluginIssues,
    enabled: pluginEnabled,
    modeOf: pluginModeOf,
    supportsResident: pluginSupportsResident,
    resident: pluginResident,
    mode: pluginPublicMode,
    snapshot: pluginListPayload,
    settingsValues: pluginSettingsValues,
    storeSettings: storeSettings,
    saveSettings: savePluginSettings,
    syncSchemas: syncSettingsSchemas,
    ordered: orderedPlugins,
    setMode: setPluginMode,
    setEnabled: setPluginEnabled,
    emit: emitPluginEvent,
    exportPackage: exportPluginPackage,
    hidden: hiddenPlugins,
    tools: pluginTools,
    reloader: pluginReloader,
  }
}
