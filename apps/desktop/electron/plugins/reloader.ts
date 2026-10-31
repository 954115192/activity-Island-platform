import type { PluginManager } from './plugin-manager'
import type { PluginViewManager } from './plugin-view-manager'
import type { PluginBackgroundManager } from './plugin-background-manager'
import type { PluginWatcher } from './plugin-watcher'
import type { PluginLogger } from './plugin-logger'
import type { PluginManifest } from './types'

interface ReloadOptions {
  readonly manager: PluginManager | null
  readonly views: PluginViewManager | null
  readonly background: PluginBackgroundManager | null
  readonly watcher: PluginWatcher | null
  readonly logger: PluginLogger | null
  enabled(id: string): boolean
  syncSettingsSchemas(): void
  resetPlugin(id: string): void
  refreshIsland(): Promise<void>
  changed(manifests: PluginManifest[]): void
}

/** Developer hot reload: guards storms, syncs sources and recreates runtime views. */
export class PluginReloader {
  private syncingUntil = 0
  private readonly reloadTimes = new Map<string, number[]>()
  constructor(private readonly options: ReloadOptions) {}

  watch(): void {
    const { manager, watcher } = this.options
    if (!manager || !watcher) return
    this.options.syncSettingsSchemas()
    watcher.watch(manager.list().map(plugin => ({
      id: plugin.manifest.id, installedDir: plugin.rootDir,
      sourceDir: manager.sourceOf(plugin.manifest.id),
    })))
  }

  async reload(id: string, origin: 'source' | 'installed'): Promise<void> {
    const { manager, views, background, logger } = this.options
    if (!manager || !views) return
    if (origin === 'installed' && Date.now() < this.syncingUntil) return
    if (!this.allowReload(id)) return
    if (origin === 'source') {
      this.syncingUntil = Date.now() + 2000
      if (!manager.syncFromSource(id)) {
        logger?.append(id, 'error', '热重载失败：开发目录里找不到 plugin.json')
        return
      }
    }
    background?.stop(id)
    this.options.resetPlugin(id)
    views.destroy(id)
    const list = manager.discover()
    const next = list.find(item => item.manifest.id === id)
    if (!next) logger?.append(id, 'error', '热重载失败：插件不再可加载（去控制台看未加载原因）')
    else {
      if (this.options.enabled(id)) background?.start(next)
      await views.ensure(next)
      logger?.append(id, 'info', `热重载完成（${origin === 'source' ? '开发目录' : '安装目录'}改动）`)
    }
    this.watch()
    await this.options.refreshIsland()
    this.options.changed(list.map(item => item.manifest))
  }

  private allowReload(id: string): boolean {
    const now = Date.now()
    const times = (this.reloadTimes.get(id) ?? []).filter(time => now - time < 20000)
    times.push(now)
    this.reloadTimes.set(id, times)
    if (times.length <= 8) return true
    this.reloadTimes.set(id, [now])
    this.options.logger?.append(id, 'error', `20 秒内触发 ${times.length} 次热重载，已暂停自动重载：插件可能在改写自己目录里的文件（运行时数据请写到 %TEMP%）`)
    return false
  }
}
