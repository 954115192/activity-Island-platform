import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extractZip, isZipFile } from './zip'
import type { PluginManager } from './plugin-manager'
import type { PluginBackgroundManager } from './plugin-background-manager'
import type { WorkbenchManager } from '../workbench/workbench-manager'

export interface InstalledArtifact {
  kind: 'plugin' | 'workbench'
  id: string
  name: string
  version: string
  capabilities?: string[]
}
interface PackageInstallerOptions {
  readonly plugins: PluginManager | null
  readonly workbenches: WorkbenchManager | null
  readonly background: PluginBackgroundManager | null
  log(id: string, level: 'info', message: string): void
  watch(): void
  refreshIsland(): Promise<void>
  pluginsChanged(): void
  workbenchesChanged(): void
}

/** Unpacks once, chooses the artifact by its manifest and cleans temporary files. */
export function createPackageInstaller(options: PackageInstallerOptions) {
  async function installPackage(filePath: string): Promise<InstalledArtifact> {
    if (!options.plugins) throw new Error('插件管理器未就绪')
    if (!fs.existsSync(filePath)) throw new Error(`文件不存在：${filePath}`)
    // 先给出人话错误：拿一个 exe/txt 来当插件包是最常见的误操作。
    if (!isZipFile(filePath)) throw new Error('这不是一个插件包（.islandplugin 应该是 zip 格式）')
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'island-plugin-'))
    try {
      const written = extractZip(filePath, temp)
      if (!written.length) throw new Error('插件包是空的')
      // 包内可能直接是产物目录，也可能套了一层外层目录
      const candidates = [temp, ...fs.readdirSync(temp, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => path.join(temp, entry.name))]
      const workbenchRoot = candidates.find(dir => fs.existsSync(path.join(dir, 'workbench.json')))
      if (workbenchRoot) {
        if (!options.workbenches) throw new Error('工作台管理器未就绪')
        const installed = options.workbenches.installDirectory(workbenchRoot)
        options.log?.('_host', 'info', `已从插件包安装控制台「${installed.manifest.name}」（${path.basename(filePath)}，${written.length} 个文件）`)
        options.workbenchesChanged()
        return { kind: 'workbench', id: installed.manifest.id, name: installed.manifest.name, version: installed.manifest.version, capabilities: installed.capabilities }
      }
      const root = candidates.find(dir => fs.existsSync(path.join(dir, 'plugin.json')))
      if (!root) throw new Error('包内既没有 plugin.json 也没有 workbench.json（确认这是用「导出插件包」生成的包）')
      const plugin = options.plugins.installDirectory(root, { link: false })
      options.log?.(plugin.manifest.id, 'info', `已从插件包安装 v${plugin.manifest.version}（${path.basename(filePath)}，${written.length} 个文件）`)
      options.background?.start(plugin)
      options.watch()
      await options.refreshIsland()
      options.pluginsChanged()
      return { kind: 'plugin', id: plugin.manifest.id, name: plugin.manifest.name, version: plugin.manifest.version }
    } finally {
      fs.rmSync(temp, { recursive: true, force: true })
    }
  }
  return installPackage
}
