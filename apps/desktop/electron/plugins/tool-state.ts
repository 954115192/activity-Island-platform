import type { PluginDescriptor, PluginTool, PluginToolView } from './types'

type LiveTool = { view?: PluginToolView; notice?: string | null; updatedAt: number }
const VIEW_TYPES = new Set(['stats', 'list', 'focus', 'media', 'text'])
function isToolView(value: unknown): value is PluginToolView {
  if (!value || typeof value !== 'object') return false
  const type = (value as { type?: unknown }).type
  return typeof type === 'string' && VIEW_TYPES.has(type)
}

/** Manifest tools plus validated runtime updates. No window or IPC ownership. */
export class PluginToolState {
  private readonly live = new Map<string, Record<string, LiveTool>>()
  constructor(
    private readonly plugin: (id: string) => PluginDescriptor | undefined,
    private readonly changed: (id: string, tools: PluginTool[]) => void,
  ) {}

  list(id: string): PluginTool[] {
    const tools = this.plugin(id)?.manifest.tools
    if (!Array.isArray(tools)) return []
    const live = this.live.get(id) ?? {}
    return tools.map(tool => {
      const patch = live[tool.id]
      if (!patch) return tool
      const merged = { ...tool, ...(patch.view ? { view: patch.view } : {}), updatedAt: patch.updatedAt }
      if ('notice' in patch) merged.notice = patch.notice ?? undefined
      return merged
    })
  }

  update(id: string, toolId: unknown, patch: unknown): void {
    if (typeof toolId !== 'string' || !patch || typeof patch !== 'object') return
    if (!this.plugin(id)?.manifest.tools?.some(tool => tool.id === toolId)) return
    const input = patch as { view?: unknown; notice?: unknown }
    if (input.view !== undefined && !isToolView(input.view)) return
    const current = this.live.get(id) ?? {}
    const next: LiveTool = { ...current[toolId], updatedAt: Date.now() }
    if (input.view !== undefined) next.view = input.view as PluginToolView
    if (input.notice !== undefined) next.notice = input.notice === null ? null : String(input.notice).slice(0, 500)
    current[toolId] = next
    this.live.set(id, current)
    this.changed(id, this.list(id))
  }

  clear(id: string): void {
    this.live.delete(id)
    this.changed(id, this.list(id))
  }
}
