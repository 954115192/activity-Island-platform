// Exercise the real island in a disposable profile, including the Windows
// Show Desktop shortcut. The second shortcut restores the user's desktop.
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const REPO = path.join(__dirname, '..', '..')
const POWERSHELL = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class IslandDesktopTest {
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
}
'@
[IslandDesktopTest]::keybd_event(0x5B, 0, 0, [UIntPtr]::Zero)
[IslandDesktopTest]::keybd_event(0x44, 0, 0, [UIntPtr]::Zero)
[IslandDesktopTest]::keybd_event(0x44, 0, 2, [UIntPtr]::Zero)
[IslandDesktopTest]::keybd_event(0x5B, 0, 2, [UIntPtr]::Zero)
`
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitUntil(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await delay(100)
  }
  return predicate()
}
function toggleDesktop() {
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(POWERSHELL, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10000 })
}
function bringToForeground(win) {
  const hwnd = process.arch === 'x64' ? Number(win.getNativeWindowHandle().readBigUInt64LE()) : win.getNativeWindowHandle().readUInt32LE()
  const script = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class IslandFocusTest {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
}
'@
[IslandFocusTest]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[IslandFocusTest]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
[void][IslandFocusTest]::SetForegroundWindow([IntPtr]${hwnd})
[Console]::WriteLine([IslandFocusTest]::GetForegroundWindow().ToInt64())
`
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10000 }).toString().trim() === String(hwnd)
}

if (process.env.ISLAND_VISIBILITY_HELPER === '1') {
  const { app, BrowserWindow } = require('electron')
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'island-visibility-'))
  fs.mkdirSync(path.join(profile, 'plugins'))
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ idleMode: 'collapsed', islandTop: 5, miniScale: 1, pluginOrder: [] }))
  app.setPath('userData', profile)
  require(path.join(REPO, 'dist-electron', 'main.js'))
  app.whenReady().then(async () => {
    let toggled = false
    try {
      const deadline = Date.now() + 10000
      let host
      while (Date.now() < deadline) {
        host = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/dist/index.html'))
        if (host?.isVisible()) break
        await delay(100)
      }
      if (!host?.isVisible()) throw new Error('Island did not become visible')
      const ordinary = new BrowserWindow({ width: 320, height: 240, show: true })
      await delay(500)
      ordinary.maximize()
      ordinary.focus()
      const foregroundMaximized = bringToForeground(ordinary)
      await delay(1100)
      const visibleMaximized = host.isVisible()
      console.log(JSON.stringify({ maximized: { islandVisible: visibleMaximized, foreground: foregroundMaximized } }))
      if (!foregroundMaximized) throw new Error('Could not focus maximized test window')
      if (!visibleMaximized) throw new Error('Maximized window hid the island')
      ordinary.setFullScreen(true)
      ordinary.focus()
      const foregroundFullscreen = bringToForeground(ordinary)
      const hiddenFullscreen = await waitUntil(() => !host.isVisible())
      console.log(JSON.stringify({ fullscreen: { islandHidden: hiddenFullscreen, foreground: foregroundFullscreen } }))
      if (!foregroundFullscreen) throw new Error('Could not focus fullscreen test window')
      if (!hiddenFullscreen) throw new Error('Fullscreen window left the island visible')
      ordinary.setFullScreen(false)
      const visibleAgain = await waitUntil(() => host.isVisible())
      console.log(JSON.stringify({ afterFullscreen: { islandVisible: visibleAgain } }))
      if (!visibleAgain) throw new Error('Island did not return after fullscreen')
      toggleDesktop()
      toggled = true
      await delay(1800)
      const islandVisible = host.isVisible() && !host.isMinimized()
      const ordinaryHidden = !ordinary.isVisible() || ordinary.isMinimized()
      console.log(JSON.stringify({ afterWinD: { islandVisible, ordinaryHidden, islandMinimized: host.isMinimized(), ordinaryMinimized: ordinary.isMinimized() } }))
      if (!ordinaryHidden) throw new Error('Win+D did not hide the ordinary window')
      if (!islandVisible) throw new Error('Win+D hid the island')
    } catch (error) {
      console.error(error)
      process.exitCode = 1
    } finally {
      if (toggled) { try { toggleDesktop() } catch (error) { console.error('Desktop restore failed', error) } }
      app.exit(process.exitCode || 0)
    }
  })
} else {
  const electron = require('electron')
  const child = spawn(electron, [__filename], { cwd: REPO, env: { ...process.env, ISLAND_VISIBILITY_HELPER: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }, windowsHide: true })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const timeout = setTimeout(() => { child.kill(); console.error('FAIL visibility test timed out'); process.exitCode = 1 }, 20000)
  child.on('close', code => {
    clearTimeout(timeout)
    process.stdout.write(output)
    if (code !== 0) process.exitCode = 1
  })
}
