import fs from 'node:fs'
import path from 'node:path'
import { BUILTIN_WORKBENCH_ID } from '../workbench/workbench-manager'

export interface IslandSettings {
  idleMode: 'float' | 'collapsed'
  islandTop: number
  miniScale: number
  pluginOrder: string[]
  disabledPlugins: string[]
  /** 插件 id → 用户选择的上岛方式；没存过就按清单的 resident 默认。 */
  pluginModes: Record<string, 'resident' | 'alert'>
  /** 旧版本升级迁移：已有插件先默认成常驻，避免升级后突然从岛上消失。 */
  pluginModesMigrated: boolean
  /** 登录 Windows 后自动启动（写 HKCU 的 Run 登录项）。 */
  launchAtLogin: boolean
  /** 启动时检查 GitHub Releases 更新。 */
  checkUpdatesOnLaunch: boolean
  /** 当前启用的工作台 id（`builtin` = 内置）。**一次只有一个**。 */
  activeWorkbench: string
  /** 工作台 id → 用户已确认的能力。声明新增能力后必须重新确认才允许启用。 */
  workbenchGrants: Record<string, string[]>
}
export function defaultIslandSettings(): IslandSettings { return { idleMode: 'float', islandTop: 8, miniScale: 1, pluginOrder: [], disabledPlugins: [], pluginModes: {}, pluginModesMigrated: false, launchAtLogin: false, checkUpdatesOnLaunch: true, activeWorkbench: BUILTIN_WORKBENCH_ID, workbenchGrants: {} } }

/** Owns persisted settings; the value identity stays stable across loading. */
export class SettingsStore {
  readonly value = defaultIslandSettings()
  constructor(private readonly file: string) {}
  load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<IslandSettings>
      Object.assign(this.value, {
        idleMode: parsed.idleMode === 'collapsed' ? 'collapsed' : 'float',
        islandTop: Number.isFinite(Number(parsed.islandTop)) ? Math.max(0, Math.min(200, Math.round(Number(parsed.islandTop)))) : 8,
        miniScale: Number.isFinite(Number(parsed.miniScale)) ? Math.max(0.5, Math.min(1.5, Math.round(Number(parsed.miniScale) * 20) / 20)) : 1,
        pluginOrder: Array.isArray(parsed.pluginOrder) ? parsed.pluginOrder.filter(id => typeof id === 'string') : [],
        disabledPlugins: Array.isArray(parsed.disabledPlugins) ? parsed.disabledPlugins.filter(id => typeof id === 'string') : [],
        pluginModes: parsed.pluginModes && typeof parsed.pluginModes === 'object'
          ? Object.fromEntries(Object.entries(parsed.pluginModes as Record<string, unknown>)
            .filter(([, value]) => value === 'resident' || value === 'alert')) as Record<string, 'resident' | 'alert'>
          : {},
        pluginModesMigrated: parsed.pluginModesMigrated === true,
        launchAtLogin: parsed.launchAtLogin === true,
        checkUpdatesOnLaunch: parsed.checkUpdatesOnLaunch !== false,
        activeWorkbench: typeof parsed.activeWorkbench === 'string' && parsed.activeWorkbench ? parsed.activeWorkbench : BUILTIN_WORKBENCH_ID,
        workbenchGrants: parsed.workbenchGrants && typeof parsed.workbenchGrants === 'object'
          ? Object.fromEntries(Object.entries(parsed.workbenchGrants as Record<string, unknown>)
            .filter(([, value]) => Array.isArray(value))
            .map(([key, value]) => [key, (value as unknown[]).filter(item => typeof item === 'string') as string[]]))
          : {},
      })
    } catch { /* first run uses defaults */ }
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(this.value, null, 2), 'utf8')
  }
  snapshot(): IslandSettings {
    return { ...this.value, pluginOrder: [...this.value.pluginOrder], disabledPlugins: [...this.value.disabledPlugins], pluginModes: { ...this.value.pluginModes }, workbenchGrants: Object.fromEntries(Object.entries(this.value.workbenchGrants).map(([id, grants]) => [id, [...grants]])) }
  }
}
