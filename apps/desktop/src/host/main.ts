import './style.css'

type Layout = {
  mode: string
  pluginMode?: 'small' | 'medium' | 'large'
  separators: number[]
  collapsed?: boolean
  clipPlugins?: boolean
  showClock?: boolean
  overflow?: number
  chipX?: number | null
  /** Width of the content coordinate system inside the animated shell. */
  contentWidth?: number
  width: number
  height: number
  top: number
}

const root = document.querySelector<HTMLDivElement>('#host-root')!
root.innerHTML = '<div class="host-surface"><div class="island-shell" data-mode="idle" data-collapsed="false"><time class="idle-clock" aria-label="当前时间"></time><div class="island-separators"></div><button class="island-overflow" type="button" hidden></button></div></div>'

const shell = root.querySelector<HTMLDivElement>('.island-shell')!
const clock = root.querySelector<HTMLElement>('.idle-clock')!
const separators = root.querySelector<HTMLDivElement>('.island-separators')!
const overflowChip = root.querySelector<HTMLButtonElement>('.island-overflow')!
const host = (window as unknown as { dynamicIslandHost?: { onLayout?: (listener: (layout: Layout) => void) => () => void
    onAlert?: (listener: (alert: { level: 'info' | 'warn' | 'critical'; color?: string | null } | null) => void) => () => void
    sendAnimationFrame?: (frame: { width: number; height: number; top: number; radius: number }) => void
    openSettings?: (tab?: string) => void } }).dynamicIslandHost

// 临时消息的档位（info/warn/critical）与可选自定义颜色，由宿主在提醒上岛/退场时单独推送。
// 不走 sendLayout：那条通道带着 12 个位置参数和弹簧动画语义，塞进去会牵动动效路径。
let alertLevel: 'info' | 'warn' | 'critical' | null = null
let alertColor: string | null = null
// 颜色只认十六进制——宿主已校验过，这里再挡一层，保证落到 box-shadow 的只有安全的字面量
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

const initial: Layout = { mode: 'idle', separators: [], width: 134, height: 38, top: 8, showClock: false }
let current = { width: initial.width, height: initial.height, top: initial.top }
let target = { width: initial.width, height: initial.height, top: initial.top }
let previousTarget = { ...target }
let velocity = { width: 0, height: 0 }
let direction: 'expand' | 'collapse' = 'expand'
// Largest axis change of the transition currently being animated. A spring
// overshoots by a fixed *fraction* of the size change, so this is what decides
// whether an overshoot is actually visible.
let span = 0
let frame = 0
let last = performance.now()
let startAt = last
let layoutState = initial
let hasReceivedLayout = false
let lastSeparators: number[] = []

function renderShell() {
  shell.dataset.mode = layoutState.mode
  shell.dataset.collapsed = String(layoutState.collapsed ?? false)
  if (alertLevel) {
    shell.dataset.alert = alertLevel
    if (alertColor) {
      // 自定义色：描边用原色，光晕用同色的 38% 透明（color-mix 保持颜色跟随）
      shell.style.setProperty('--alert-ring', alertColor)
      shell.style.setProperty('--alert-glow', `color-mix(in srgb, ${alertColor} 38%, transparent)`)
    } else {
      shell.style.removeProperty('--alert-ring')
      shell.style.removeProperty('--alert-glow')
    }
  } else {
    delete shell.dataset.alert
    shell.style.removeProperty('--alert-ring')
    shell.style.removeProperty('--alert-glow')
  }
  shell.hidden = false
  // Keep sub-pixel spring values. Rounding here removes the old island's
  // characteristic tiny overshoot, making hover look like a plain resize.
  shell.style.width = `${Math.max(1, current.width).toFixed(2)}px`
  shell.style.height = `${Math.max(1, current.height).toFixed(2)}px`
  shell.style.top = `${Math.round(current.top)}px`
  const baseRadius = layoutState.collapsed ? 4 : layoutState.mode === 'idle' ? 19 : 28
  if (layoutState.clipPlugins) host?.sendAnimationFrame?.({ width: current.width, height: current.height, top: current.top, radius: baseRadius })
  clock.hidden = true
  // 插件原生视图按目标内容宽度居中，当前外壳只是它的裁剪窗；
  // 因此分隔线/溢出徽标也必须使用同一个实时中心偏移。
  const contentOffset = Math.round((current.width - (layoutState.contentWidth ?? layoutState.width)) / 2)
  if (layoutState.separators.length !== lastSeparators.length || layoutState.separators.some((position, index) => position !== lastSeparators[index])) {
    lastSeparators = [...layoutState.separators]
    separators.replaceChildren(...layoutState.separators.map(() => document.createElement('i')))
  }
  layoutState.separators.forEach((position, index) => {
    const separator = separators.children[index] as HTMLElement | undefined
    if (separator) separator.style.left = `${position + contentOffset}px`
  })
  // 溢出徽标：mini 条放不下时宿主自己画一段 `+N`，点开设置里的插件页去调整。
  const overflow = layoutState.mode === 'compact' ? (layoutState.overflow ?? 0) : 0
  if (overflow > 0 && layoutState.chipX != null) {
    overflowChip.hidden = false
    overflowChip.textContent = `+${overflow}`
    overflowChip.style.left = `${layoutState.chipX + contentOffset}px`
    overflowChip.title = `还有 ${overflow} 个插件未显示，点击打开插件设置`
  } else {
    overflowChip.hidden = true
  }
}

overflowChip.addEventListener('click', () => { host?.openSettings?.('plugins') })

/** Expand at or below this many CSS px of change counts as a hover-sized pop. */
const MICRO_SPAN = 40

function springParams() {
  if (direction !== 'expand') {
    // 收起要和展开"同一种起步手感"，但**绝对不能冲过最终尺寸**：
    // 首帧位移 = 行程 × (k/m) × dt²。展开那档是 270，之前收起是 380/0.8 = 475，
    // 同样行程下首帧要窜 26px（展开只有 15px），看着就是"猛一下"，所以对齐到 270。
    // 收起也保留一次很小的回弹，让到达 mini 前后的手感和展开一致；
    // 阻尼仍明显高于展开档，过冲被限制在很小范围内，避免重新出现"缩进岛里"。
    return { width: { stiffness: 270, damping: 25, mass: 1, delay: 0 }, height: { stiffness: 250, damping: 25, mass: 1, delay: 0 } }
  }
  // The island's hover pop is only ~10px wide, so the 7% overshoot of the big
  // expand spring was under a pixel there and hover read as a plain resize.
  // Hover-sized expands use a lighter, faster spring (~35% overshoot, peak
  // ~0.16s) so every expand - hover included - swells past its target and
  // settles back with the same bounce.
  return span <= MICRO_SPAN
    ? { width: { stiffness: 420, damping: 12, mass: 1, delay: 0 }, height: { stiffness: 420, damping: 12, mass: 0.9, delay: 0.012 } }
    : { width: { stiffness: 400, damping: 26, mass: 1, delay: 0 }, height: { stiffness: 650, damping: 38, mass: 1, delay: 0 } }
}

function stopAnimation() {
  if (frame) cancelAnimationFrame(frame)
  frame = 0
}

function tick(now: number) {
  const dt = Math.min((now - last) / 1000, 0.032)
  last = now
  const elapsed = (now - startAt) / 1000
  const params = springParams()
  for (const axis of ['width', 'height'] as const) {
    const p = params[axis]
    if (elapsed < p.delay) continue
    const delta = target[axis] - current[axis]
    const acceleration = (delta * p.stiffness - velocity[axis] * p.damping) / p.mass
    velocity[axis] += acceleration * dt
    current[axis] += velocity[axis] * dt
    if (Math.abs(delta) < 0.2 && Math.abs(velocity[axis]) < 0.2) {
      current[axis] = target[axis]
      velocity[axis] = 0
    }
  }
  renderShell()
  const settled = Math.abs(current.width - target.width) < 0.2 && Math.abs(current.height - target.height) < 0.2 && Math.abs(velocity.width) < 0.2 && Math.abs(velocity.height) < 0.2
  if (settled) { frame = 0; return }
  frame = requestAnimationFrame(tick)
}

function applyLayout(next: Layout) {
  if (!hasReceivedLayout) {
    hasReceivedLayout = true
    current = { width: next.width, height: next.height, top: next.top }
    target = { ...current }
    previousTarget = { ...current }
  } else {
    previousTarget = { ...target }
    target = { width: next.width, height: next.height, top: next.top }
  }
  current.top = target.top
  layoutState = next
  const prevArea = previousTarget.width * previousTarget.height
  const nextArea = target.width * target.height
  const nextDirection: 'expand' | 'collapse' = nextArea >= prevArea ? 'expand' : 'collapse'
  span = Math.max(Math.abs(target.width - previousTarget.width), Math.abs(target.height - previousTarget.height))
  if (nextDirection === direction && frame) {
    // 同向的连续布局（收起经常是"中岛→mini 条→待机横条"两段）要接着当前速度走，
    // 否则每一段都从静止重新起步，看起来就是一顿一顿地弹。
    // 但速度不能超过这次行程自然能达到的上限，免得带着上一段的冲劲冲过目标。
    direction = nextDirection
    const params = springParams()
    for (const axis of ['width', 'height'] as const) {
      const p = params[axis]
      const limit = Math.abs(target[axis] - current[axis]) * Math.sqrt(p.stiffness / p.mass)
      velocity[axis] = Math.max(-limit, Math.min(limit, velocity[axis]))
    }
  } else {
    // 换向（展开↔收起）就别带着反方向的速度，不然会先"顶"一下再走。
    direction = nextDirection
    velocity = { width: 0, height: 0 }
  }
  stopAnimation()
  startAt = performance.now()
  last = startAt
  renderShell()
  frame = requestAnimationFrame(tick)
}

applyLayout(initial)
host?.onLayout?.(applyLayout)
host?.onAlert?.(next => {
  alertLevel = next?.level ?? null
  const color = next?.color
  alertColor = color && HEX_COLOR.test(color) ? color : null
  renderShell()
})


