import fs from 'node:fs'
import path from 'node:path'
import type { PluginDescriptor, PluginManifest } from './types'

/** 发现阶段的问题：以前是静默跳过，现在要能在控制台里看到原因。 */
export interface PluginIssue { directory: string; id?: string; reason: string }

const ID_PATTERN = /^[a-z0-9_-]{1,64}$/
const VERSION_PATTERN = /^\d+\.\d+(\.\d+)?$/
const SOURCES_FILE = 'sources.json'

export class PluginManager {
  private readonly plugins = new Map<string, PluginDescriptor>()
  private readonly problems: PluginIssue[] = []
  /** 插件 id → 开发目录（安装时记录），热重载靠它把改动同步进来。 */
  private sources: Record<string, string> = {}

  constructor(private readonly roots: string[], private readonly userRoot?: string, private readonly reservedIds: ReadonlySet<string> = new Set()) {}

  issues(): PluginIssue[] { return [...this.problems] }
  sourceOf(id: string): string | undefined { return this.sources[id] }

  private sourcesFile(): string | null { return this.userRoot ? path.join(this.userRoot, SOURCES_FILE) : null }

  private loadSources(): void {
    const file = this.sourcesFile()
    if (!file) { this.sources = {}; return }
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
      this.sources = Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'string')) as Record<string, string>
    } catch { this.sources = {} }
  }

  private saveSources(): void {
    const file = this.sourcesFile()
    if (!file) return
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(this.sources, null, 2), 'utf8')
    } catch { /* 登记失败不影响插件加载 */ }
  }

  discover(): PluginDescriptor[] {
    this.plugins.clear()
    this.problems.length = 0
    this.loadSources()
    for (const root of this.roots) {
      if (!fs.existsSync(root)) continue
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        const pluginRoot = path.join(root, entry.name)
        const manifestPath = path.join(pluginRoot, 'plugin.json')
        if (!fs.existsSync(manifestPath)) {
          this.problems.push({ directory: pluginRoot, reason: '目录里没有 plugin.json' })
          continue
        }
        let manifest: PluginManifest
        try {
          manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PluginManifest
        } catch (error) {
          this.problems.push({ directory: pluginRoot, reason: `plugin.json 不是合法 JSON：${String(error)}` })
          continue
        }
        const id = typeof manifest.id === 'string' ? manifest.id : undefined
        const fail = (reason: string): void => { this.problems.push({ directory: pluginRoot, id, reason }) }
        if (!ID_PATTERN.test(id ?? '')) { fail('id 必须是 [a-z0-9_-]{1,64}（小写字母/数字/下划线/短横线）'); continue }
        if (this.reservedIds.has(id!)) { fail('此 id 已由系统功能使用'); continue }
        if (!manifest.name) { fail('缺少 name'); continue }
        if (!VERSION_PATTERN.test(String(manifest.version ?? ''))) { fail('version 必须是 x.y 或 x.y.z'); continue }
        if (typeof manifest.entry !== 'string' || !manifest.entry) { fail('缺少 entry（包内相对 .html 路径）'); continue }
        if (path.isAbsolute(manifest.entry) || manifest.entry.split(/[\\/]/).includes('..')) { fail('entry 必须是包内相对路径，且不能包含 ..'); continue }
        const rootPath = path.resolve(pluginRoot)
        const entryPath = path.resolve(pluginRoot, manifest.entry)
        if (!entryPath.startsWith(rootPath + path.sep)) { fail('entry 指到了插件目录之外'); continue }
        if (!fs.existsSync(entryPath)) { fail(`入口文件不存在：${manifest.entry}`); continue }
        if (this.plugins.has(id!)) { fail(`id 与已加载的插件重复：${id}`); continue }
        this.plugins.set(id!, { manifest, rootDir: pluginRoot, entryPath })
      }
    }
    // 清掉已卸载插件的源码登记
    const installed = new Set(this.plugins.keys())
    let changed = false
    for (const key of Object.keys(this.sources)) if (!installed.has(key) && !fs.existsSync(this.sources[key])) { delete this.sources[key]; changed = true }
    if (changed) this.saveSources()
    return this.list()
  }

  list(): PluginDescriptor[] { return [...this.plugins.values()].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name, 'zh-CN')) }
  get(id: string): PluginDescriptor | undefined { return this.plugins.get(id) }
  has(id: string): boolean { return this.plugins.has(id) }

  /** 安装一个插件目录；默认记录源码目录，之后改开发目录会自动同步（热重载）。 */
  installDirectory(sourceDir: string, options: { link?: boolean } = {}): PluginDescriptor {
    if (!this.userRoot) throw new Error('User plugin directory is not configured')
    const source = path.resolve(sourceDir)
    const manifestPath = path.join(source, 'plugin.json')
    if (!fs.existsSync(manifestPath)) throw new Error('插件目录缺少 plugin.json')
    let manifest: PluginManifest
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PluginManifest }
    catch (error) { throw new Error(`plugin.json 不是合法 JSON：${String(error)}`) }
    if (!ID_PATTERN.test(String(manifest.id ?? ''))) throw new Error('plugin.json 的 id 不合法（[a-z0-9_-]{1,64}）')
    if (this.reservedIds.has(manifest.id)) throw new Error('此 id 已由系统功能使用')
    if (!manifest.name || !VERSION_PATTERN.test(String(manifest.version ?? '')) || !manifest.entry) throw new Error('plugin.json 缺少 name / version / entry')
    const destination = path.join(this.userRoot, manifest.id)
    fs.mkdirSync(this.userRoot, { recursive: true })
    if (source !== path.resolve(destination)) fs.cpSync(source, destination, { recursive: true, force: true })
    const entryPath = path.resolve(destination, manifest.entry)
    if (!entryPath.startsWith(path.resolve(destination) + path.sep) || !fs.existsSync(entryPath)) throw new Error(`入口文件不存在：${manifest.entry}`)
    const descriptor: PluginDescriptor = { manifest, rootDir: destination, entryPath }
    this.plugins.set(manifest.id, descriptor)
    if (options.link !== false && source !== path.resolve(destination)) {
      this.sources[manifest.id] = source
      this.saveSources()
    }
    return descriptor
  }

  /** 把开发目录的最新内容同步回已安装目录（热重载用）。 */
  syncFromSource(id: string): boolean {
    const source = this.sources[id]
    if (!source || !this.userRoot) return false
    const destination = path.join(this.userRoot, id)
    if (!fs.existsSync(path.join(source, 'plugin.json'))) return false
    fs.cpSync(source, destination, { recursive: true, force: true })
    return true
  }

  uninstall(id: string): void {
    const plugin = this.plugins.get(id)
    if (plugin && this.userRoot && path.resolve(plugin.rootDir).startsWith(path.resolve(this.userRoot) + path.sep)) {
      fs.rmSync(plugin.rootDir, { recursive: true, force: true })
    }
    this.plugins.delete(id)
    if (this.sources[id]) { delete this.sources[id]; this.saveSources() }
  }
}
