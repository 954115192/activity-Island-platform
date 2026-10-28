import type { IslandMode } from '../plugins/types'

export interface IslandStateSnapshot {
  mode: IslandMode
  activePluginId: string | null
  visiblePluginIds: string[]
  pointerInside: boolean
  sticky: boolean
  idleMode: 'float' | 'collapsed'
  miniScale: number
}

export class IslandState {
  private snapshot: IslandStateSnapshot = {
    mode: 'idle', activePluginId: null, visiblePluginIds: [], pointerInside: false,
    sticky: false, idleMode: 'float', miniScale: 1,
  }
  get value(): IslandStateSnapshot { return { ...this.snapshot } }
  patch(patch: Partial<IslandStateSnapshot>): IslandStateSnapshot {
    this.snapshot = { ...this.snapshot, ...patch, visiblePluginIds: patch.visiblePluginIds ?? this.snapshot.visiblePluginIds }
    return this.value
  }
}
