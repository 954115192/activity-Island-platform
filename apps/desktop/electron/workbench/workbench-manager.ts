/**
 * 工作台管理器：发现 / 安装 / 卸载 `<userData>/workbenches/<id>/` 下的工作台。
 *
 * 为什么**不复用 `PluginManager`、也不给插件加 `kind` 字段**：
 * 把工作台塞进插件体系，就得在每一处过滤（`orderedPlugins` / `fitMiniBar` / presence /
 * alert / focus 仲裁 / 用户排序 / 溢出徽标 / 预热…），**漏一处工作台就会出现在 mini 条上**。
 * 独立目录让"工作台不是插件"成为**结构性事实**：插件的任何代码路径天然看不到它们，
 * 不需要任何过滤。共享的是**机制**（沙箱、日志、热重载、打包），不是"插件"这个类别。
 *
 * 内置工作台（id 固定 `builtin`）始终存在且不可卸载：右键小岛是宿主的入口，
 * 一个工作台都没装（或装的坏了）时也必须能打开东西。
 */
import fs from 'node:fs'
import path from 'node:path'
import { normalizeCapabilities, type WorkbenchCapability } from './capabilities'

export interface WorkbenchManifest {
  id: string
  name: string
  version: string
  entry: string
  description?: string
  /** 示例图（包内相对路径，svg/png/jpg/webp）。管理页的卡片用它当缩略图。 */
  preview?: string
  size?: { width?: number; height?: number }
  capabilities?: string[]
  /** 宿主渲染的参数表单声明（和插件的 plugin.json settings.fields 同构）。 */
  settings?: { fields?: Array<Record<string, unknown>> }
}

export interface WorkbenchDescriptor {
  manifest: WorkbenchManifest
  rootDir: string
  entryPath: string
  /** 内置工作台：随宿主分发，不可卸载、视为声明全部能力。 */
  builtin: boolean
  capabilities: WorkbenchCapability[]
  /** 开发目录（安装时记录），热重载用；内置与包安装为空。 */
  sourceDir?: string
}

export interface WorkbenchIssue { directory: string; id?: string; reason: string }

const ID_PATTERN = /^[a-z0-9_-]{1,64}$/
const VERSION_PATTERN = /^\d+\.\d+(\.\d+)?$/
const SOURCES_FILE = 'sources.json'
const MANIFEST_FILE = 'workbench.json'

/** 内置工作台的固定 id。 */
export const BUILTIN_WORKBENCH_ID = 'builtin'

export class WorkbenchManager {
  private readonly workbenches = new Map<string, WorkbenchDescriptor>()
  private readonly problems: WorkbenchIssue[] = []
  private sources: Record<string, string> = {}

  constructor(private readonly root: string, private readonly builtinDir: string) {}

  issues(): WorkbenchIssue[] { return [...this.problems] }
  sourceOf(id: string): string | undefined { return this.sources[id] }

  private sourcesFile(): string { return path.join(this.root, SOURCES_FILE) }

  private loadSources(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.sourcesFile(), 'utf8')) as Record<string, unknown>
      this.sources = Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'string')) as Record<string, string>
    } catch { this.sources = {} }
  }

  private saveSources(): void {
    try {
      fs.mkdirSync(this.root, { recursive: true })
      fs.writeFileSync(this.sourcesFile(), JSON.stringify(this.sources, null, 2), 'utf8')
    } catch { /* 登记失败不影响加载 */ }
  }

  /** 内置工作台永远在列表里（它是兜底入口）。 */
  private builtinDescriptor(): WorkbenchDescriptor | null {
    const entryPath = path.join(this.builtinDir, 'index.html')
    if (!fs.existsSync(entryPath)) return null
    return {
      manifest: {
        id: BUILTIN_WORKBENCH_ID,
        name: '内置工作台',
        version: '1.0.0',
        entry: 'index.html',
        capabilities: [],
        // 它自己的偏好也走**宿主渲染的参数表单**（和插件、和其它工作台一致）：
        // 页面里不再画第二套设置界面 —— 否则用户不知道该去哪儿改（实测就是找不到）。
        settings: {
          fields: [
            { key: 'refreshMs', label: '刷新频率', type: 'select', default: 2000, options: [{ value: 1000, label: '1 秒' }, { value: 2000, label: '2 秒' }, { value: 5000, label: '5 秒' }] },
            { key: 'accent', label: '主题色', type: 'color', default: '#3B82F6' },
            { key: 'showNetwork', label: '显示网络速率面板', type: 'boolean', default: true, description: '关掉后「网络速率」那张卡片会隐藏' },
          ],
        },
      },
      rootDir: this.builtinDir,
      entryPath,
      builtin: true,
      // 内置工作台视为声明全部能力（见 capabilities.ts 的 allCapabilities）。
      capabilities: normalizeCapabilities(['system', 'open', 'http', 'run', 'storage', 'shortcuts', 'resize']),
    }
  }

  discover(): WorkbenchDescriptor[] {
    this.workbenches.clear()
    this.problems.length = 0
    this.loadSources()
    const builtin = this.builtinDescriptor()
    if (builtin) this.workbenches.set(builtin.manifest.id, builtin)
    else this.problems.push({ directory: this.builtinDir, reason: '内置工作台入口缺失（index.html 不存在）' })

    if (fs.existsSync(this.root)) {
      for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        const rootDir = path.join(this.root, entry.name)
        const manifestPath = path.join(rootDir, MANIFEST_FILE)
        if (!fs.existsSync(manifestPath)) {
          this.problems.push({ directory: rootDir, reason: `目录里没有 ${MANIFEST_FILE}` })
          continue
        }
        let manifest: WorkbenchManifest
        try {
          manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as WorkbenchManifest
        } catch (error) {
          this.problems.push({ directory: rootDir, reason: `${MANIFEST_FILE} 不是合法 JSON：${String(error)}` })
          continue
        }
        const id = typeof manifest.id === 'string' ? manifest.id : undefined
        const fail = (reason: string): void => { this.problems.push({ directory: rootDir, id, reason }) }
        if (!ID_PATTERN.test(id ?? '')) { fail('id 必须是 [a-z0-9_-]{1,64}（小写字母/数字/下划线/短横线）'); continue }
        if (id === BUILTIN_WORKBENCH_ID) { fail('id 不能叫 builtin（这个名字留给内置工作台）'); continue }
        if (!manifest.name) { fail('缺少 name'); continue }
        if (!VERSION_PATTERN.test(String(manifest.version ?? ''))) { fail('version 必须是 x.y 或 x.y.z'); continue }
        if (typeof manifest.entry !== 'string' || !manifest.entry) { fail('缺少 entry（包内相对 .html 路径）'); continue }
        if (path.isAbsolute(manifest.entry) || manifest.entry.split(/[\\/]/).includes('..')) { fail('entry 必须是包内相对路径，且不能包含 ..'); continue }
        const resolvedRoot = path.resolve(rootDir)
        const entryPath = path.resolve(rootDir, manifest.entry)
        if (!entryPath.startsWith(resolvedRoot + path.sep)) { fail('entry 指到了工作台目录之外'); continue }
        if (!fs.existsSync(entryPath)) { fail(`入口文件不存在：${manifest.entry}`); continue }
        // 示例图是可选装饰：路径越界或文件不存在都只是不给图，不该让整个工作台装不上。
        if (manifest.preview !== undefined) {
          const preview = String(manifest.preview)
          const previewPath = path.resolve(rootDir, preview)
          if (path.isAbsolute(preview) || preview.split(/[\\/]/).includes('..') || !previewPath.startsWith(resolvedRoot + path.sep)) {
            this.problems.push({ directory: rootDir, id, reason: `preview 必须是包内相对路径，已忽略：${preview}` })
            delete manifest.preview
          } else if (!fs.existsSync(previewPath)) {
            this.problems.push({ directory: rootDir, id, reason: `preview 指向的文件不存在，已忽略：${preview}` })
            delete manifest.preview
          }
        }
        if (this.workbenches.has(id!)) { fail(`id 与已加载的工作台重复：${id}`); continue }
        this.workbenches.set(id!, {
          manifest,
          rootDir,
          entryPath,
          builtin: false,
          capabilities: normalizeCapabilities(manifest.capabilities),
          ...(this.sources[id!] ? { sourceDir: this.sources[id!] } : {}),
        })
      }
    }

    const installed = new Set(this.workbenches.keys())
    let changed = false
    for (const key of Object.keys(this.sources)) {
      if (!installed.has(key) && !fs.existsSync(this.sources[key])) { delete this.sources[key]; changed = true }
    }
    if (changed) this.saveSources()
    return this.list()
  }

  list(): WorkbenchDescriptor[] {
    // 内置排第一，其余按名字；工作台不分优先级（一次只有一个在用）。
    return [...this.workbenches.values()].sort((a, b) => {
      if (a.builtin !== b.builtin) return a.builtin ? -1 : 1
      return a.manifest.name.localeCompare(b.manifest.name, 'zh-CN')
    })
  }

  get(id: string): WorkbenchDescriptor | undefined { return this.workbenches.get(id) }
  has(id: string): boolean { return this.workbenches.has(id) }

  /** 安装一个工作台目录（可记录开发目录用于热重载）。 */
  installDirectory(sourceDir: string, options: { link?: boolean } = {}): WorkbenchDescriptor {
    const source = path.resolve(sourceDir)
    const manifestPath = path.join(source, MANIFEST_FILE)
    if (!fs.existsSync(manifestPath)) throw new Error(`工作台目录缺少 ${MANIFEST_FILE}`)
    let manifest: WorkbenchManifest
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as WorkbenchManifest }
    catch (error) { throw new Error(`${MANIFEST_FILE} 不是合法 JSON：${String(error)}`) }
    if (!ID_PATTERN.test(String(manifest.id ?? ''))) throw new Error(`工作台 id 不合法（[a-z0-9_-]{1,64}）：${String(manifest.id ?? '')}`)
    if (manifest.id === BUILTIN_WORKBENCH_ID) throw new Error('id 不能叫 builtin（这个名字留给内置工作台）')
    if (!manifest.name || !VERSION_PATTERN.test(String(manifest.version ?? '')) || !manifest.entry) throw new Error(`${MANIFEST_FILE} 缺少 name / version / entry`)
    if (path.isAbsolute(manifest.entry) || manifest.entry.split(/[\\/]/).includes('..')) throw new Error('entry 必须是包内相对路径，且不能包含 ..')
    const destination = path.join(this.root, manifest.id)
    fs.mkdirSync(this.root, { recursive: true })
    if (source !== path.resolve(destination)) fs.cpSync(source, destination, { recursive: true, force: true })
    const entryPath = path.resolve(destination, manifest.entry)
    if (!entryPath.startsWith(path.resolve(destination) + path.sep) || !fs.existsSync(entryPath)) throw new Error(`入口文件不存在：${manifest.entry}`)
    const descriptor: WorkbenchDescriptor = {
      manifest, rootDir: destination, entryPath, builtin: false,
      capabilities: normalizeCapabilities(manifest.capabilities),
    }
    this.workbenches.set(manifest.id, descriptor)
    if (options.link !== false && source !== path.resolve(destination)) {
      this.sources[manifest.id] = source
      this.saveSources()
    }
    return descriptor
  }

  /** 把开发目录的最新内容同步回安装目录（热重载用）。 */
  syncFromSource(id: string): boolean {
    const source = this.sources[id]
    if (!source) return false
    if (!fs.existsSync(path.join(source, MANIFEST_FILE))) return false
    fs.cpSync(source, path.join(this.root, id), { recursive: true, force: true })
    return true
  }

  uninstall(id: string): void {
    if (id === BUILTIN_WORKBENCH_ID) throw new Error('内置工作台不能卸载')
    const item = this.workbenches.get(id)
    if (item && path.resolve(item.rootDir).startsWith(path.resolve(this.root) + path.sep)) {
      fs.rmSync(item.rootDir, { recursive: true, force: true })
    }
    this.workbenches.delete(id)
    if (this.sources[id]) { delete this.sources[id]; this.saveSources() }
  }
}
