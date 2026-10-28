// "插件按需出现在岛上" 的端到端验收（真实宿主 + 临时 profile，窗口不显示）。
// 场景：插件自报没内容（island.ui.setPresence(false)）→ 不该占 mini 条；有内容了再回来。
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'
const { app, BrowserWindow, webContents } = require('electron')

const REPO = path.join(__dirname, '..', '..')
const SANDBOX = path.join(os.tmpdir(), 'island-presence-e2e')
const PROFILE = path.join(SANDBOX, 'profile')
const USER_PLUGINS = path.join(PROFILE, 'plugins')

fs.rmSync(SANDBOX, { recursive: true, force: true })
fs.mkdirSync(USER_PLUGINS, { recursive: true })
fs.mkdirSync(PROFILE, { recursive: true })
app.setPath('userData', PROFILE)
fs.writeFileSync(path.join(PROFILE, 'settings.json'), JSON.stringify({ idleMode: 'float', islandTop: 5, miniScale: 1, pluginOrder: [] }))

/** always = 常驻；on-demand = 先声明没内容，收到 kick 事件后再出现。 */
function makePlugin(id, name, behavior) {
  const dir = path.join(SANDBOX, 'dev', id)
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
    id, name, version: '0.1.0', runtime: 'web-app', priority: 50, entry: 'dist/index.html', resident: true,
    small: { enabled: true, width: 150, height: 40 }, medium: { width: 420, height: 200 }, large: { width: 640, height: 340 },
  }, null, 2))
  fs.writeFileSync(path.join(dir, 'dist', 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8"><title>${id}</title></head><body style="margin:0;background:transparent">
     <div id="app" style="width:100%;height:100%">${name}</div><script src="app.js"></script></body></html>`)
  fs.writeFileSync(path.join(dir, 'dist', 'app.js'), `
    const island = window.dynamicIsland
    island.events.on('kick', () => island.ui.setPresence(true))
    if ('${behavior}' === 'on-demand') island.ui.setPresence(false)
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
  manager.installDirectory(makePlugin('presence-always', '常驻', 'always'))
  manager.installDirectory(makePlugin('presence-ondemand', '按需出现', 'on-demand'))

  require(path.join(REPO, 'dist-electron', 'main.js'))
  await app.whenReady()
  await wait(3500)

  const host = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('dist/index.html'))
  const js = (code) => host.webContents.executeJavaScript(code)
  // 宿主渲染层给每个 mini 段之间画一条分隔线：N 个可见段 = N-1 条线；段宽之和也能直接读。
  const separators = () => js("document.querySelectorAll('#host-root .island-separators i').length")
  const shellWidth = () => js("Math.round(parseFloat(getComputedStyle(document.querySelector('#host-root .island-shell')).width) || 0)")

  check('宿主渲染层已就绪', await js("!!document.querySelector('#host-root .island-shell')"))

  const onDemand = webContents.getAllWebContents().find(w => w.getURL().includes('presence-ondemand'))
  check('按需插件页面已加载', !!onDemand)
  await wait(800)
  // 先让两个插件都在（按需插件启动时会立刻声明"没内容"，所以这里显式拉回来）
  await onDemand.executeJavaScript('window.dynamicIsland.ui.setPresence(true)')
  await wait(1200)
  const bothSegments = await separators()
  const wideShell = await shellWidth()
  check('两个插件都在 mini 条里（1 条分隔线）', bothSegments === 1, `分隔线 ${bothSegments}`)

  // 按需插件声明"我没内容" → 应该从条上消失（只剩一个段，宽度也变窄）
  const before = await separators()
  await onDemand.executeJavaScript('window.dynamicIsland.ui.setPresence(false)')
  await wait(1200)
  const after = await separators()
  const narrowShell = await shellWidth()
  check('插件自报没内容后从 mini 条消失', before === 1 && after === 0, `分隔线 ${before} → ${after}`)
  check('mini 条宽度跟着变窄', narrowShell < wideShell, `${wideShell} → ${narrowShell}`)
  check('插件被告知自己不在岛上了（island.every 会暂停）', await onDemand.executeJavaScript("window.dynamicIsland.visibility().visible === false && window.dynamicIsland.visibility().reason === 'hidden'"), await onDemand.executeJavaScript('JSON.stringify(window.dynamicIsland.visibility())'))

  // 有内容了 → 回到 mini 条
  await onDemand.executeJavaScript("window.dynamicIsland.ui.setPresence(true)")
  await wait(1200)
  check('有内容后再回到 mini 条', await separators() === 1, `分隔线 ${await separators()}`)

  // 只声明没内容、没有别的插件时，岛应该退回待机而不是留个空条
  const always = webContents.getAllWebContents().find(w => w.getURL().includes('presence-always'))
  await always.executeJavaScript('window.dynamicIsland.ui.setPresence(false)')
  await onDemand.executeJavaScript('window.dynamicIsland.ui.setPresence(false)')
  await wait(1500)
  check('所有插件都没内容时回到待机（不留空条）', await js("document.querySelector('#host-root .island-shell').dataset.mode") === 'idle', await js("document.querySelector('#host-root .island-shell').dataset.mode"))

  console.log('=== 插件按需出现在岛上（真实宿主）===')
  let failed = 0
  for (const item of results) { if (!item.ok) failed += 1; console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.detail ? `   [${item.detail}]` : ''}`) }
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  app.exit(failed ? 1 : 0)
}

app.whenReady().then(main).catch((error) => { console.error(error); app.exit(1) })
