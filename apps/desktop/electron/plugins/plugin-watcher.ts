import fs from 'node:fs'

export interface WatchTarget { id: string; installedDir: string; sourceDir?: string }
export interface WatchEvent { id: string; origin: 'source' | 'installed' }

/**
 * 盯住插件的安装目录，以及（登记过源码目录时）开发目录。
 *
 * - 开发目录变了 → 宿主先同步到安装目录再重载，作者只需要在 `E:\codex\island-plugin` 里写代码；
 * - 安装目录直接变了 → 直接重载；
 * - 去抖 400ms，忽略日志/临时文件，避免一次保存触发多次重载。
 */
export class PluginWatcher {
  private readonly watchers = new Map<string, fs.FSWatcher>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly onReload: (event: WatchEvent) => void, private readonly debounceMs = 400) {}

  watch(targets: WatchTarget[]): void {
    this.close()
    for (const target of targets) {
      this.add(`${target.id}:installed`, target.installedDir, () => this.onReload({ id: target.id, origin: 'installed' }))
      if (target.sourceDir && target.sourceDir !== target.installedDir) {
        const sourceDir = target.sourceDir
        this.add(`${target.id}:source`, sourceDir, () => this.onReload({ id: target.id, origin: 'source' }))
      }
    }
  }

  /** 当前被盯住的目录（调试/诊断用）。 */
  watching(): string[] { return [...this.watchers.keys()] }

  private add(key: string, dir: string, fire: () => void): void {
    if (this.watchers.has(key)) return
    try {
      if (!fs.existsSync(dir)) return
      const watcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
        const name = filename ? String(filename) : ''
        // 忽略日志/临时文件，以及插件后台脚本常见的运行时状态文件
        // （state.js / state.json 会被脚本按秒改写，不忽略就会变成每秒一次热重载）。
        if (/\.(log|tmp|swp|bak)$/i.test(name)) return
        if (/(^|[\\/])(state)\.(js|json)$/i.test(name)) return
        const existing = this.timers.get(key)
        if (existing) clearTimeout(existing)
        this.timers.set(key, setTimeout(() => { this.timers.delete(key); fire() }, this.debounceMs))
      })
      watcher.on('error', () => { /* 目录被删除/权限变化：忽略，等下一次重新 watch */ })
      this.watchers.set(key, watcher)
    } catch { /* 平台不支持递归 watch 就静默降级 */ }
  }

  close(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    for (const watcher of this.watchers.values()) { try { watcher.close() } catch { /* ignore */ } }
    this.watchers.clear()
  }
}
