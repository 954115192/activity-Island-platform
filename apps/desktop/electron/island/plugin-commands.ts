import type { BrowserWindow } from 'electron'
import type { IslandMode, PluginMode, PluginDescriptor } from '../plugins/types'
import type { PluginViewManager } from '../plugins/plugin-view-manager'
import type { PluginToolState } from '../plugins/tool-state'
import type { IslandSettings } from '../settings/store'
import type { IslandState } from './island-state'
import type { IntentArbiter } from './intent-arbiter'
import type { createIslandPointer } from './pointer'
import type { EventBus } from '../events/event-bus'
import { pluginSize, MODE_DEFAULTS } from './geometry'

type Size = { width: number; height: number }
interface PluginCommandOptions {
  readonly disposed: boolean
  readonly hostMode: IslandMode
  host: { readonly window: BrowserWindow | null; readonly views: PluginViewManager | null }
  settings: IslandSettings
  state: IslandState
  arbiter: IntentArbiter
  pointer: Pick<ReturnType<typeof createIslandPointer>, 'inside' | 'compactHover'>
  plugins: { get(id: string): PluginDescriptor | undefined; tools: PluginToolState; hidden: Set<string> }
  events: EventBus
  carryAlert(pluginId: string): void
  clearAlertCarry(): void
  showActive(plugin: PluginDescriptor, mode: 'expanded' | 'detail'): Promise<void>
  showCompact(hovered?: boolean): Promise<void>
  stageOrigin(width: number, height: number, top?: number): Size & { x: number; y: number }
  setHitRegion(region: Size & { x: number; y: number; radius: number }): void
  sendLayout(mode: IslandMode, pluginMode: PluginMode, separators: number[], collapsed: boolean, size: Size, top: number): void
  centerBounds(width: number, height: number): Electron.Rectangle | undefined
  animateWindow(bounds: Electron.Rectangle, duration?: number): Promise<void>
  mediaKey(action: 'previous' | 'toggle' | 'next'): void
}

/** Routes plugin UI commands through explicit island operations. */
export function createPluginCommands(commands: PluginCommandOptions) {
  function handlePluginCommand(pluginId: string, command: string, args: unknown[]): void {
    if (commands.disposed) return
    const plugin = commands.plugins.get(pluginId)
    if (!plugin) return
    const state = commands.state.value
    if (command === 'ui:expand') {
      // 用户点自己的 mini 段 → 用户操作优先，直接展开并登记独占。
      if (state.mode === 'compact') {
        if (plugin.manifest.medium) {
          // 点的是正在显示的提醒 → 光圈跟随进中岛，离开展开态才撤。
          commands.carryAlert(pluginId)
          commands.arbiter.claimFocus({ pluginId, view: 'medium', reason: 'user' })
          void commands.showActive(plugin, 'expanded')
        }
      } else if (state.mode === 'expanded' && state.activePluginId === pluginId && plugin.manifest.large) {
        // 中岛升大岛：光圈继续跟随（若它正带着提醒光圈）。
        commands.arbiter.claimFocus({ pluginId, view: 'large', reason: 'user' })
        void commands.showActive(plugin, 'detail')
      }
    } else if (command === 'ui:collapse') {
      // 回到 mini 段。
      commands.clearAlertCarry()
      commands.arbiter.releaseFocus('self', pluginId)
      void commands.showCompact()
    } else if (command === 'ui:close') {
      // "我这条显示结束"：先撤掉自己的提醒；否则按收起处理。
      if (commands.arbiter.dismissAlert(pluginId)) return
      commands.clearAlertCarry()
      commands.arbiter.releaseFocus('self', pluginId)
      void commands.showCompact()
    } else if (command === 'alert') {
      commands.arbiter.requestAlert({ pluginId, ...(args[0] as object | undefined) })
    } else if (command === 'focus') {
      commands.arbiter.requestFocus({ pluginId, ...(args[0] as object | undefined) })
    } else if (command === 'tools:set') {
      commands.plugins.tools.update(pluginId, args[0], args[1])
    } else if (command === 'ui:request-size' && state.activePluginId === pluginId && commands.host.window) {
      const requested = args[0] as { width?: number; height?: number } | undefined
      if (!requested) return
      const mode = state.mode === 'detail' ? 'large' : 'medium'
      const declared = pluginSize(plugin, mode)
      const configured = plugin.manifest[mode]
      const defaults = MODE_DEFAULTS[mode]
      const minWidth = Math.max(mode === 'large' ? 400 : 260, Number(configured?.minWidth) || 0)
      const minHeight = Math.max(mode === 'large' ? 160 : 110, Number(configured?.minHeight) || 0)
      const maxWidth = Math.min(mode === 'large' ? 1000 : 800, Math.max(minWidth, Number(configured?.maxWidth) || Infinity))
      const maxHeight = Math.min(mode === 'large' ? 680 : 400, Math.max(minHeight, Number(configured?.maxHeight) || Infinity))
      const width = Math.max(minWidth, Math.min(maxWidth, Math.round(requested.width ?? declared.width ?? defaults.width)))
      const height = Math.max(minHeight, Math.min(maxHeight, Math.round(requested.height ?? declared.height ?? defaults.height)))
      const stage = commands.stageOrigin(width, height, commands.settings.islandTop)
      commands.host.views?.setBounds(pluginId, { x: stage.x, y: stage.y, width, height })
      commands.setHitRegion({ x: stage.x, y: stage.y, width, height, radius: 30 })
      commands.sendLayout(state.mode, mode, [], false, { width, height }, stage.y)
      const bounds = commands.centerBounds(width, height)
      if (bounds) void commands.animateWindow(bounds, 260)
    } else if (command === 'media:command') {
      // 全局媒体键：任何播放器都认，插件不需要自己的后台脚本也能控制播放。
      const action = args[0]
      if (action === 'previous' || action === 'toggle' || action === 'next') {
        commands.mediaKey(action)
        commands.events.emit('media:command', { pluginId, action })
      }
    } else if (command === 'ui:presence') {
      // 插件自报"我现在有没有内容"：false = 别占着 mini 条（例如没有正在播放的媒体）。
      const present = args[0] !== false
      if (present !== !commands.plugins.hidden.has(pluginId)) {
        if (present) commands.plugins.hidden.delete(pluginId)
        else commands.plugins.hidden.add(pluginId)
        if (!present) {
          commands.host.views?.hide(pluginId)
          // 立刻让插件知道"你已经不在岛上了"，它的 island.every() 会自动暂停。
          commands.host.views?.publishContract({ islandMode: commands.hostMode, activePluginId: commands.state.value.activePluginId, scale: commands.settings.miniScale })
          // 正展开着它却被自己撤下 → 回到 mini 条，别留一个空白中岛。
          if ((state.mode === 'expanded' || state.mode === 'detail') && state.activePluginId === pluginId) {
            commands.clearAlertCarry()
            commands.arbiter.releaseFocus('self', pluginId)
            void commands.showCompact(commands.pointer.inside)
            return
          }
        }
        // 只有 mini 条正在显示时才重排；收起态（idle）不主动弹出来打扰用户。
        // 例外是浮动模式：那条横条本来就该一直挂着，插件又有内容了就把条恢复出来。
        if (commands.state.value.mode === 'compact') void commands.showCompact(commands.pointer.compactHover)
        else if (commands.state.value.mode === 'idle' && commands.settings.idleMode !== 'collapsed') void commands.showCompact(false)
      }
    }
  }
  return handlePluginCommand
}
