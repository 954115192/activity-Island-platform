// 临时消息（alert）的档位是否真的到达岛壳：info/warn/critical 三档描边光晕。
// 场景：插件调 island.alert({level}) → 岛壳 data-alert 变成对应档位、computed box-shadow 有描边；
//       ttl 到期后 data-alert 被撤掉、光晕消失。
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'
const { app, BrowserWindow } = require('electron')

const REPO = path.join(__dirname, '..', '..')
const SANDBOX = path.join(os.tmpdir(), 'island-alert-visual-e2e')
const PROFILE = path.join(SANDBOX, 'profile')
const USER_PLUGINS = path.join(PROFILE, 'plugins')

fs.rmSync(SANDBOX, { recursive: true, force: true })
fs.mkdirSync(USER_PLUGINS, { recursive: true })
fs.mkdirSync(PROFILE, { recursive: true })
app.setPath('userData', PROFILE)
fs.writeFileSync(path.join(PROFILE, 'settings.json'), JSON.stringify({ idleMode: 'float', islandTop: 5, miniScale: 1, pluginOrder: [] }))

function makePlugin(id, name) {
  const dir = path.join(SANDBOX, 'dev', id)
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
    id, name, version: '0.1.0', runtime: 'web-app', priority: 50, entry: 'dist/index.html', resident: true,
    small: { enabled: true, width: 150, height: 40 }, medium: { width: 420, height: 200 }, large: { width: 640, height: 340 },
  }, null, 2))
  fs.writeFileSync(path.join(dir, 'dist', 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8"><title>${id}</title></head><body style="margin:0;background:transparent">
     <div id="app" style="width:100%;height:100%">${name}</div><script src="app.js"></script></body></html>`)
  // 亮一下提醒：level 与 ttl 由测试通过 events 传进来。
  fs.writeFileSync(path.join(dir, 'dist', 'app.js'), `
    const island = window.dynamicIsland
    island.events.on('fire', (payload) => island.alert(payload ?? {}))
    document.addEventListener('click', () => island.ui.expand())
    island.events.on('collapse', () => island.ui.collapse())
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
  manager.installDirectory(makePlugin('alert-probe', '提醒探针'))

  require(path.join(REPO, 'dist-electron', 'main.js'))
  await app.whenReady()
  await wait(3200)

  const host = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('dist/index.html'))
  if (!host) { console.log('FAIL 找不到宿主窗口'); process.exit(1) }
  const js = (code) => host.webContents.executeJavaScript(code)
  const shellAttr = () => js("document.querySelector('#host-root .island-shell').dataset.alert ?? ''")
  const shellShadow = () => js("getComputedStyle(document.querySelector('#host-root .island-shell')).boxShadow")

  // 插件页是 WebContentsView，不在 BrowserWindow.getAllWindows() 里，按 URL 从全部 webContents 找。
  const fireAlert = async (payload) => {
    const { webContents } = require('electron')
    const target = webContents.getAllWebContents().find(wc => wc.getURL().includes('alert-probe'))
    if (!target) return false
    target.send('host:event', { name: 'fire', payload })
    return true
  }

  check('宿主渲染层就绪', await js("!!document.querySelector('#host-root .island-shell')"))

  const fired = await fireAlert({ level: 'warn', ttl: 3000, key: 'alert-probe:test' })
  check('能把提醒事件发给插件页面', fired)
  await wait(900)

  const warnAttr = await shellAttr()
  const warnShadow = await shellShadow()
  check('warn 档位到达岛壳', warnAttr === 'warn', warnAttr || '(无 data-alert)')
  check('warn 档位有描边光晕', warnShadow !== 'none' && warnShadow.length > 0, warnShadow.slice(0, 80))

  await wait(2600)
  const afterAttr = await shellAttr()
  const afterShadow = await shellShadow()
  check('ttl 到期后档位被撤掉', afterAttr === '', afterAttr || '(已清空)')
  // 磨砂边界环常驻（白 hairline），提醒的彩色光晕必须消失
  check('ttl 到期后彩色光晕消失（只剩中性磨砂环）',
    /239, 68, 68|245, 158, 11/.test(afterShadow) === false && /255, 255, 255/.test(afterShadow),
    afterShadow.slice(0, 80))

  // critical 档位再验一次，确认不是只有 warn 生效。
  const fired2 = await fireAlert({ level: 'critical', ttl: 2000, key: 'alert-probe:critical' })
  check('能再次发出提醒', fired2)
  await wait(900)
  const critAttr = await shellAttr()
  check('critical 档位到达岛壳', critAttr === 'critical', critAttr || '(无 data-alert)')

  await wait(2400) // 等 critical 的 ttl 走完

  // 自定义颜色：光圈用 alert 传入的色值画（#22D3EE = rgb 34,211,238），不是 info 默认的 #60A5FA
  const firedColor = await fireAlert({ level: 'info', ttl: 30000, color: '#22D3EE' })
  check('能发带自定义颜色的提醒', firedColor)
  await wait(900)
  const colorAttr = await shellAttr()
  const colorShadow = await shellShadow()
  check('自定义颜色生效（描边不再是默认蓝）', colorAttr === 'info' && /211/.test(colorShadow) && !/96, 165, 250/.test(colorShadow), `${colorAttr} / ${colorShadow.slice(0, 60)}`)

  // 点击提醒 → 展开中岛，光圈跟随（不随 endAlert 撤掉）
  const view = require('electron').webContents.getAllWebContents().find(wc => wc.getURL().includes('alert-probe'))
  view.sendInputEvent({ type: 'mouseDown', x: 75, y: 20, button: 'left', clickCount: 1 })
  view.sendInputEvent({ type: 'mouseUp', x: 75, y: 20, button: 'left', clickCount: 1 })
  await wait(1400)
  const expanded = await js(`(() => { const s = document.querySelector('#host-root .island-shell'); return { mode: s.dataset.mode, alert: s.dataset.alert ?? '' } })()`)
  check('点击提醒展开为中岛', expanded.mode === 'expanded', expanded.mode)
  check('光圈跟随展开（中岛继续显示）', expanded.alert === 'info', expanded.alert || '(已撤)')

  // 收起 → 离开展开态，光圈撤掉
  view.send('host:event', { name: 'collapse', payload: {} })
  await wait(1400)
  const collapsed = await js(`(() => { const s = document.querySelector('#host-root .island-shell'); return { mode: s.dataset.mode, alert: s.dataset.alert ?? '' } })()`)
  check('收起后光圈撤掉', collapsed.mode === 'compact' && collapsed.alert === '', JSON.stringify(collapsed))

  const passed = results.filter(r => r.ok).length
  console.log('\n=== 临时消息视觉验收 ===')
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `   [${r.detail}]` : ''}`)
  console.log(`\n${passed}/${results.length} 通过`)
  app.exit(passed === results.length ? 0 : 1)
}

app.whenReady().then(main).catch((error) => { console.error(error); app.exit(1) })
