// Run the real host in an isolated profile, invoke its tray Exit menu item,
// and let the parent verify that the entire Electron process actually ends.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const REPO = path.join(__dirname, '..', '..')

if (process.env.ISLAND_TRAY_QUIT_HELPER === '1') {
  const { app, BrowserWindow, Tray } = require('electron')
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'island-tray-quit-'))
  fs.mkdirSync(path.join(profile, 'plugins'))
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ idleMode: 'collapsed', islandTop: 5, miniScale: 1, pluginOrder: [] }))
  app.setPath('userData', profile)

  let trayMenu = null
  const setContextMenu = Tray.prototype.setContextMenu
  Tray.prototype.setContextMenu = function (menu) {
    trayMenu = menu
    return setContextMenu.call(this, menu)
  }
  // Real BrowserWindow.show() is necessary: the trigger strip must be visible
  // before Exit, so this covers the reported failure rather than a hidden host.
  require(path.join(REPO, 'dist-electron', 'main.js'))
  app.whenReady().then(async () => {
    const until = Date.now() + 10000
    while (Date.now() < until) {
      const host = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/dist/index.html'))
      if (host?.isVisible() && trayMenu) {
        const exit = trayMenu.items.find(item => item.label === '退出')
        if (!exit) throw new Error('Tray Exit item missing')
        console.log('EXIT_CLICKED visibleHost=' + host.isVisible())
        exit.click()
        // This timer is unrefed: an actually quitted app can leave immediately.
        setTimeout(() => { console.error('FAIL Electron stayed alive after Exit'); process.exit(2) }, 3000).unref()
        return
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error('Visible trigger strip or tray not ready')
  }).catch(error => { console.error(error); app.exit(1) })
} else {
  const electron = require('electron')
  const child = spawn(electron, [__filename], { cwd: REPO, env: { ...process.env, ISLAND_TRAY_QUIT_HELPER: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }, windowsHide: true })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const timeout = setTimeout(() => { child.kill(); console.error('FAIL Electron did not exit within 12s'); process.exitCode = 1 }, 12000)
  child.on('close', code => {
    clearTimeout(timeout)
    process.stdout.write(output)
    const ok = code === 0 && output.includes('EXIT_CLICKED visibleHost=true')
    console.log(`${ok ? 'PASS' : 'FAIL'} tray Exit terminates the visible host process (code ${code})`)
    if (!ok) process.exitCode = 1
  })
}
