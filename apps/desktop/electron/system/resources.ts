import { app, nativeImage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

/** Application paths, native icons and cached development listener executables. */
export function createAppResources(log: (level: 'warn', message: string) => void) {
  function appRoot(): string { return app.isPackaged ? app.getAppPath() : process.cwd() }
  /** Run a cached copy in development so publishing a new listener never replaces a running executable. */
  function developmentListenerExe(): string {
    const built = path.join(appRoot(), 'build', 'notify-listener', 'notify-listener.exe')
    const fallback = path.join(appRoot(), 'resources', 'notifications', 'notify-listener.exe')
    if (!fs.existsSync(built)) return fallback
    try {
      const bytes = fs.readFileSync(built)
      const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 20)
      const cacheDir = path.join(app.getPath('temp'), 'activity-island-listeners')
      fs.mkdirSync(cacheDir, { recursive: true })
      const cached = path.join(cacheDir, `notify-listener-${hash}.exe`)
      if (!fs.existsSync(cached)) fs.writeFileSync(cached, bytes, { flag: 'wx' })
      return cached
    } catch (error) {
      log( 'warn', `无法缓存开发版通知监听器：${String(error)}`)
      return built
    }
  }
  /**
   * 资源文件（assets/ 由 `npm run icons` 生成）。
   *
   * 打包之后 assets/ 是**放在 asar 外面**的（见 electron-builder.yml 的 extraResources）：
   * `nativeImage.createFromPath` 与 `Tray` 对 asar 内路径的支持不稳定，而图标是托盘和任务栏的
   * 关键，一旦读不到就会回落成 Electron 默认图标（用户看到的就是"任务栏图标又没了"）。
   * 所以这里优先用真实路径 `process.resourcesPath`，源码运行时才回落成仓库里的 assets/。
   */
  function assetFile(name: string): string {
    const candidates = [
      path.join(process.resourcesPath ?? '', 'assets', name),
      path.join(appRoot(), 'assets', name),
    ]
    for (const candidate of candidates) {
      try { if (candidate && fs.existsSync(candidate)) return candidate } catch { /* 忽略 */ }
    }
    return candidates[1]
  }
  function appIcon(): Electron.NativeImage | undefined {
    try {
      const file = assetFile('icon.ico')
      const image = nativeImage.createFromPath(file)
      if (image.isEmpty()) {
        // 打包后图标读不到是"任务栏/托盘没图标"最常见的原因（assets 没跟着进安装包），
        // 必须自己说出来，否则用户只能看到"图标又没了"。
        log( 'warn', `应用图标读取失败（空图）：${file}`)
        return undefined
      }
      return image
    } catch (error) {
      log( 'warn', `应用图标读取异常：${String((error as Error)?.message ?? error)}`)
      return undefined
    }
  }
  return { root: appRoot, asset: assetFile, icon: appIcon, listenerExe: developmentListenerExe }
}
