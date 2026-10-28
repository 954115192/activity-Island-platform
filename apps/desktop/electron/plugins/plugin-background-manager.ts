import { spawn, type ChildProcess } from 'node:child_process'
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { PluginDescriptor } from './types'

interface ProcessHandle { pluginId: string; process: ChildProcess; buffer: string }

export class PluginBackgroundManager {
  private readonly processes = new Map<string, ProcessHandle>()

  constructor(
    private readonly emit: (pluginId: string, name: string, payload: unknown) => void,
    /**
     * 该插件当前的参数。后台脚本拿不到宿主的存储，只能在启动时通过环境变量收到一份快照；
     * 参数保存后由宿主重启进程（见 main.ts 的 savePluginSettings），脚本重新读一次。
     */
    private readonly settingsFor: (pluginId: string) => Record<string, unknown> = () => ({}),
  ) {}

  start(plugin: PluginDescriptor): void {
    const config = plugin.manifest.background
    if (!config?.entry || this.processes.has(plugin.manifest.id)) return
    const entryPath = path.resolve(plugin.rootDir, config.entry)
    if (!entryPath.startsWith(path.resolve(plugin.rootDir) + path.sep) || !fs.existsSync(entryPath)) {
      this.emit(plugin.manifest.id, 'runtime:error', { reason: 'background-entry-not-found', entry: config.entry, root: plugin.rootDir })
      return
    }
    // ISLAND_PLUGIN_DATA = 该插件的 storage 目录（plugin:storage 读写的就是这里的
    // <id>.json）。后台脚本没有 SDK，想要"视图 → 后台"的控制通道，只能靠轮询这个
    // 文件当命令信箱 —— 视图 island.storage.set('cmd', …)，脚本改完把结果推回 stdout。
    const env = {
      ...process.env,
      ISLAND_PLUGIN_SETTINGS: JSON.stringify(this.settingsFor(plugin.manifest.id)),
      ISLAND_PLUGIN_DATA: path.join(app.getPath('userData'), 'plugin-data'),
    }
    const isPowerShell = entryPath.toLowerCase().endsWith('.ps1')
    const child = isPowerShell
      ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', entryPath], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env })
      : spawn(process.execPath, [entryPath], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env })
    const handle: ProcessHandle = { pluginId: plugin.manifest.id, process: child, buffer: '' }
    this.processes.set(plugin.manifest.id, handle)
    if (process.env.ISLAND_BG_DEBUG) console.log('[bg] start', plugin.manifest.id, 'pid', child.pid, 'entry', entryPath)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => this.consume(handle, String(chunk)))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => this.emit(plugin.manifest.id, 'runtime:log', { level: 'error', message: String(chunk).trim() }))
    child.on('error', error => this.emit(plugin.manifest.id, 'runtime:error', { reason: 'background-process-error', message: String(error) }))
    child.on('close', code => {
      // 关键：旧进程的 close 是异步到的，热重载时它常常在新进程已经注册**之后**才触发。
      // 不判断"这个 handle 还是不是当前那个"就删表，会把刚起来的新进程从表里删掉，
      // 于是它再也没人管 —— 每热重载一次就泄漏一个后台进程（真实踩过：两分钟堆了 100 多个）。
      if (this.processes.get(plugin.manifest.id) === handle) this.processes.delete(plugin.manifest.id)
      else if (process.env.ISLAND_BG_DEBUG) console.log('[bg] stale close ignored', plugin.manifest.id, 'pid', child.pid)
      this.emit(plugin.manifest.id, 'runtime:exit', { code })
    })
  }

  private consume(handle: ProcessHandle, chunk: string): void {
    handle.buffer += chunk
    const lines = handle.buffer.split(/\r?\n/)
    handle.buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const data = JSON.parse(trimmed) as { type?: unknown; payload?: unknown }
        this.emit(handle.pluginId, typeof data.type === 'string' ? data.type : 'runtime:data', data.payload ?? data)
      } catch {
        this.emit(handle.pluginId, 'runtime:log', { level: 'info', message: trimmed })
      }
    }
  }

  stop(pluginId: string): void {
    const handle = this.processes.get(pluginId)
    if (process.env.ISLAND_BG_DEBUG) console.log('[bg] stop', pluginId, handle ? `pid ${handle.process.pid}` : '(no handle)')
    if (!handle) return
    this.processes.delete(pluginId)
    this.kill(handle.process)
  }

  stopAll(): void { for (const id of [...this.processes.keys()]) this.stop(id) }

  /**
   * 真的把进程杀掉。
   * Windows 上只 kill 直接子进程是不够的：powershell.exe 下面可能还挂着子进程，
   * 而且一旦没杀干净，旧脚本会继续跑（继续写文件、继续占 CPU），宿主却再也管不到它 —— 这就是
   * "热重载几次之后插件进程越堆越多、日志一秒一条重载"的根源。所以整棵进程树一起杀。
   */
  private kill(child: ChildProcess): void {
    const pid = child.pid
    if (!pid) return
    // 先杀直接子进程（同步、必定执行），再用 taskkill 收拾它可能留下的后代进程。
    try { child.kill() } catch { /* already exited */ }
    if (process.platform !== 'win32') return
    try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch { /* 已经没了就算了 */ }
  }
}

