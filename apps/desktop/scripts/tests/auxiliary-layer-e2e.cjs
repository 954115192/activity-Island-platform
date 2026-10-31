// 检查辅助窗口与小岛的置顶及重叠命中；模拟坐标和全屏事件，不改变用户的鼠标或窗口。
const electron = require('electron')
const { app, BrowserWindow } = electron
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const fullscreenModule = require('../../dist-electron/window/foreground-fullscreen.js')
let changeFullscreen
fullscreenModule.ForegroundFullscreenMonitor = class {
  constructor(_window, onChange) { changeFullscreen = onChange }
  start() {}
  stop() {}
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async (fn, timeout = 10000) => {
  const deadline = Date.now() + timeout
  while (!(await fn())) { if (Date.now() > deadline) throw new Error('窗口层级等待超时'); await wait(60) }
}

;(async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'island-aux-layer-'))
  await fs.mkdir(path.join(profile, 'plugin-data'), { recursive: true })
  await fs.writeFile(path.join(profile, 'settings.json'), JSON.stringify({ idleMode:'float', islandTop:8, miniScale:1, checkUpdatesOnLaunch:false }))
  await fs.writeFile(path.join(profile, 'plugin-data', 'system-notifications.json'), JSON.stringify({ __settings:{ windowsEnabled:false, localApiEnabled:false } }))
  app.setPath('userData', profile)
  await app.whenReady()
  let pointer = { x: -10000, y: -10000 }
  electron.screen.getCursorScreenPoint = () => pointer
  process.chdir(path.join(__dirname, '../..'))
  require('../../dist-electron/main.js')
  await until(() => BrowserWindow.getAllWindows().some(w => w.webContents.getURL().includes('dist/index.html')))
  const host = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('dist/index.html'))
  const hostJs = code => host.webContents.executeJavaScript(code)
  await until(() => hostJs('!!window.dynamicIslandHost'))
  await hostJs('window.dynamicIslandHost.openSettings()')
  await until(() => BrowserWindow.getAllWindows().some(w => w.webContents.getURL().includes('console-apps/settings/index.html')))
  const settings = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('console-apps/settings/index.html'))
  settings.setPosition(0, 200)
  await wait(200)
  assert.equal(host.isAlwaysOnTop(), true)
  assert.equal(settings.isAlwaysOnTop(), false)
  const rect = await hostJs('(() => { const r=document.querySelector(".island-shell").getBoundingClientRect(); return { x:r.x+r.width/2, y:r.y+r.height/2 } })()')
  const bounds = host.getBounds()
  pointer = { x: Math.round(bounds.x + rect.x), y: Math.round(bounds.y + rect.y) }
  await until(async () => (await hostJs('window.dynamicIslandHost.getState()')).pointerInside)
  host.focus()
  await wait(100)
  assert.equal(host.isAlwaysOnTop(), true)
  assert.equal(settings.isAlwaysOnTop(), false)
  // Settings is below the island and must not steal its overlapping hit area.
  settings.setPosition(pointer.x - 200, pointer.y - 20)
  await wait(200)
  assert.equal((await hostJs('window.dynamicIslandHost.getState()')).pointerInside, true)
  assert.equal(host.isAlwaysOnTop(), true)
  settings.setPosition(0, 200)
  await until(async () => (await hostJs('window.dynamicIslandHost.getState()')).pointerInside)
  // Another ordinary window can take focus while settings remains non-topmost.
  const ordinary = new BrowserWindow({ x: 0, y: 200, width: 320, height: 240, show: false })
  ordinary.show()
  ordinary.focus()
  await until(() => ordinary.isFocused())
  assert.equal(settings.isAlwaysOnTop(), false)
  assert.equal(host.isAlwaysOnTop(), true)
  ordinary.close()
  await settings.webContents.executeJavaScript('window.islandSettings.openNotificationHistory()')
  await until(() => BrowserWindow.getAllWindows().some(w => w.webContents.getURL().includes('system-notifications/history.html')))
  const history = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('system-notifications/history.html'))
  assert.equal(history.isAlwaysOnTop(), true)
  // The still-topmost history window keeps its existing overlap behavior.
  history.setPosition(pointer.x - 200, pointer.y - 20)
  await until(async () => !(await hostJs('window.dynamicIslandHost.getState()')).pointerInside)
  history.setPosition(0, 200)
  await until(async () => (await hostJs('window.dynamicIslandHost.getState()')).pointerInside)
  assert.equal(settings.isAlwaysOnTop(), false)
  assert.equal(typeof changeFullscreen, 'function')
  changeFullscreen(true)
  assert.equal(host.isVisible(), false)
  assert.equal(history.isAlwaysOnTop(), false)
  assert.equal(settings.isAlwaysOnTop(), false)
  await wait(250)
  changeFullscreen(false)
  await until(() => host.isVisible() && history.isAlwaysOnTop())
  assert.equal(host.isVisible(), true)
  assert.equal(host.isAlwaysOnTop(), true)
  assert.equal(history.isAlwaysOnTop(), true)
  assert.equal(settings.isAlwaysOnTop(), false)
  settings.close()
  await until(() => settings.isDestroyed())
  assert.equal(host.isAlwaysOnTop(), true)
  assert.equal(history.isAlwaysOnTop(), true)
  history.close()
  await until(() => history.isDestroyed())
  assert.equal(host.isAlwaysOnTop(), true)
  console.log('auxiliary and island stacking / overlap passed')
  app.exit(0)
})().catch(error => { console.error(error); app.exit(1) })
