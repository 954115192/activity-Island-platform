import fs from 'node:fs'
import path from 'node:path'
import { BUILTIN_WORKBENCH_ID, type WorkbenchManager, type WorkbenchDescriptor } from './workbench-manager'
import { allCapabilities, normalizeCapabilities, CAPABILITY_LABELS } from './capabilities'
import type { createWorkbenchAccess } from './access'
import type { createWorkbenchView } from './view'
import type { createIslandController } from '../island/controller'
import type { SettingsStore } from '../settings/store'
import { SETTINGS_KEY } from '../settings/parameters'
import type { PluginStorage } from '../plugins/plugin-storage'
import type { PluginLogger } from '../plugins/plugin-logger'
import { exportArtifactPackage } from '../plugins/package-export'

interface WorkbenchOptions {
  dataDirectory: string
  settings: SettingsStore
  access: ReturnType<typeof createWorkbenchAccess>
  readonly runtime: ReturnType<typeof createWorkbenchView>
  readonly island: ReturnType<typeof createIslandController>
  readonly manager: WorkbenchManager | null
  readonly storage: PluginStorage | null
  readonly logger: PluginLogger | null
  appRoot(): string
  sendHost(channel: string, payload?: unknown): void
}

/** Workbench selection, consent, settings, previews and shared shortcut persistence. */
export function createWorkbenchCoordinator(options: WorkbenchOptions) {

  // 工作台数据目录。`shortcuts.json` 是宿主拥有的（跨工作台共享）；
  // 页面自己的偏好（刷新频率、主题色…）走 `workbench.storage`，宿主不掺和 ——
  // 那些是某个页面的展示选择，不该让宿主为它开专用接口。
  function workbenchDataRoot(): string { return options.dataDirectory }

  function shortcutsFile(): string { return path.join(workbenchDataRoot(), 'shortcuts.json') }

  /**
   * 当前该用哪个工作台。
   * 设置里的那个不存在或已损坏时**回落内置**并记一条日志 ——
   * 否则右键小岛会试图打开一个不存在的入口，用户看到的是"点了没反应"。
   */
  function resolveActiveWorkbench(): WorkbenchDescriptor {
    const wanted = options.settings.value.activeWorkbench
    const found = options.manager?.get(wanted)
    if (found) return found
    if (wanted !== BUILTIN_WORKBENCH_ID) {
      options.logger?.append('_host', 'warn', `活动工作台「${wanted}」不存在，已回落到内置工作台`)
      options.settings.value.activeWorkbench = BUILTIN_WORKBENCH_ID
      options.settings.save()
    }
    const builtin = options.manager?.get(BUILTIN_WORKBENCH_ID)
    if (builtin) return builtin
    // 连内置都没有：返回一个最小描述符，避免调用方到处判空。
    return {
      manifest: { id: BUILTIN_WORKBENCH_ID, name: '内置工作台', version: '1.0.0', entry: 'index.html' },
      rootDir: path.join(options.appRoot(), 'console-apps', 'workbench'),
      entryPath: path.join(options.appRoot(), 'console-apps', 'workbench', 'index.html'),
      builtin: true,
      capabilities: [...allCapabilities()],
    }
  }

  /**
   * 启用一个工作台（**独占**：设置里只存一个 id）。
   * 声明里有没有被用户确认过的能力，是能不能启用的前提 —— 工作台是**可分发**的，
   * 「装一个工作台 = 装一个任意程序」，所以"声明与实际能做一致"必须在这里强制。
   */
  function activateWorkbench(id: string): { ok: boolean; error?: string; missing?: string[]; id?: string } {
    const descriptor = options.manager?.get(id)
    if (!descriptor) return { ok: false, error: '工作台不存在' }
    const granted = new Set(options.settings.value.workbenchGrants[id] ?? [])
    const missing = descriptor.capabilities.filter(capability => !granted.has(capability))
    if (missing.length) return { ok: false, error: 'capabilities-not-acknowledged', missing }
    options.settings.value.activeWorkbench = id
    options.settings.save()
    options.access.apply(descriptor)
    // 正在看控制台就立刻换过去；否则下次右键生效。
    if (options.island.consoleVisible()) void options.island.enterCustomMode()
    options.sendHost('host:workbenches-changed', workbenchListPayload())
    return { ok: true, id }
  }

  /** 记录用户确认了哪些能力（管理页在启用前展示并让用户确认）。 */
  function acknowledgeWorkbench(id: string, capabilities: string[]): { ok: boolean; grants?: string[] } {
    const descriptor = options.manager?.get(id)
    if (!descriptor) return { ok: false }
    const normalized = normalizeCapabilities(capabilities)
    // 只接受该工作台**真的声明了**的能力，避免前端塞进无关项。
    const allowed = normalized.filter(capability => descriptor.capabilities.includes(capability))
    const merged = [...new Set([...(options.settings.value.workbenchGrants[id] ?? []), ...allowed])]
    options.settings.value.workbenchGrants = { ...options.settings.value.workbenchGrants, [id]: merged }
    options.settings.save()
    return { ok: true, grants: merged }
  }

  function workbenchListPayload(): Array<Record<string, unknown>> {
    const active = options.settings.value.activeWorkbench
    return (options.manager?.list() ?? []).map(descriptor => {
      const granted = new Set(options.settings.value.workbenchGrants[descriptor.manifest.id] ?? [])
      const fields = workbenchSettingsFields(descriptor.manifest.id)
      return {
        id: descriptor.manifest.id,
        name: descriptor.manifest.name,
        version: descriptor.manifest.version,
        description: descriptor.manifest.description ?? '',
        // 卡片上的缩略图：作者提供的示例图，没提供就由页面画占位
        preview: workbenchPreviewDataUrl(descriptor.manifest.id),
        builtin: descriptor.builtin,
        active: descriptor.manifest.id === active,
        sourceDir: options.manager?.sourceOf(descriptor.manifest.id) ?? null,
        hasSettings: fields.length > 0,
        paramCount: fields.length,
        capabilities: descriptor.capabilities.map(capability => ({ capability, label: CAPABILITY_LABELS[capability] })),
        // 还没确认过的能力：管理页要用它来提示"启用前请确认"。
        unacknowledged: descriptor.capabilities.filter(capability => !granted.has(capability)),
      }
    })
  }

  /** 工作台日志落到自己的文件：<userData>/island-plugins/logs/__workbench__<id>.log */
  function workbenchLogId(): string { return `__workbench__${options.access.id}` }

  /** http 返回体上限：防止一个工作台把主进程内存吃满。 */
  /** 工作台自己的存储：复用插件存储（按 workbench id 分命名空间）。 */
  function workbenchStorageKey(id: string): string { return `__workbench__${id}` }

  function workbenchStorageId(): string { return workbenchStorageKey(options.access.id) }

  /**
   * 工作台参数（workbench.json 的 `settings.fields`）。
   * 和插件用的是同一套机制与同一个保留键（`__settings`），所以页面既能用 `settings.*` 读，
   * 也能用 `storage.get('__settings')` 直接看到 —— 不存在"两套参数"。
   */
  function workbenchSettingsFields(id: string): Array<Record<string, unknown>> {
    const fields = options.manager?.get(id)?.manifest.settings?.fields
    return Array.isArray(fields) ? (fields as unknown as Array<Record<string, unknown>>) : []
  }

  function workbenchSettingsValues(id: string): Record<string, unknown> {
    const stored = (options.storage?.get(workbenchStorageKey(id), SETTINGS_KEY) as Record<string, unknown> | undefined) ?? {}
    const values: Record<string, unknown> = {}
    for (const field of workbenchSettingsFields(id)) {
      const key = String(field.key ?? '')
      if (key && field.default !== undefined) values[key] = field.default
    }
    return { ...values, ...stored }
  }

  function saveWorkbenchSettings(id: string, patch: Record<string, unknown>): Record<string, unknown> {
    const allowed = new Set(workbenchSettingsFields(id).map(field => String(field.key ?? '')))
    const clean: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(patch)) if (allowed.has(key)) clean[key] = value
    const next = { ...workbenchSettingsValues(id), ...clean }
    options.storage?.set(workbenchStorageKey(id), SETTINGS_KEY, next)
    // 正在显示的就是它 → 页面立刻收到；控制台窗口也刷新。
    if (id === options.access.id && options.runtime.view && !options.runtime.view.webContents.isDestroyed()) {
      options.runtime.view.webContents.send('host:settings', { values: next, schema: options.manager?.get(id)?.manifest.settings ?? null })
    }
    return next
  }

  /**
   * 示例图：读成 data URL 交给管理页当缩略图。
   * 用 data URL 而不是让页面直接 `<img src="file://…">`：设置页自己也是 file:// 页面，
   * 直接引本地图片会被 Chromium 的 file 源策略挡住，读成 data URL 最稳。
   */
  function workbenchPreviewDataUrl(id: string): string | null {
    const descriptor = options.manager?.get(id)
    const relative = descriptor?.manifest.preview
    if (!descriptor || !relative) return null
    const root = path.resolve(descriptor.rootDir)
    const file = path.resolve(root, String(relative))
    if (!file.startsWith(root + path.sep)) return null
    const mime = /\.svg$/i.test(String(relative)) ? 'image/svg+xml'
      : /\.png$/i.test(String(relative)) ? 'image/png'
        : /\.jpe?g$/i.test(String(relative)) ? 'image/jpeg'
          : /\.webp$/i.test(String(relative)) ? 'image/webp' : null
    if (!mime) return null
    try {
      if (!fs.existsSync(file) || fs.statSync(file).size > 512 * 1024) return null
      return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`
    } catch { return null }
  }

  function readShortcuts(): Array<{ id: string; name: string; path: string }> {
    try { return JSON.parse(fs.readFileSync(shortcutsFile(), 'utf8')) as Array<{ id: string; name: string; path: string }> } catch { return [] }
  }

  function writeShortcuts(shortcuts: Array<{ id: string; name: string; path: string }>): void {
    fs.mkdirSync(workbenchDataRoot(), { recursive: true })
    fs.writeFileSync(shortcutsFile(), JSON.stringify(shortcuts, null, 2), 'utf8')
  }

  async function exportWorkbenchPackage(workbenchId: string, targetPath: string): Promise<{ ok: boolean; path?: string; bytes?: number; entries?: number; error?: string }> {
    const descriptor = options.manager?.get(workbenchId)
    if (!descriptor) return { ok: false, error: '工作台不存在' }
    if (descriptor.builtin) return { ok: false, error: '内置工作台随宿主分发，不需要单独导出' }
    return exportArtifactPackage({
      rootDir: descriptor.rootDir, manifestFile: 'workbench.json', entry: String(descriptor.manifest.entry ?? ''),
      label: '工作台包', logId: workbenchStorageKey(workbenchId), version: descriptor.manifest.version,
    }, targetPath, (id, message) => options.logger?.append(id, 'info', message))
  }
  function reconcileInstalledWorkbenches(): void {
    // 只保留还存在的已装工作台；内置始终放行全部能力（它随宿主分发）。
    options.settings.value.workbenchGrants = Object.fromEntries(
      Object.entries(options.settings.value.workbenchGrants).filter(([id]) => id === BUILTIN_WORKBENCH_ID || (options.manager?.has(id) ?? false)),
    )
    if (!options.manager?.has(options.settings.value.activeWorkbench)) {
      if (options.settings.value.activeWorkbench !== BUILTIN_WORKBENCH_ID) {
        options.logger?.append('_host', 'warn', `启动时找不到活动工作台「${options.settings.value.activeWorkbench}」，回落到内置工作台`)
      }
      options.settings.value.activeWorkbench = BUILTIN_WORKBENCH_ID
      options.settings.save()
    }
  }

  return {
    reconcile: reconcileInstalledWorkbenches,
    resolve: resolveActiveWorkbench,
    activate: activateWorkbench,
    acknowledge: acknowledgeWorkbench,
    list: workbenchListPayload,
    logId: workbenchLogId,
    storageId: workbenchStorageId,
    settingsValues: workbenchSettingsValues,
    saveSettings: saveWorkbenchSettings,
    readShortcuts: readShortcuts,
    writeShortcuts: writeShortcuts,
    exportPackage: exportWorkbenchPackage,
  }
}
