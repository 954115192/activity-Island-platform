const { app, BrowserWindow } = require('electron')
const { PluginViewManager } = require('../../dist-electron/plugins/plugin-view-manager.js')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'island-view-disposal-'))
app.setPath('userData', path.join(root, 'profile'))
process.on('unhandledRejection', error => { console.error(error); app.exit(1) })

app.whenReady().then(async () => {
  const entryPath = path.join(root, 'index.html')
  fs.writeFileSync(entryPath, '<!doctype html><title>Pending plugin</title>')
  const host = new BrowserWindow({ show: false })
  const manager = new PluginViewManager(host, { onEvent() {} })
  const descriptor = { manifest: { id: 'pending-plugin', name: 'Pending', version: '1.0.0', entry: 'index.html' }, rootDir: root, entryPath }
  const pending = manager.ensure(descriptor)
  // ensure has synchronously created the view but loadFile has not settled.
  assert.equal(manager.has('pending-plugin'), true)
  manager.dispose()
  assert.equal(await pending, null)
  assert.deepEqual(manager.list(), [])
  assert.equal(await manager.ensure(descriptor), null)
  manager.dispose()
  host.destroy()
  console.log('PASS pending plugin load is cancelled on dispose without resurrecting a view')
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
