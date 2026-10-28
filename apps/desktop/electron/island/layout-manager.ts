import { screen, type BrowserWindow } from 'electron'

export interface Bounds { x: number; y: number; width: number; height: number }

/** Window-only layout facade. Plugin pages never own these bounds. */
export class IslandLayoutManager {
  private animationToken = 0
  constructor(private readonly window: BrowserWindow) {}
  center(width: number, height: number, top = 8): Bounds {
    const workArea = screen.getPrimaryDisplay().workArea
    return { x: Math.round(workArea.x + (workArea.width - width) / 2), y: Math.round(workArea.y + top), width, height }
  }
  apply(bounds: Bounds): void { this.window.setBounds(bounds, false) }
  // The old project keeps the Electron window fixed and animates the inner
  // island in the renderer. Keep this API as a no-op-compatible facade for
  // callers that still await a transition.
  animateTo(_bounds: Bounds, _durationMs = 420): Promise<void> { return Promise.resolve() }
  cancel(): void { this.animationToken++ }
}
