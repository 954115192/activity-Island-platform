import { screen, type BrowserWindow } from 'electron'
import type { IslandState } from './island-state'
import type { IntentArbiter } from './intent-arbiter'
import type { IslandSettings } from '../settings/store'
import type { createWindowLayer } from '../window/window-layer'
import { SMALL_DEFAULT } from './geometry'

interface PointerOptions {
  readonly window: BrowserWindow | null
  readonly layer: Pick<ReturnType<typeof createWindowLayer>, 'hidden' | 'contains'>
  readonly transferOpen: boolean
  readonly dragging: boolean
  readonly alertActive: boolean
  settings: IslandSettings
  state: IslandState
  arbiter: IntentArbiter
  cursor?(): Electron.Point
  send(channel: string, payload?: unknown): void
  cancelCollapse(): void
  scheduleTransientCollapse(): void
  showCompact(hovered?: boolean): Promise<void>
  showIdle(hovered?: boolean): Promise<void>
}

/** Owns the native hit region, hover state and pointer-driven transition policy. */
export function createIslandPointer(options: PointerOptions) {
  let disposed = false
  let hitInside = false
  let idleHover = false
  let compactHover = false
  let openGraceUntil = 0
  let hitRegion = { x: 0, y: 0, width: SMALL_DEFAULT.width, height: SMALL_DEFAULT.height, radius: 23, interactive: true }

  function roundedRectContains(x: number, y: number): boolean {
    if (!options.window || options.window.isDestroyed() || !hitRegion.interactive) return false
    const bounds = options.window.getBounds()
    const localX = x - bounds.x
    const localY = y - bounds.y
    if (localX < hitRegion.x || localX > hitRegion.x + hitRegion.width || localY < hitRegion.y || localY > hitRegion.y + hitRegion.height) return false
    const radius = Math.min(hitRegion.radius, hitRegion.width / 2, hitRegion.height / 2)
    if (radius <= 0) return true
    const left = localX < hitRegion.x + radius
    const right = localX > hitRegion.x + hitRegion.width - radius
    const top = localY < hitRegion.y + radius
    const bottom = localY > hitRegion.y + hitRegion.height - radius
    if (!(left || right) || !(top || bottom)) return true
    const cx = left ? hitRegion.x + radius : hitRegion.x + hitRegion.width - radius
    const cy = top ? hitRegion.y + radius : hitRegion.y + hitRegion.height - radius
    return Math.hypot(localX - cx, localY - cy) <= radius
  }

  function updateHitTest(): void {
    if (disposed) return
    if (!options.window || options.window.isDestroyed() || options.layer.hidden) return
    const point = (options.cursor?.() ?? screen.getCursorScreenPoint())
    // Prefer the utility window only where it actually overlaps the cursor.
    // The rest of the island remains clickable and stays above ordinary apps.
    if (options.layer.contains(point)) {
      if (hitInside) {
        hitInside = false
        options.state.patch({ pointerInside: false })
        options.send('host:cursor', false)
      }
      options.window.setIgnoreMouseEvents(true, { forward: true })
      return
    }
    const inside = roundedRectContains(point.x, point.y)
    if (inside === hitInside) return
    hitInside = inside
    options.state.patch({ pointerInside: inside })
    options.window.setIgnoreMouseEvents(!inside, { forward: true })
    options.send('host:cursor', inside)
    // 传输面板是用户任务；移出、拖动和普通通知均不能把接收确认或文件草稿自动收走。
    if (options.transferOpen || options.dragging) return
    if (inside) {
      options.cancelCollapse()
      const state = options.state.value
      if (state.mode === 'expanded' || state.mode === 'detail' || state.mode === 'custom') options.state.patch({ sticky: false })
      else if (state.mode === 'idle' && !idleHover) {
        idleHover = true
        // 收起模式：从触发条展开时直接把插件一起带出来。idle 是空胶囊（插件视图
        // 被 1x1 裁剪窗藏住、但保持渲染），只有 compact 才把裁剪窗放开。
        if (options.settings.idleMode === 'collapsed') { compactHover = true; void options.showCompact(true) }
        else void options.showIdle(true)
      } else if (state.mode === 'compact' && !compactHover) {
        compactHover = true
        void options.showCompact(true)
      }
      return
    }

    const state = options.state.value
    if (state.mode !== 'compact' && state.mode !== 'idle') options.send('host:pointer-outside')
    if (state.mode === 'expanded' || state.mode === 'detail') {
      if (Date.now() < openGraceUntil) {
        options.state.patch({ sticky: true })
      } else if (!state.sticky) {
        // releaseFocus() calls the host's single showRest() transition. A
        // second options.showCompact() here used to race it and produce mini -> hover
        // sized, which looked like the island shrank past its target and came
        // back.
        options.arbiter.releaseFocus('preempted')
      }
    } else if (state.mode === 'custom') {
      void options.showCompact()
    } else if (state.mode === 'idle') {
      if (idleHover) void options.showIdle(false)
    } else if (state.mode === 'compact') {
      // 收起模式：鼠标一离开就缩回触发条；浮动模式仍留 3 秒窗口给插件活动。
      // 提醒显示期间不收起——它的生命周期由 ttl 决定。
      if (options.alertActive) return
      if (options.settings.idleMode === 'collapsed' && !state.sticky) {
        compactHover = false
        void options.showIdle()
      } else {
        if (compactHover) {
          compactHover = false
          void options.showCompact(false)
        }
        options.scheduleTransientCollapse()
      }
    }
  }

  /**
   * Hit region for an island stage. 收起模式下小岛是从贴顶的 64x8 触发条里长出来的，
   * 所以热区必须把那条窄带一起包含进去：否则鼠标还停在触发条上（y < islandTop）时
   * 会被判成"已移出"，展开态每 40ms 就被打回收起态，看起来就是来回抖。
   */
  function stageHitRegion(stage: { x: number; y: number; width: number; height: number }, radius: number): { x: number; y: number; width: number; height: number; radius: number } {
    if (options.settings.idleMode !== 'collapsed') return { x: stage.x, y: stage.y, width: stage.width, height: stage.height, radius }
    return { x: stage.x, y: 0, width: stage.width, height: stage.y + stage.height, radius: 4 }
  }

  function setHitRegion(region: { x: number; y: number; width: number; height: number; radius?: number; interactive?: boolean }, refresh = true): void {
    if (![region.x, region.y, region.width, region.height].every(Number.isFinite)) return
    hitRegion = {
      x: Math.max(0, region.x), y: Math.max(0, region.y),
      width: Math.max(0, region.width), height: Math.max(0, region.height),
      radius: Math.max(0, region.radius ?? 0), interactive: region.interactive !== false,
    }
    // A transition changes the state before the native/renderer layout has
    // committed. Refreshing synchronously here can re-enter updateHitTest while
    // the cursor is already outside and start a second collapse in the same
    // turn. The caller refreshes after the new layout is submitted.
    if (refresh) updateHitTest()
  }

  return {
    update: updateHitTest,
    setRegion: setHitRegion,
    stageRegion: stageHitRegion,
    contains: roundedRectContains,
    get inside() { return hitInside },
    get idleHover() { return idleHover },
    get compactHover() { return compactHover },
    setHover(mode: 'idle' | 'compact', hovered: boolean) {
      if (mode === 'idle') idleHover = hovered
      else compactHover = hovered
    },
    holdOpen(milliseconds: number) { openGraceUntil = Date.now() + milliseconds },
    recheck() {
      if (disposed) return
      const point = options.cursor?.() ?? screen.getCursorScreenPoint()
      hitInside = !roundedRectContains(point.x, point.y)
      updateHitTest()
    },
    blur() {
      hitInside = false
      options.state.patch({ pointerInside: false })
      options.send('host:blur')
      const state = options.state.value
      if ((state.mode === 'expanded' || state.mode === 'detail') && state.sticky) {
        options.state.patch({ sticky: false })
        options.arbiter.releaseFocus('preempted')
      }
    },
    dispose() { disposed = true },
  }
}
