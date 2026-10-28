import fs from 'node:fs'
import path from 'node:path'

export class PluginStorage {
  constructor(private readonly root: string) { fs.mkdirSync(root, { recursive: true }) }
  private file(pluginId: string): string { return path.join(this.root, `${pluginId}.json`) }
  private read(pluginId: string): Record<string, unknown> {
    try { return JSON.parse(fs.readFileSync(this.file(pluginId), 'utf8')) as Record<string, unknown> } catch { return {} }
  }
  get(pluginId: string, key: string): unknown { return this.read(pluginId)[key] }
  /** 读出全部键值（工作台的 storage.all() 用）。 */
  all(pluginId: string): Record<string, unknown> { return this.read(pluginId) }
  set(pluginId: string, key: string, value: unknown): void {
    const data = this.read(pluginId); data[key] = value
    fs.writeFileSync(this.file(pluginId), JSON.stringify(data, null, 2), 'utf8')
  }
  /** 删掉单个键（`remove` 是删整个插件的存储文件，别混用）。 */
  delete(pluginId: string, key: string): void {
    const data = this.read(pluginId)
    if (!(key in data)) return
    delete data[key]
    fs.writeFileSync(this.file(pluginId), JSON.stringify(data, null, 2), 'utf8')
  }
  remove(pluginId: string): void { fs.rmSync(this.file(pluginId), { force: true }) }
}
