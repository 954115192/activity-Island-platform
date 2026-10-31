import fs from 'node:fs'
import path from 'node:path'
import { zipDirectory, readZipEntries } from './zip'

/** 打包时要跳过的目录名（都不是插件运行需要的东西）。 */
const PACK_SKIP_DIRS = new Set(['node_modules', '.git', '.idea', '.vscode'])
/** 运行时垃圾与编辑器临时文件：打进包里只会让体积变大、还可能误导对方。 */
const PACK_SKIP_FILE = /(\.log|\.tmp|\.swp|\.bak|\.orig)$/i
const PACK_SKIP_NAMES = new Set(['state.json', 'state.js'])

/**
 * 把产物目录打包成 `.islandplugin`（本质是 zip），对方用「导入插件包」就能直接装。
 * 插件和控制台**共用这一个实现**（清单文件名不同而已）—— 两者都是"可分发"的东西，
 * 打包规则没理由分两套。
 *
 * 用宿主自己的 zip 实现，**不调用 PowerShell**：Compress-Archive 实测会随调用形态与
 * 目标扩展名给出不一致的结果（`.islandplugin` 有时被拒、无扩展名时静默不产出文件），
 * 而它的 stderr 又容易被吞掉，用户只看到一个没有信息量的 "exit 1"。
 */
export function exportArtifactPackage(options: { rootDir: string; manifestFile: string; entry: string; label: string; logId: string; version: string }, targetPath: string, log: (id: string, message: string) => void): { ok: boolean; path?: string; bytes?: number; entries?: number; error?: string } {
  const { rootDir, manifestFile, entry, label, logId, version } = options
  if (!fs.existsSync(path.join(rootDir, manifestFile))) return { ok: false, error: `目录里没有 ${manifestFile}` }
  try {
    const bytes = zipDirectory(rootDir, targetPath, {
      skipDir: name => name.startsWith('.') || PACK_SKIP_DIRS.has(name),
      skipFile: name => name.startsWith('.') || PACK_SKIP_NAMES.has(name) || PACK_SKIP_FILE.test(name),
    })
    // 打完之后复核一遍：解开来装不上就白搭了。
    const entries = readZipEntries(targetPath).map(item => item.name)
    const missing = [manifestFile, String(entry ?? '')].filter(name => name && !entries.includes(name))
    if (missing.length) {
      fs.rmSync(targetPath, { force: true })
      return { ok: false, error: `打包内容缺少必需文件：${missing.join('、')}` }
    }
    log(logId, `已导出${label} v${version} → ${targetPath}（${Math.round(bytes / 1024)} KB，${entries.length} 个文件）`)
    return { ok: true, path: targetPath, bytes, entries: entries.length }
  } catch (error) {
    // 失败时不要留下半成品，否则用户会以为"包已经生成了"。
    try { fs.rmSync(targetPath, { force: true }) } catch { /* 忽略 */ }
    return { ok: false, error: `打包失败：${String((error as Error)?.message ?? error)}` }
  }
}

