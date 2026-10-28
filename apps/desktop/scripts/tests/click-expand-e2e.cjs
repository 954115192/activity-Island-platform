// "点击小岛段 → 进中岛" 的端到端验收（真实宿主 + 临时 profile，窗口不显示）。
//
// 结论先写在这里：**这一步是插件自己的责任** —— 宿主不会替你展开。
// 插件在 small 段上要自己挂点击 → island.ui.expand()；宿主只负责响应这条命令
// （仅在 mini 条(compact)状态下展开到 medium，再点一次进 large）。
// 本测试同时证明两件事：
//   1) 挂了这个处理的插件，点击后宿主确实进中岛（宿主没问题）；
//   2) 没挂的插件，点击后毫无反应（占位/demo 插件都有，AI 生成的经常漏）。
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'
const { app, BrowserWindow, webContents } = require('electron')

const REPO = path.join(__dirname, '..', '..')
const SANDBOX = path.join(os.tmpdir(), 'island-click-e2e')
const PROFILE = path.join(SANDBOX, 'profile')
const USER_PLUGINS = path.join(PROFILE, 'plugins')

fs.rmSync(SANDBOX, { recursive: true, force: true })
fs.mkdirSync(USER_PLUGINS, { recursive: true })
fs.mkdirSync(PROFILE, { recursive: true })
app.setPath('userData', PROFILE)
fs.writeFileSync(path.join(PROFILE, 'settings.json'), JSON.stringify({ idleMode: 'collapsed', islandTop: 5, miniScale: 1, pluginOrder: [] }))

/** 造一个和第 1 个测试插件一样、但 small 段带不带点击处理的插件。 */
function makePlugin(id, name, { expandOnClick }) {
  const dir = path.join(SANDBOX, 'dev', id)
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
    id, name, version: '0.1.0', runtime: 'web-app', priority: 50, entry: 'dist/index.html',
    small: { enabled: true, width: 150, height: 40 }, medium: { width: 420, height: 200 }, large: { width: 640, height: 340 },
  }, null, 2))
  fs.writeFileSync(path.join(dir, 'dist', 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8"><title>${id}</title></head><body style="margin:0;background:transparent">
     <div id="app" style="width:100%;height:100%"><button id="segment" style="width:100%;height:100%">${name}</button></div>
     <script src="app.js"></script></body></html>`)
  fs.writeFileSync(path.join(dir, 'dist', 'app.js'), `
    const island = window.dynamicIsland
    const segment = document.querySelector('#segment')
    ${expandOnClick ? "segment.onclick = () => island.ui.expand()" : '// 故意不挂点击处理：模拟"AI 生成的插件漏了这一步"'}
    // 测试脚手架：真实用户是 hover 出 mini 条的，这里用 SDK 直接切到 mini 条再点。
    setTimeout(() => island.ui.collapse(), 600)
    island.log.info('${id} booted')
  `)
  return dir
}

for (const method of ['show', 'showInactive', 'focus']) BrowserWindow.prototype[method] = function () {}

const results = []
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: String(detail ?? '') })
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  const { PluginManager } = require(path.join(REPO, 'dist-electron', 'plugins', 'plugin-manager.js'))
  const manager = new PluginManager([USER_PLUGINS], USER_PLUGINS)
  manager.discover()
  manager.installDirectory(makePlugin('click-probe-ok', '会展开', { expandOnClick: true }))
  manager.installDirectory(makePlugin('click-probe-silent', '不展开', { expandOnClick: false }))
  // 可选：ISLAND_CLICK_PLUGIN=<插件目录> 时把真实插件也一起装上验一遍
  const external = process.env.ISLAND_CLICK_PLUGIN
  const externalId = external && fs.existsSync(path.join(external, 'plugin.json'))
    ? JSON.parse(fs.readFileSync(path.join(external, 'plugin.json'), 'utf8')).id
    : null
  if (externalId) manager.installDirectory(external)

  require(path.join(REPO, 'dist-electron', 'main.js'))
  await app.whenReady()
  await wait(3500)

  const host = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('dist/index.html'))
  check('小岛窗口存在', !!host)
  if (!host) throw new Error('小岛窗口没创建')
  // 宿主窗口尺寸是固定的（1064×730），只有里面的胶囊在动 —— 判断模式要看插件页自己拿到的 mode。
  check('宿主窗口尺寸是固定的（动画在内层胶囊）', host.getBounds().width === 1064, JSON.stringify(host.getBounds()))

  const viewOf = (id) => webContents.getAllWebContents().find(item => item.getURL().includes(id))
  const modeOf = (view) => view.executeJavaScript('window.dynamicIsland.ui.getMode()')
  const clickCenter = (view) => view.executeJavaScript(`(() => {
    const el = document.elementFromPoint(innerWidth / 2, innerHeight / 2) || document.querySelector('#segment')
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    return el.id || el.tagName
  })()`)

  // ---- 1) 挂了点击处理的插件：点一下应该进中岛
  const ok = viewOf('click-probe-ok')
  check('会展开的插件页面已加载', !!ok)
  await wait(1200)
  check('点击前是 small', await modeOf(ok) === 'small', await modeOf(ok))
  const hit = await clickCenter(ok)
  check('点到了 small 段', hit === 'segment', String(hit))
  await wait(1200)
  check('点击后进入中岛（宿主会响应 ui:expand）', await modeOf(ok) === 'medium', await modeOf(ok))

  // 注：medium → large 这一步没法在这个环境里稳定验证 —— 合成点击不会移动真实鼠标，
  // 宿主发现光标不在岛上就会把展开态收回去（真实用户点的时候光标就在岛上，不会有这个问题）。
  // 这里只验证用户真正报的那一步：small 段点一下能不能进中岛。

  // ---- 1.5) 岛的渲染进程崩了必须自己活过来（用户报的"程序死掉了"）
  // 岛的画面就是这个渲染进程画的：它一崩，窗口和进程都还在，但整块看起来就是死的。
  host.webContents.forcefullyCrashRenderer()
  let recovered = false
  for (let tick = 0; tick < 40 && !recovered; tick += 1) {
    await wait(300)
    recovered = await host.webContents.executeJavaScript('1+1').then(value => value === 2).catch(() => false)
  }
  check('岛渲染进程崩溃后自动恢复（不用重启应用）', recovered)
  check('恢复后页面重新加载完成', host.webContents.getURL().includes('dist/index.html') && !host.webContents.isCrashed(), host.webContents.getURL())

  // ---- 2) 没挂点击处理的插件：点了什么都不该发生
  const silent = viewOf('click-probe-silent')
  check('不展开的插件页面已加载', !!silent)
  await silent.executeJavaScript('window.dynamicIsland.ui.collapse()')
  await wait(1200)
  const before = await modeOf(silent)
  await clickCenter(silent)
  await wait(1200)
  const after = await modeOf(silent)
  check('插件不处理点击时，宿主不会自己展开（所以"点了没反应"是插件的锅）', before === 'small' && after === 'small', `${before} → ${after}`)

  // ---- 3) 可选：拿真实插件目录验一遍（ISLAND_CLICK_PLUGIN=<插件目录>）
  if (externalId) {
    const view = viewOf(externalId)
    check(`真实插件 ${externalId} 页面已加载`, !!view)
    if (view) {
      await view.executeJavaScript('window.dynamicIsland.ui.collapse()').catch(() => {})
      await wait(1200)
      const start = await modeOf(view)
      await clickCenter(view)
      await wait(1200)
      const expanded = await modeOf(view)
      check(`真实插件 ${externalId} 点击后进中岛`, expanded === 'medium' || expanded === 'large', `${start} → ${expanded}`)
    }
  }

  console.log('=== 点击进中岛端到端验收（真实宿主）===')
  let failed = 0
  for (const item of results) { if (!item.ok) failed += 1; console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.detail ? `   [${item.detail}]` : ''}`) }
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  app.exit(failed ? 1 : 0)
}

app.whenReady().then(main).catch((error) => { console.error(error); app.exit(1) })
