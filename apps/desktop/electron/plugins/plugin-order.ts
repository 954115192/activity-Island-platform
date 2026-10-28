import type { PluginDescriptor } from './types'

/** mini 段的默认优先级；manifest 里的 `priority` 越大越靠左。 */
export const DEFAULT_PRIORITY = 50

export function pluginPriority(plugin: PluginDescriptor): number {
  const value = Number(plugin.manifest.priority)
  return Number.isFinite(value) ? value : DEFAULT_PRIORITY
}

/**
 * mini 段顺序：**用户拖拽顺序 > priority（大到小）> 插件名**。
 *
 * 排序是用户态：用户排过的插件永远按用户顺序在前，没排过的按 priority 接在后面，
 * 这样插件升级/新装都不会打乱用户已经调好的顺序。
 */
export function orderPlugins(plugins: PluginDescriptor[], userOrder: string[] = []): PluginDescriptor[] {
  const rank = new Map<string, number>()
  userOrder.forEach((id, index) => { if (!rank.has(id)) rank.set(id, index) })
  return [...plugins].sort((a, b) => {
    const rankA = rank.get(a.manifest.id)
    const rankB = rank.get(b.manifest.id)
    if (rankA !== undefined || rankB !== undefined) {
      if (rankA === undefined) return 1
      if (rankB === undefined) return -1
      if (rankA !== rankB) return rankA - rankB
    }
    const priorityA = pluginPriority(a)
    const priorityB = pluginPriority(b)
    if (priorityA !== priorityB) return priorityB - priorityA
    return a.manifest.name.localeCompare(b.manifest.name, 'zh-CN')
  })
}

/** 清理用户顺序：丢掉已经卸载的插件 id，保持稳定。 */
export function pruneOrder(userOrder: string[], installedIds: string[]): string[] {
  const installed = new Set(installedIds)
  return userOrder.filter((id, index) => installed.has(id) && userOrder.indexOf(id) === index)
}
