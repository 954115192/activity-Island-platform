// 「中岛里用滚轮调值」的可行性验收（真实宿主 + 真实插件页，窗口不显示）。
//
// 为什么要有这个测试：Focus Flow 规格把"调专注时长"整个押在**中岛内的竖向滚轮**上。
// 如果插件页在中岛状态下收不到 wheel 事件，这个设计就是空谈，必须先证明它是通的。
//
// 证明三件事：
//   1) 中岛状态下插件页能收到 wheel 事件，并且 preventDefault() 能生效（不会穿透去滚宿主页面）；
//   2) 插件能读到正确的 deltaY 方向与大小（滚轮调值的输入源）；
//   3) 中岛的插件视图确实盖住岛的中心 —— 真实鼠标滚轮才会落在它身上（几何前提）。
//
// 说明：sendInputEvent 是合成输入，直接投递给目标 webContents，绕过 Windows 的真实命中测试。
// 所以这里证明的是"页面级行为 + 几何覆盖"；OS 级路由由插件视图位于宿主渲染层之上保证。
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'
const { app, BrowserWindow, View, WebContentsView, webContents } = require('electron')

const REPO = path.join(__dirname, '..', '..')
const SANDBOX = path.join(os.tmpdir(), 'island-wheel-e2e')
const PROFILE = path.join(SANDBOX, 'profile')
const USER_PLUGINS = path.join(PROFILE, 'plugins')

fs.rmSync(SANDBOX, { recursive: true, force: true })
fs.mkdirSync(USER_PLUGINS, { recursive: true })
fs.mkdirSync(PROFILE, { recursive: true })
app.setPath('userData', PROFILE)
fs.writeFileSync(path.join(PROFILE, 'settings.json'), JSON.stringify({ idleMode: 'float', islandTop: 5, miniScale: 1, pluginOrder: [] }))

// 记录原生几何：确认插件视图覆盖岛中心
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

const dir = path.join(SANDBOX, 'dev', 'wheel-probe')
fs.mkdirSync(path.join(dir, 'dist'), { recursive: true })
fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
  id: 'wheel-probe', name: '滚轮探针', version: '0.1.0', runtime: 'web-app', priority: 50, entry: 'dist/index.html', resident: true,
  small: { enabled: true, width: 150, height: 40 }, medium: { width: 420, height: 200 }, large: { width: 640, height: 340 },
}, null, 2))
fs.writeFileSync(path.join(dir, 'dist', 'index.html'),
  `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:transparent;overflow:hidden}</style></head>
   <body><div id="wheel" style="width:100%;height:100%">w</div><script src="app.js"></script></body></html>`)
// 滚轮探针：把收到的 wheel 记录到 window.__wheel，并尝试 preventDefault。
fs.writeFileSync(path.join(dir, 'dist', 'app.js'), `
  window.__wheel = []
  const island = window.dynamicIsland
  const el = document.querySelector('#wheel')
  el.addEventListener('wheel', (event) => {
    event.preventDefault()
    window.__wheel.push({
      deltaY: event.deltaY,
      deltaMode: event.deltaMode,
      defaultPrevented: event.defaultPrevented,
      preventDefaultWorks: event.cancelable,
      mode: island.ui.getMode(),
    })
  }, { passive: false })
  el.addEventListener('click', () => island.ui.expand())
  window.__scrollY = () => window.scrollY
`)

// ⚠️ 这个测试必须让窗口真实显示：把 show/showInactive 打桩成空操作时，窗口从不合成，
// Chromium 不会把 WebContentsView 的 resize 转发给渲染层 —— 插件页会永远停在初始尺寸，
// 于是"中岛里的插件页到底多大""滚轮有没有送达"都测不准（这是实测踩过的坑）。
const SHOW_WINDOW = process.env.ISLAND_HIDDEN !== '1'
if (!SHOW_WINDOW) {
  for (const method of ['show', 'showInactive', 'focus']) BrowserWindow.prototype[method] = function () {}
}

// ⚠️ 第二个坑：**用户可能正开着灵动岛**。它是 always-on-top 窗口，会把测试窗口盖住，
// Chromium 于是节流被遮挡的渲染进程 —— 症状和"窗口没显示"一模一样（插件页停在 150×40），
// 看着像产品坏了，其实是环境。这两个开关让渲染进程不因遮挡/后台而降频（只有测试需要）。
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')

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
  await wait(3500)

  const view = webContents.getAllWebContents().find(item => item.getURL().includes('wheel-probe'))
  check('插件页已加载', !!view)
  if (!view) { app.exit(1); return }

  const js = code => view.executeJavaScript(code)
  const mode = () => js('window.dynamicIsland.ui.getMode()')

  // 进中岛：滚轮只有在 medium 才是"调值"的主场景
  await js("document.querySelector('#wheel').click()")
  // 等"中岛 + 页面真的 reflow 到位"，不要用固定等待：批量跑测试时机器更忙，
  // 固定 1400ms 会偶发地量到还没 reflow 的尺寸，看着像产品坏了（实际是测试时序脆弱）。
  let box = { w: 0, h: 0 }
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    await wait(200)
    box = await js('({ w: innerWidth, h: innerHeight })')
    if (box.w === 420 && box.h === 200) break
  }
  check('已进入中岛（滚轮调值的场景）', await mode() === 'medium', await mode())
  // 插件页必须真的跟着中岛放大 —— 否则滚轮坐标、布局、命中全都不对
  check('插件页布局视口已放大到中岛尺寸', box.w === 420 && box.h === 200, JSON.stringify(box))

  // 合成滚轮：向上一格（deltaY 为负 = 内容上移 = 数值变小，苹果手感）
  const at = { x: Math.round(box.w / 2), y: Math.round(box.h / 2) }
  view.sendInputEvent({ type: 'mouseWheel', x: at.x, y: at.y, deltaX: 0, deltaY: -120, canScroll: true })
  await wait(300)
  view.sendInputEvent({ type: 'mouseWheel', x: at.x, y: at.y, deltaX: 0, deltaY: 120, canScroll: true })
  // 轮询到两个事件都到齐，同样避免固定等待的偶发
  let events = []
  const wheelDeadline = Date.now() + 5000
  while (Date.now() < wheelDeadline) {
    await wait(150)
    events = await js('window.__wheel')
    if (Array.isArray(events) && events.length >= 2) break
  }
  const deltas = (events ?? []).map(e => e.deltaY).sort((a, b) => a - b)
  check('中岛里插件页能收到滚轮事件', Array.isArray(events) && events.length === 2, JSON.stringify(events))
  // 不校验先后顺序：合成滚轮会走 Chromium 的滚动管线，两个事件的派发顺序不保证。
  // 真实滚轮是逐个到达的，插件按"每次增量"处理即可（这也正是规格要求的做法）。
  check('deltaY 大小与正负都能读到（滚轮调值的输入源）', deltas.length === 2 && deltas[0] === -120 && deltas[1] === 120, JSON.stringify(deltas))
  check('滚轮事件可取消（preventDefault 生效，不会穿透滚宿主页面）', events?.every(e => e.defaultPrevented === true && e.preventDefaultWorks === true), JSON.stringify(events))
  check('事件是在 medium 模式下收到的', events?.every(e => e.mode === 'medium'), JSON.stringify(events?.map(e => e.mode)))

  // 页面本身没有被滚走（preventDefault 的实际效果）
  const scrolled = await js('window.__scrollY()')
  check('滚轮没有把插件页面滚走（仍停在 0）', scrolled === 0, String(scrolled))

  // 几何：插件视图必须盖住岛中心，真实滚轮才会落在它身上
  const stage = await js('({ w: innerWidth, h: innerHeight })')
  const plugin = [...geometry].filter(item => item.kind === 'plugin').pop()?.bounds ?? null
  const coversCenter = plugin && Math.abs(plugin.x) <= 1 && Math.abs(plugin.y) <= 1
    && plugin.width >= Math.round(stage.w) - 2 && plugin.height >= Math.round(stage.h) - 2
  check('插件视图盖住整个岛面（真实滚轮会落在插件上）', !!coversCenter, `${JSON.stringify(plugin)} vs 页面 ${JSON.stringify(stage)}`)

  let failed = 0
  for (const item of results) { if (!item.ok) failed += 1; console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.detail ? `   [${item.detail}]` : ''}`) }
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  app.exit(failed ? 1 : 0)
}

app.whenReady().then(main).catch((error) => { console.error(error); app.exit(1) })
