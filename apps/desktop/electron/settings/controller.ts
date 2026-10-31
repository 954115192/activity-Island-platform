import type { SettingsStore, IslandSettings } from './store'
import { pruneOrder } from '../plugins/plugin-order'

export type SettingsLayoutChange = 'idle-mode' | 'top' | 'scale' | 'order'
interface SettingsEffects {
  pluginIds(): string[]
  applyLayout(change: SettingsLayoutChange): Promise<void>
  changed(settings: IslandSettings): void
  launchAtLogin(enabled: boolean): { ok: boolean; enabled: boolean; error?: string }
}

/** Validates settings changes, persists them, then applies their visible effects. */
export class SettingsController {
  constructor(private readonly store: SettingsStore, private readonly effects: SettingsEffects) {}

  setCheckUpdates(enabled: boolean) {
    this.store.value.checkUpdatesOnLaunch = enabled === true
    this.commit()
    return { ok: true, enabled: this.store.value.checkUpdatesOnLaunch }
  }

  setLaunchAtLogin(enabled: boolean) {
    const result = this.effects.launchAtLogin(enabled === true)
    if (!result.ok) return result
    this.store.value.launchAtLogin = result.enabled
    this.commit()
    return result
  }

  async setIdleMode(mode: 'float' | 'collapsed') {
    if (mode !== 'float' && mode !== 'collapsed') throw new Error('unknown-idle-mode')
    this.store.value.idleMode = mode
    return this.commitLayout('idle-mode')
  }

  async setTop(value: number) {
    const top = Number(value)
    this.store.value.islandTop = Number.isFinite(top) ? Math.max(0, Math.min(200, Math.round(top))) : 8
    return this.commitLayout('top')
  }

  async setScale(value: number) {
    const scale = Number(value)
    this.store.value.miniScale = Number.isFinite(scale) ? Math.max(0.5, Math.min(1.5, Math.round(scale * 20) / 20)) : 1
    return this.commitLayout('scale')
  }

  async setPluginOrder(ids: string[]) {
    this.store.value.pluginOrder = pruneOrder(Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : [], this.effects.pluginIds())
    return this.commitLayout('order')
  }

  private commit(): void {
    this.store.save()
    this.effects.changed(this.store.snapshot())
  }

  private async commitLayout(change: SettingsLayoutChange): Promise<IslandSettings> {
    this.store.save()
    await this.effects.applyLayout(change)
    const settings = this.store.snapshot()
    this.effects.changed(settings)
    return settings
  }
}
