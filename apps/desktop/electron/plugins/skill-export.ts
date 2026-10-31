import { dialog, ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { zipDirectory } from './zip'
import type { PluginLogger } from './plugin-logger'
import type { createAppResources } from '../system/resources'

interface SkillExportOptions {
  resources: ReturnType<typeof createAppResources>
  readonly logger: PluginLogger | null
}
export function registerSkillExportIpc(ports: SkillExportOptions): void {

  // 把"生成 Skill 包"导出给用户：解压进本地 AI（Claude Code 等）的 skills 目录，
  // 本地 AI 读 SKILL.md 就能按规范生成插件或工作台。kind 决定导出哪份规范。
  ipcMain.handle('skill:download', async (_event, kind: string) => {
    const skillId = kind === 'workbench' ? 'island-workbench' : 'island-plugin'
    const skillDir = path.join(ports.resources.root(), 'skills', skillId)
    if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) return { ok: false, error: `Skill 包源目录不存在（skills/${skillId}/SKILL.md）` }
    const picked = await dialog.showSaveDialog({
      title: kind === 'workbench' ? '保存工作台生成 Skill 包' : '保存插件生成 Skill 包',
      defaultPath: `${skillId}-skill.zip`,
      filters: [{ name: 'Skill 包', extensions: ['zip'] }],
    })
    if (picked.canceled || !picked.filePath) return { ok: false, canceled: true }
    try {
      const bytes = zipDirectory(skillDir, picked.filePath, { skipDir: name => name.startsWith('.') })
      ports.logger?.append('_host', 'info', `已导出生成 Skill 包（${skillId}）：${picked.filePath}（${Math.round(bytes / 1024)} KB）`)
      return { ok: true, path: picked.filePath, bytes }
    } catch (error) {
      try { fs.rmSync(picked.filePath, { force: true }) } catch { /* 忽略 */ }
      return { ok: false, error: `打包失败：${String((error as Error)?.message ?? error)}` }
    }
  })
}
