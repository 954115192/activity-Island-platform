import { fitMiniBar } from './mini-bar'
import { BUILTIN_NOTIFICATIONS_ID } from '../notifications/module'
import type { PluginDescriptor, PluginMode } from '../plugins/types'

export const SMALL_DEFAULT = { width: 134, height: 38 }
export const WINDOW_SIZE = { width: 1064, height: 730 }
/** mini 条最多能占多宽（窗口本身就这么宽，留点余量）。 */
const MINI_BAR_MAX_WIDTH = WINDOW_SIZE.width - 24
/** 溢出时 `+N` 徽标的宽度。 */
const OVERFLOW_CHIP_WIDTH = 34
export const MODE_DEFAULTS: Record<PluginMode, { width: number; height: number }> = {
  small: SMALL_DEFAULT,
  medium: { width: 400, height: 160 },
  large: { width: 600, height: 220 },
}

export type PluginPlacement = { pluginId: string; x: number; width: number; height: number }
export type AnimatedLayout = { width: number; height: number; top: number; placements: PluginPlacement[]; clipPlugins: boolean }
export function pluginSize(plugin: PluginDescriptor, mode: PluginMode): { width: number; height: number } {
  const configured = plugin.manifest[mode]
  const defaults = MODE_DEFAULTS[mode]
  const range = mode === 'medium'
    ? { minWidth: 260, minHeight: 110, maxWidth: 800, maxHeight: 400 }
    : mode === 'large'
      ? { minWidth: 400, minHeight: 160, maxWidth: 1000, maxHeight: 680 }
      : { minWidth: 64, minHeight: 28, maxWidth: 1000, maxHeight: 120 }
  const numberOr = (value: unknown, fallback: number): number => Number.isFinite(Number(value)) ? Number(value) : fallback
  const width = numberOr(configured?.preferredWidth ?? configured?.width, defaults.width)
  const height = numberOr(configured?.preferredHeight ?? configured?.height, defaults.height)
  const minWidth = Math.max(range.minWidth, numberOr(configured?.minWidth, range.minWidth))
  const minHeight = Math.max(range.minHeight, numberOr(configured?.minHeight, range.minHeight))
  const maxWidth = Math.min(range.maxWidth, Math.max(minWidth, numberOr(configured?.maxWidth, range.maxWidth)))
  const maxHeight = Math.min(range.maxHeight, Math.max(minHeight, numberOr(configured?.maxHeight, range.maxHeight)))
  return {
    width: Math.max(minWidth, Math.min(maxWidth, Math.round(width))),
    height: Math.max(minHeight, Math.min(maxHeight, Math.round(height))),
  }
}
export function pluginGeometry(layout: AnimatedLayout, placement: PluginPlacement) {
  const targetLeft = (WINDOW_SIZE.width - layout.width) / 2
  return {
    x: Math.round(targetLeft + placement.x),
    y: Math.round(layout.top + (layout.height - placement.height) / 2),
    width: placement.width,
    height: placement.height,
  }
}

/** Compact (small) island layout for one scale: plugin placements plus the content size the shell grows around. */
export function compactLayout(visible: PluginDescriptor[], scale: number, options: { solo?: boolean; soloWidth?: number; maxWidth?: number } = {}): { placements: PluginPlacement[]; separators: number[]; baseWidth: number; height: number; overflow: number; chipX: number | null } {
  const padding = Math.round(8 * scale)
  const measured = visible.map(plugin => {
    const size = pluginSize(plugin, 'small')
    return { pluginId: plugin.manifest.id, width: Math.round(size.width * scale), height: Math.round(size.height * scale) }
  })
  const minWidth = Math.round(SMALL_DEFAULT.width * scale)
  // 提醒态：只显示一条，居中，不给分隔线也不溢出。
  if (options.solo && measured.length > 0) {
    const only = measured[0]
    // 提醒可申请更宽（island.alert 的 width，逻辑 px）：按 miniScale 缩放，
    // 不小于清单声明的 small 宽（推荐尺寸下限），不超过 mini 条最大宽。
    // 注意申请的宽度直接作用于插件视图本身（页面是 100% 布局，能自适应更宽的画布）。
    const requested = options.soloWidth !== undefined ? Math.round(options.soloWidth * scale) : only.width
    const contentWidth = Math.max(only.width, Math.min(requested, MINI_BAR_MAX_WIDTH - padding * 2))
    const baseWidth = Math.max(minWidth, contentWidth + padding * 2)
    return {
      // 通知计数区贴到提醒胶囊右边缘，使其圆弧与外壳同心。
      placements: [{ pluginId: only.pluginId, x: Math.round((baseWidth - contentWidth) / 2), width: contentWidth + (only.pluginId === BUILTIN_NOTIFICATIONS_ID ? padding : 0), height: only.height }],
      separators: [], baseWidth, height: only.height, overflow: 0, chipX: null,
    }
  }
  const fit = fitMiniBar(measured.map(({ pluginId, width }) => ({ pluginId, width })), padding, minWidth, options.maxWidth ?? MINI_BAR_MAX_WIDTH, Math.round(OVERFLOW_CHIP_WIDTH * scale))
  const kept = new Set(fit.kept.map(segment => segment.pluginId))
  const placements: PluginPlacement[] = []
  const separators: number[] = []
  let x = padding
  let height = Math.round(SMALL_DEFAULT.height * scale)
  for (const segment of measured) {
    if (!kept.has(segment.pluginId)) continue
    placements.push({ pluginId: segment.pluginId, x, width: segment.width, height: segment.height })
    x += segment.width
    height = Math.max(height, segment.height)
    if (placements.length < fit.kept.length) separators.push(x)
  }
  return {
    placements, separators, height,
    baseWidth: Math.max(minWidth, fit.contentWidth + padding * 2),
    overflow: fit.dropped,
    chipX: fit.dropped > 0 ? x + Math.round(6 * scale) : null,
  }
}

/** Reserve a small host-owned trailing slot while the user hovers the island. */
export function compactLayoutWithQuickActions(visible: PluginDescriptor[], scale: number, enabled: boolean) {
  if (!enabled) return { layout: compactLayout(visible, scale), quickActions: false }
  const slot = Math.round(44 * scale)
  const layout = compactLayout(visible, scale)
  if (layout.baseWidth + slot > MINI_BAR_MAX_WIDTH) return { layout, quickActions: false }
  const shift = Math.round(slot / 2)
  return {
    layout: {
      ...layout,
      placements: layout.placements.map(placement => ({ ...placement, x: placement.x + shift })),
      separators: layout.separators.map(position => position + shift),
      baseWidth: layout.baseWidth + slot,
      chipX: layout.chipX == null ? null : layout.chipX + shift,
    },
    quickActions: true,
  }
}
