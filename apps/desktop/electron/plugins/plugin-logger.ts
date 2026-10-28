import fs from 'node:fs'
import path from 'node:path'

/** 单个插件日志文件的滚动上限。 */
const MAX_BYTES = 5 * 1024 * 1024
/** 控制台一次最多读多少行。 */
const TAIL_LINES = 400

/**
 * 插件日志：`<userData>/island-plugins/logs/<id>.log`。
 *
 * 插件自己的 `island.log.*`、后台脚本的 stdout/stderr、宿主侧的错误（加载失败、
 * 渲染进程消失、热重载）都汇到这里，写日志永远不能影响插件运行。
 */
export class PluginLogger {
  constructor(private readonly root: string) {
    try { fs.mkdirSync(root, { recursive: true }) } catch { /* ignore */ }
  }

  private file(pluginId: string): string { return path.join(this.root, `${this.safe(pluginId)}.log`) }

  private safe(pluginId: string): string { return pluginId.replace(/[^a-z0-9_-]/gi, '_') || 'unknown' }

  append(pluginId: string, level: 'info' | 'warn' | 'error', message: unknown): void {
    try {
      const file = this.file(pluginId)
      try { if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`) } catch { /* 文件还不存在 */ }
      const text = typeof message === 'string' ? message : JSON.stringify(message)
      fs.appendFileSync(file, `[${new Date().toISOString()}] [${level}] ${text}\n`, 'utf8')
    } catch { /* 日志失败不影响运行 */ }
  }

  tail(pluginId: string, lines = TAIL_LINES): string[] {
    try {
      return fs.readFileSync(this.file(pluginId), 'utf8').split(/\r?\n/).filter(line => line.length > 0).slice(-lines)
    } catch { return [] }
  }

  clear(pluginId: string): void {
    try { fs.rmSync(this.file(pluginId), { force: true }); fs.rmSync(`${this.file(pluginId)}.1`, { force: true }) } catch { /* ignore */ }
  }
}
