// 灵动岛外壳动画的量化验收：用真实渲染层 + 虚拟时钟（自己步进 rAF）跑展开/收起，
// 采样外壳尺寸轨迹。关注：过冲幅度（"用力过猛"）、来回弹几次（"弹好几次"）、稳定时间（"猛不猛"）。
// 用虚拟时钟是因为隐藏窗口会把 rAF 降频，真实时间根本跑不动动画。
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'
const { app, BrowserWindow } = require('electron')

const REPO = path.join(__dirname, '..', '..')
const SANDBOX = path.join(os.tmpdir(), 'island-anim-e2e')

fs.rmSync(SANDBOX, { recursive: true, force: true })
fs.mkdirSync(SANDBOX, { recursive: true })

// 渲染层在加载时就读 window.dynamicIslandHost，所以只能用 preload 先把桩塞进去。
// 同时把 rAF / performance.now 换成可手动步进的虚拟时钟。
const preload = path.join(SANDBOX, 'anim-stub.js')
fs.writeFileSync(preload, `
  // rAF 必须跟真实语义一致：cancelAnimationFrame 要真的把待执行的回调摘掉。
  // （之前把它写成空函数，导致被打断的弹簧循环继续步进，动画看起来快了 10 倍。）
  let queue = new Map()
  let handle = 0
  let clock = 0
  const STEP = 1000 / 60
  window.requestAnimationFrame = (fn) => { handle += 1; queue.set(handle, fn); return handle }
  window.cancelAnimationFrame = (id) => { queue.delete(id) }
  try { performance.now = () => clock } catch (e) { /* 忽略 */ }
  window.__advance = (frames) => {
    for (let i = 0; i < frames; i += 1) {
      clock += STEP
      const pending = [...queue.values()]
      queue.clear()
      for (const fn of pending) fn(clock)
    }
  }
  window.__frames = []
  window.dynamicIslandHost = {
    onLayout: (listener) => { window.__apply = listener; return () => { window.__apply = null } },
    sendAnimationFrame: (frame) => { window.__frames.push({ ...frame, t: clock }) },
    openSettings: () => {},
  }
`)

const results = []
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: String(detail ?? '') })

const COMPACT = { mode: 'compact', pluginMode: 'small', separators: [], collapsed: false, clipPlugins: true, showClock: false, width: 200, height: 44, top: 8 }
const EXPANDED = { mode: 'expanded', pluginMode: 'medium', separators: [], collapsed: false, clipPlugins: true, showClock: false, width: 400, height: 160, top: 8 }
const IDLE_STRIP = { mode: 'idle', separators: [], collapsed: true, clipPlugins: false, showClock: false, width: 64, height: 8, top: 0 }

/** 过冲、越界回弹次数、稳定时间。 */
function analyse(samples, target) {
  const values = samples.map(sample => sample[1])
  const startValue = values[0]
  const travel = target - startValue
  const peak = travel >= 0 ? Math.max(...values) : Math.min(...values)
  const overshoot = travel === 0 ? 0 : Math.max(0, (peak - target) / travel)
  // "回弹"= 穿过目标线又穿回来的次数（去程不算）：单调收敛 = 0，过一次再回来 = 1。
  let crossings = 0
  let previousSign = Math.sign(values[0] - target)
  for (const value of values) {
    const sign = Math.sign(value - target)
    if (sign === 0) continue
    if (previousSign !== 0 && sign !== previousSign) crossings += 1
    previousSign = sign
  }
  const bounces = Math.round(crossings / 2)
  let settle = samples[samples.length - 1][0]
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    if (Math.abs(samples[index][1] - target) > 0.5) { settle = samples[Math.min(index + 1, samples.length - 1)][0]; break }
    settle = samples[index][0]
  }
  return { startValue, peak, overshoot, bounces, settle }
}

/** 逐帧步长：第一帧的"踹一脚"有多大、最大单帧位移多少（这两个最影响"猛不猛"）。 */
function steps(samples) {
  const deltas = []
  for (let index = 1; index < samples.length; index += 1) deltas.push(Math.abs(samples[index][1] - samples[index - 1][1]))
  return { first: deltas[0] ?? 0, max: deltas.length ? Math.max(...deltas) : 0 }
}

async function main() {
  const win = new BrowserWindow({
    width: 900, height: 600, show: false, paintWhenInitiallyHidden: true,
    webPreferences: { preload, contextIsolation: false, nodeIntegration: false, sandbox: false, backgroundThrottling: false },
  })
  await win.loadFile(path.join(REPO, 'dist', 'index.html'))
  const js = (code) => win.webContents.executeJavaScript(code)
  check('渲染层加载出外壳', await js("!!document.querySelector('#host-root .island-shell')"))

  /** 施加一个布局，然后步进虚拟时钟并采样外壳宽度。 */
  const run = (layout, frames = 120) => js(`(() => {
    const shell = document.querySelector('#host-root .island-shell')
    window.__apply(${JSON.stringify(layout)})
    const samples = []
    for (let index = 0; index < ${frames}; index += 1) {
      samples.push([Math.round(index * 16.67), parseFloat(getComputedStyle(shell).width), parseFloat(getComputedStyle(shell).height)])
      window.__advance(1)
    }
    return samples
  })()`)

  await run(COMPACT, 120)                      // 先落到 mini 条
  const expandSamples = await run(EXPANDED)
  const expand = analyse(expandSamples, 400)
  const collapseSamples = await run(COMPACT)
  const collapse = analyse(collapseSamples, 200)
  await run(COMPACT, 120)
  const collapse2Samples = await run(IDLE_STRIP)
  const collapse2 = analyse(collapse2Samples, 64)

  /** 连续多次布局（真实收起就是"中岛→mini 条→待机横条"两段），看整段的观感。 */
  const sequence = (steps, frames = 150) => js(`(() => {
    const shell = document.querySelector('#host-root .island-shell')
    const plan = ${JSON.stringify(steps)}
    const samples = []
    for (let index = 0; index < ${frames}; index += 1) {
      const step = plan.find(item => item.at === index)
      if (step) window.__apply(step.layout)
      samples.push([Math.round(index * 16.67), parseFloat(getComputedStyle(shell).width)])
      window.__advance(1)
    }
    return samples
  })()`)

  /** 局部极值个数 = 肉眼看出来的"弹了几下"。 */
  const extrema = (samples) => {
    let count = 0
    for (let index = 1; index < samples.length - 1; index += 1) {
      const before = samples[index - 1][1]
      const value = samples[index][1]
      const after = samples[index + 1][1]
      if ((value > before && value > after) || (value < before && value < after)) count += 1
    }
    return count
  }

  await run(EXPANDED, 180)
  const twoStage = await sequence([{ at: 0, layout: COMPACT }, { at: 24, layout: IDLE_STRIP }])
  await run(EXPANDED, 180)
  const oneStage = await sequence([{ at: 0, layout: COMPACT }])
  // 两段叠在一起（第一段还没停就来了第二段）：最容易看出"弹好几次"
  await run(EXPANDED, 180)
  const overlap = await sequence([{ at: 0, layout: COMPACT }, { at: 13, layout: IDLE_STRIP }])

  const line = (label, m) => `${label}: ${m.startValue.toFixed(1)} → 峰值 ${m.peak.toFixed(1)}，过冲 ${(m.overshoot * 100).toFixed(1)}%，回弹 ${m.bounces} 次，稳定 ${Math.round(m.settle)}ms`
  console.log('=== 灵动岛外壳动画（虚拟时钟，60fps）===')
  console.log(line('展开 200→400', expand))
  console.log(line('收起 400→200', collapse))
  console.log(line('收起 200→64 ', collapse2))
  const eSteps = steps(expandSamples)
  const cSteps = steps(collapseSamples)
  console.log(`逐帧：展开首帧 ${eSteps.first.toFixed(1)}px / 峰值 ${eSteps.max.toFixed(1)}px；收起首帧 ${cSteps.first.toFixed(1)}px / 峰值 ${cSteps.max.toFixed(1)}px`)
  console.log('展开前 8 帧:', expandSamples.slice(0, 8).map(s => s[1].toFixed(0)).join(' '))
  console.log('收起前 8 帧:', collapseSamples.slice(0, 8).map(s => s[1].toFixed(0)).join(' '))
  console.log(`两段收起（中岛→mini→横条）：极值 ${extrema(twoStage)} 个，最终 ${twoStage[twoStage.length - 1][1].toFixed(1)}，用时 ${Math.round(twoStage[twoStage.length - 1][0])}ms`)
  console.log(`一段收起（中岛→mini）    ：极值 ${extrema(oneStage)} 个，最终 ${oneStage[oneStage.length - 1][1].toFixed(1)}，用时 ${Math.round(oneStage[oneStage.length - 1][0])}ms`)
  console.log(`交叠两段收起             ：极值 ${extrema(overlap)} 个，最终 ${overlap[overlap.length - 1][1].toFixed(1)}`)
  console.log('交叠两段轨迹:', overlap.filter((_, index) => index % 3 === 0).map(sample => Math.round(sample[1])).join(' '))
  console.log('两段收起轨迹:', twoStage.filter((_, index) => index % 4 === 0).map(sample => Math.round(sample[1])).join(' '))

  check('展开有弹性（过冲 2%~12%）', expand.overshoot > 0.02 && expand.overshoot < 0.12, `${(expand.overshoot * 100).toFixed(1)}%`)
  check('展开有回弹感（≥1 次）', expand.bounces >= 1, `${expand.bounces} 次`)
  check('收起只做轻微回弹（过冲 ≤1%，不会缩进岛里）', collapse.overshoot <= 0.01, `${(collapse.overshoot * 100).toFixed(2)}%`)
  check('收起最多回弹一次', collapse.bounces <= 1, `${collapse.bounces} 次`)
  check('收起干净利落（≤450ms）', collapse.settle <= 450, `${Math.round(collapse.settle)}ms`)
  check('收起与展开用时接近（差 ≤150ms）', Math.abs(collapse.settle - expand.settle) <= 150, `${Math.round(collapse.settle)}ms vs ${Math.round(expand.settle)}ms`)
  check('第二段收起同样轻微回弹（不缩过横条范围）', collapse2.overshoot <= 0.01 && collapse2.bounces <= 1, `${(collapse2.overshoot * 100).toFixed(2)}% / ${collapse2.bounces} 次`)
  check('展开与收起差异有界（过冲差 ≤ 12 个百分点）', Math.abs(expand.overshoot - collapse.overshoot) <= 0.12, `${(expand.overshoot * 100).toFixed(1)}% vs ${(collapse.overshoot * 100).toFixed(1)}%`)
  check('两段收起不在中途卡顿重来（极值 ≤ 3）', extrema(twoStage) <= 3, `${extrema(twoStage)} 个极值`)
  check('两段收起的最终尺寸正确', Math.abs(twoStage[twoStage.length - 1][1] - 64) < 1, twoStage[twoStage.length - 1][1].toFixed(1))
  check('收起的起步不比展开更冲（首帧位移 ≤ 展开 × 1.2）', steps(collapseSamples).first <= steps(expandSamples).first * 1.2, `收起 ${steps(collapseSamples).first.toFixed(1)}px vs 展开 ${steps(expandSamples).first.toFixed(1)}px`)
  check('收起的峰值速度不比展开高', steps(collapseSamples).max <= steps(expandSamples).max, `收起 ${steps(collapseSamples).max.toFixed(1)}px/帧 vs 展开 ${steps(expandSamples).max.toFixed(1)}px/帧`)
  check('收起全程只允许轻微越过目标（逐帧不低于目标 1%）', collapseSamples.every(sample => sample[1] >= 200 * 0.99), `最小 ${Math.min(...collapseSamples.map(s => s[1])).toFixed(2)}px / 目标 200px`)
  check('收起时高度也只允许轻微越过 mini 条（逐帧不低于目标 1%）', collapseSamples.every(sample => sample[2] >= 44 * 0.99), `最小 ${Math.min(...collapseSamples.map(s => s[2])).toFixed(2)}px / 目标 44px`)
  check('交叠两段收起也不会来回弹（极值 ≤ 4）', extrema(overlap) <= 4, `${extrema(overlap)} 个极值`)
  check('交叠两段收起最终落到横条尺寸', Math.abs(overlap[overlap.length - 1][1] - 64) < 2, overlap[overlap.length - 1][1].toFixed(1))

  let failed = 0
  for (const item of results) { if (!item.ok) failed += 1; console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.detail ? `   [${item.detail}]` : ''}`) }
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  win.destroy()
  app.exit(failed ? 1 : 0)
}

app.whenReady().then(main).catch((error) => { console.error(error); app.exit(1) })
