import type { BrowserWindow } from 'electron'
import { screen } from 'electron'

export interface Bounds { x: number; y: number; width: number; height: number }

export class IslandWindowManager {
  private animationToken = 0

  constructor(private readonly window: BrowserWindow) {}

  center(width: number, height: number): Bounds {
    const workArea = screen.getPrimaryDisplay().workArea
    return { x: Math.round(workArea.x + (workArea.width - width) / 2), y: Math.round(workArea.y + 8), width, height }
  }

  getBounds(): Bounds { return this.window.getBounds() }

  async animateTo(target: Bounds, options: { durationMs?: number } = {}): Promise<void> {
    const token = ++this.animationToken
    const from = this.window.getBounds()
    const duration = options.durationMs ?? 360
    if (from.x === target.x && from.y === target.y && from.width === target.width && from.height === target.height) return
    const startedAt = Date.now()
    await new Promise<void>(resolve => {
      const tick = () => {
        if (token !== this.animationToken || this.window.isDestroyed()) { resolve(); return }
        const elapsed = Date.now() - startedAt
        const raw = Math.min(1, elapsed / duration)
        // Host-only spring-like easing. Plugin pages never change these bounds.
        const eased = raw === 1 ? 1 : 1 - Math.pow(1 - raw, 4) * Math.cos(raw * Math.PI * 1.25)
        this.window.setBounds({
          x: Math.round(from.x + (target.x - from.x) * eased),
          y: Math.round(from.y + (target.y - from.y) * eased),
          width: Math.round(from.width + (target.width - from.width) * eased),
          height: Math.round(from.height + (target.height - from.height) * eased),
        }, false)
        if (raw >= 1) { resolve(); return }
        setTimeout(tick, 16)
      }
      tick()
    })
  }

  cancelAnimation(): void { this.animationToken++ }
}
