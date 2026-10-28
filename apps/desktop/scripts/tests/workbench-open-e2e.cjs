// 工作台"第一次打开"的动画验收（真实宿主 + 真实工作台页面）。
//
// 用户报的问题：**第一次打开工作台，会先慢慢横向变宽、再突然变高；第二次就好了。**
// 复现出来的真因是一个**自适应回环**：内置工作台启动时请求"自己的尺寸 + 2px"，
// 而它的根元素是 height:100%，量到的就是宿主给的盒子 —— 于是宿主做大 2px、
// 页面再请求 +2px…… 实测一秒内刷出 **163 次布局**，尺寸从 720×480 一路爬到上限。
// 第二次打开页面不重载、没有 resize 事件，所以看起来是好的。
//
// 所以这里断言的是"**一次打开只允许有一个布局目标**"——它同时锁住了这类回环。
// 后半段锁住 `workbench:resize` 的两道守卫：**没被宿主排布过就拒绝**（那时页面量到的是垃圾值）、
// **贴着当前尺寸的微调当回环丢掉**；同时确认它们不误伤正常用法（显示中的调整、关着时的暂存）。
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'
const { app, BrowserWindow, ipcMain, webContents } = require('electron')

const REPO = path.join(__dirname, '..', '..')
const SANDBOX = path.join(os.tmpdir(), 'island-workbench-open')
const PROFILE = path.join(SANDBOX, 'profile')

fs.rmSync(SANDBOX, { recursive: true, force: true })
fs.mkdirSync(path.join(PROFILE, 'plugins'), { recursive: true })
fs.mkdirSync(PROFILE, { recursive: true })
app.setPath('userData', PROFILE)
fs.writeFileSync(path.join(PROFILE, 'settings.json'), JSON.stringify({ idleMode: 'float', islandTop: 8, miniScale: 1, pluginOrder: [] }))

for (const method of ['show', 'showInactive', 'focus']) BrowserWindow.prototype[method] = function () {}

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail: String(detail ?? '') })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `   [${detail}]` : ''}\n`)
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  require(path.join(REPO, 'dist-electron', 'main.js'))
  await app.whenReady()
  await wait(2500)

  const host = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('dist/index.html'))
  check('宿主窗口存在', !!host)
  if (!host) { app.exit(1); return }
  const js = (code) => host.webContents.executeJavaScript(code)

  // 记录渲染层收到的每一次布局目标
  await js(`(() => {
    window.__layouts = []
    const start = performance.now()
    window.dynamicIslandHost.onLayout((layout) => {
      window.__layouts.push({ t: Math.round(performance.now() - start), w: layout.width, h: layout.height, mode: layout.mode })
    })
    return true
  })()`)

  // 打开控制台。等 1600ms 而不是等"动画一定结束"：测试里没有真实指针，
  // 宿主大约 1.5s 后就会自己把小岛收回去，等太久反而把 idle 布局混进来。
  const openConsole = async (waitMs = 1600) => { ipcMain.emit('host:open-workbench'); await wait(waitMs) }
  const openOnce = async (label) => {
    await js('window.__layouts = []')
    await openConsole()
    const layouts = await js('window.__layouts')
    // 只看 custom（控制台）那一段：测试里没有真实指针，宿主会在空闲后自己收回小岛，
    // 那些 idle/compact 布局跟"这次打开要多大"无关。
    const consoleLayouts = layouts.filter(item => item.mode === 'custom')
    const distinct = []
    for (const item of consoleLayouts) if (!distinct.some(d => d.w === item.w && d.h === item.h)) distinct.push(item)
    return { layouts, consoleLayouts, distinct }
  }
  const closeWorkbench = async () => {
    const view = webContents.getAllWebContents().find(item => item.getURL().includes('console-apps/workbench'))
    if (view) await view.executeJavaScript('window.workbench.exit()').catch(() => {})
    await wait(2000)
  }
  const summarize = (distinct) => distinct.map(d => `${d.w}×${d.h}`).join(' → ')
  // 布局是宿主在收到请求后立刻发出的，但"立刻"也跨了一次 IPC，所以宁可轮询而不是死等。
  const waitForLayout = async (predicate, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const layouts = await js('window.__layouts')
      const hit = layouts.find(predicate)
      if (hit) return { hit, tail: layouts.slice(-3) }
      if (Date.now() > deadline) return { hit: null, tail: layouts.slice(-3) }
      await wait(150)
    }
  }

  // ---- 第一次打开（冷：工作台页面从没加载过）
  const first = await openOnce('第一次')
  check('第一次打开只产生一个布局目标（不是先窄后高两段）',
    first.distinct.length === 1, `${first.consoleLayouts.length} 次 custom layout，目标：${summarize(first.distinct)}`)
  check('第一次打开的目标尺寸就是声明的尺寸（不是从钳制下限往上爬）',
    first.distinct[0]?.w === 1040 && first.distinct[0]?.h === 700, summarize(first.distinct))

  // ---- 关掉再开（第二次）
  await closeWorkbench()
  const second = await openOnce('第二次')
  check('第二次打开同样只有一个布局目标', second.distinct.length === 1, `${second.consoleLayouts.length} 次 custom layout，目标：${summarize(second.distinct)}`)
  check('两次打开的目标尺寸一致', summarize(first.distinct) === summarize(second.distinct), `${summarize(first.distinct)} vs ${summarize(second.distinct)}`)

  // ---- 页面不再自动改尺寸：它在屏外乱报也不会污染下一次打开之外的任何东西
  const view = webContents.getAllWebContents().find(item => item.getURL().includes('console-apps/workbench'))
  check('工作台页面加载完成', !!view)
  if (view) {
    // 先关掉工作台（回小岛）。**注意**：关闭不会让"页面量到的尺寸"失效 ——
    // 它保持上次排布出来的 bounds，所以关着的时候请求尺寸仍然是合法的
    // （判据是"宿主排布过"，不是"当前可见"），只是宿主不再为它重排。
    await closeWorkbench()
    const staged = JSON.parse(await view.executeJavaScript("(async () => JSON.stringify(await window.workbench.resize({ width: 760, height: 500 })))()"))
    check('屏外请求被接受（页面量到的是上次排布的真实尺寸）', staged.ok === true && staged.width === 760 && staged.height === 500, JSON.stringify(staged))
    const whileClosed = await js('window.__layouts')
    check('但它不会在关着的时候引起重排', !whileClosed.some(item => item.w === 760 && item.h === 500), JSON.stringify(whileClosed.slice(-3)))

    const afterBogus = await openOnce('被记下的尺寸之后')
    check('记下的尺寸在下一次打开生效（一个目标，就是它）',
      afterBogus.distinct.length === 1 && afterBogus.distinct[0]?.w === 760 && afterBogus.distinct[0]?.h === 500,
      summarize(afterBogus.distinct))

    // ---- 正在显示时，有意义的尺寸调整仍然生效（守卫不能误伤正常用法）
    // 必须打开后**马上**请求：测试里没有真实指针，宿主约 1.5s 后就把小岛收回去了。
    await openConsole(250)
    const real = JSON.parse(await view.executeJavaScript("(async () => JSON.stringify(await window.workbench.resize({ width: 1000, height: 640 })))()"))
    check('显示中发起有意义的调整会生效', real.ok === true && real.width === 1000 && real.height === 640, JSON.stringify(real))
    const relaid = await waitForLayout(item => item.w === 1000 && item.h === 640)
    check('调整后确实重新布局到新尺寸', !!relaid.hit, JSON.stringify(relaid.tail))

    // ---- 回环特征被拦掉：贴着当前尺寸的微调不再触发重排
    const feedback = JSON.parse(await view.executeJavaScript("(async () => JSON.stringify(await window.workbench.resize({ width: 1002, height: 642 })))()"))
    check('贴着当前尺寸的微调被当成回环丢掉', feedback.ok === true && feedback.ignored === 'below-threshold', JSON.stringify(feedback))
    const afterFeedback = await js('window.__layouts')
    check('被当成回环的请求不会再多出布局', !afterFeedback.some(item => item.w === 1002 && item.h === 642), JSON.stringify(afterFeedback.slice(-3)))
  }

  let failed = 0
  for (const item of results) if (!item.ok) failed += 1
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  app.exit(failed ? 1 : 0)
}

app.whenReady().then(main).catch((error) => { console.error(error); app.exit(1) })
