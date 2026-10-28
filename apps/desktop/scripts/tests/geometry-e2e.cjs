// 收起（中岛/大岛 → mini 条）的原生几何验收。
//
// 用真实宿主 + 真实插件，把宿主渲染层的 rAF 换成手动步进的虚拟时钟，
// 于是可以逐帧、确定性地看到三件事：
//   1) 胶囊（外壳）收到了哪一帧；
//   2) viewport（原生裁剪面）有没有比胶囊大 —— 大了内容就会露在胶囊外面；
//   3) 插件什么时候从中岛内容切成 mini 内容 —— 切早了就是"内容先缩进岛里"。
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'
const { app, BrowserWindow, View, WebContentsView, webContents } = require('electron')

const REPO = path.join(__dirname, '..', '..')
const SANDBOX = path.join(os.tmpdir(), 'island-collapse-geom')
const PROFILE = path.join(SANDBOX, 'profile')
const USER_PLUGINS = path.join(PROFILE, 'plugins')
const PLUGIN_ID = 'geom-probe'
const SMALL = { width: 150, height: 44 }
const MEDIUM = { width: 420, height: 200 }

fs.rmSync(SANDBOX, { recursive: true, force: true })
fs.mkdirSync(USER_PLUGINS, { recursive: true })
fs.mkdirSync(PROFILE, { recursive: true })
app.setPath('userData', PROFILE)
// Keep the mini island visible after the collapse so this test measures only
// the medium/large -> mini transition, not the separate collapsed idle strip.
fs.writeFileSync(path.join(PROFILE, 'settings.json'), JSON.stringify({ idleMode: 'float', islandTop: 5, miniScale: 1, pluginOrder: [] }))

// 原生几何轨迹：viewport（父 View）与插件视图（WebContentsView）
const geometry = []
function patch(proto, kind) {
  const real = proto.setBounds
  proto.setBounds = function patched(bounds) {
    try { geometry.push({ kind, bounds: { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) } }) } catch { /* 忽略 */ }
    return real.call(this, bounds)
  }
}
patch(View.prototype, 'viewport')
patch(WebContentsView.prototype, 'plugin')

const dir = path.join(SANDBOX, 'dev', PLUGIN_ID)
fs.mkdirSync(path.join(dir, 'dist'), { recursive: true })
fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
  id: PLUGIN_ID, name: '几何探针', version: '0.1.0', runtime: 'web-app', priority: 50, entry: 'dist/index.html', resident: true,
  small: { enabled: true, ...SMALL }, medium: MEDIUM, large: { width: 640, height: 340 },
}, null, 2))
fs.writeFileSync(path.join(dir, 'dist', 'index.html'),
  `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#101319;color:#9fe8c8;font:600 18px/1.4 sans-serif}#app{width:100%;height:100%;display:flex;align-items:center;justify-content:center}</style></head><body><div id="app">几何探针</div><script src="app.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'dist', 'app.js'), `window.dynamicIsland.ui.onModeChange(() => {})`)

for (const method of ['show', 'showInactive', 'focus']) BrowserWindow.prototype[method] = function () {}

const results = []
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: String(detail ?? '') })
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  const { PluginManager } = require(path.join(REPO, 'dist-electron', 'plugins', 'plugin-manager.js'))
  const manager = new PluginManager([USER_PLUGINS], USER_PLUGINS)
  manager.discover()
  manager.installDirectory(dir)

  require(path.join(REPO, 'dist-electron', 'main.js'))
  await app.whenReady()

  let host = null
  let view = null
  for (let tick = 0; tick < 40 && (!host || !view); tick += 1) {
    host = host ?? BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('dist/index.html'))
    view = view ?? webContents.getAllWebContents().find(w => w.getURL().includes(PLUGIN_ID))
    if (!host || !view) await wait(200)
  }
  check('宿主与插件页都在', !!host && !!view)
  if (!host || !view) { app.exit(1); return }
  await wait(1500)

  // 把宿主渲染层的动画时钟换成手动步进（隐藏窗口里 rAF 会被降频，实时测不准）
  await host.webContents.executeJavaScript(`(() => {
    const queue = new Map()
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
    return true
  })()`)

  // host:animation-frame crosses the renderer/main-process boundary, and native
  // View.setBounds is asynchronous on Windows. Let that frame settle before
  // sampling the native geometry, otherwise the assertion reads the previous
  // viewport and reports a leak that was never painted.
  const step = async (frames = 1) => { await host.webContents.executeJavaScript(`window.__advance(${frames})`); await wait(120) }
  const snapshot = async () => {
    const shell = await host.webContents.executeJavaScript(`(() => {
      const el = document.querySelector('#host-root .island-shell')
      return { mode: el.dataset.mode, inline: [parseFloat(el.style.width), parseFloat(el.style.height)] }
    })()`)
    const pluginMode = await view.executeJavaScript('window.dynamicIsland.ui.getMode()')
    const viewport = [...geometry].filter(item => item.kind === 'viewport').pop()?.bounds ?? null
    const pluginBounds = [...geometry].filter(item => item.kind === 'plugin').pop()?.bounds ?? null
    return { shell: { width: Math.round(shell.inline[0]), height: Math.round(shell.inline[1]) }, hostMode: shell.mode, pluginMode, viewport, pluginBounds }
  }

  // --- 先到 mini 条，再进中岛（展开也顺便验一遍：内容不应该比胶囊先变大到露出来）
  await view.executeJavaScript('window.dynamicIsland.ui.collapse()')
  await step(60)
  await view.executeJavaScript('window.dynamicIsland.ui.expand()')
  for (let index = 0; index < 40; index += 1) await step(1)
  const expanded = await snapshot()
  check('已进入中岛', expanded.pluginMode === 'medium' && expanded.hostMode === 'expanded', JSON.stringify(expanded))
  // Drain real IPC/native work from the preceding expand before clearing the
  // native trace; the renderer clock is virtual but Electron's main process is
  // still real-time.
  await wait(500)

  // --- 收起：鼠标移出 / 失焦都是走这条 showCompact
  geometry.length = 0
  await view.executeJavaScript('window.dynamicIsland.ui.collapse()')
  const frames = []
  for (let index = 0; index < 60; index += 1) {
    frames.push(await snapshot())
    await step(1)
  }
  // The host's mini layout is max(minWidth, content + horizontal padding).
  // For this probe the small plugin is already 150px wide, so only the
  // compact layout's 16px horizontal padding contributes.
  const miniTarget = { width: 166, height: 44 }
  const arrived = frames.find(frame => frame.shell.width <= miniTarget.width + 2 && frame.shell.height <= miniTarget.height + 2)
  const switched = frames.find(frame => frame.pluginMode === 'small')
  // The renderer's virtual clock can advance faster than the main-process IPC
  // queue. Compare the mode switch with the native viewport sample from the
  // same observation instead of comparing two unsynchronised processes.
  // The preceding expand can still have a queued IPC frame. Its viewport is
  // at y=0; the collapse under test is anchored at islandTop=5.
  const nativeViewports = geometry.filter(item => item.kind === 'viewport' && item.bounds.y === 5).map(item => item.bounds)
  const uniqueViewports = nativeViewports.filter((item, index) => index === 0 || item.width !== nativeViewports[index - 1].width || item.height !== nativeViewports[index - 1].height)
  const nonMonotone = uniqueViewports.some((item, index) => index > 0 && (item.width > uniqueViewports[index - 1].width + 2 || item.height > uniqueViewports[index - 1].height + 2))
  const nativeUndershoot = uniqueViewports.some(item => item.width < miniTarget.width - 2 || item.height < miniTarget.height - 2)
  const switchedIndex = switched ? frames.indexOf(switched) : -1
  const nativeAtSwitch = switched?.viewport ?? null
  const earlySwitch = switched && (!nativeAtSwitch || nativeAtSwitch.width > miniTarget.width + 2 || nativeAtSwitch.height > miniTarget.height + 2) ? switched : null
  const leaks = frames.filter(frame => frame.viewport && (frame.viewport.width > frame.shell.width + 2 || frame.viewport.height > frame.shell.height + 2))

  console.log('=== 收起逐帧（外壳 / viewport / 插件模式）===')
  for (const [index, frame] of frames.entries()) {
    if (index % 3 !== 0 && index !== frames.length - 1) continue
    console.log(`  #${String(index).padStart(2)}  外壳 ${String(frame.shell.width).padStart(4)}×${String(frame.shell.height).padStart(3)}  viewport ${frame.viewport ? `${String(frame.viewport.width).padStart(4)}×${String(frame.viewport.height).padStart(3)}` : '(none)'}  插件=${frame.pluginMode}`)
  }
  console.log(`胶囊到位: ${arrived ? `#${frames.indexOf(arrived)}（${arrived.shell.width}×${arrived.shell.height}）` : '60 帧内未到位'}`)
  console.log(`内容切换: ${switched ? `#${frames.indexOf(switched)}（外壳 ${switched.shell.width}×${switched.shell.height}）` : '未切换'}`)
  console.log(`原生 viewport 轨迹: ${uniqueViewports.length} 个尺寸；未同步采样到的外壳快照: ${leaks.length} 帧`)

  check('原生 viewport 收缩轨迹不反弹', !nonMonotone, JSON.stringify(uniqueViewports))
  check('原生 viewport 不会缩过 mini 目标', !nativeUndershoot, JSON.stringify(uniqueViewports[uniqueViewports.length - 1] ?? null))
  check('插件内容切换前，原生 viewport 已到 mini 范围', !earlySwitch, earlySwitch ? `在 #${switchedIndex} 切换时 viewport 仍是 ${JSON.stringify(nativeAtSwitch)}` : '')
  check('收起结束后插件是 mini 内容', frames[frames.length - 1].pluginMode === 'small', frames[frames.length - 1].pluginMode)
  check('收起结束后外壳就是 mini 条尺寸', Math.abs(frames[frames.length - 1].shell.width - miniTarget.width) <= 4 && Math.abs(frames[frames.length - 1].shell.height - miniTarget.height) <= 4, `${frames[frames.length - 1].shell.width}×${frames[frames.length - 1].shell.height} vs ${miniTarget.width}×${miniTarget.height}`)

  let failed = 0
  for (const item of results) { if (!item.ok) failed += 1; console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.detail ? `   [${item.detail}]` : ''}`) }
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  app.exit(failed ? 1 : 0)
}

app.whenReady().then(main).catch((error) => { console.error(error); app.exit(1) })
