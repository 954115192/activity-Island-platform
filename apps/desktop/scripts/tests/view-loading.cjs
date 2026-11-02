const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

function runtime(load = () => Promise.resolve()) {
  const views = [], windows = [], calls = []
  class Contents extends EventEmitter {
    destroyed = false
    sent = []
    isDestroyed() { return this.destroyed }
    isLoading() { return false }
    stop() {}
    close() { this.destroyed = true }
    send(...args) { if (this.destroyed) throw new Error('message after destruction'); this.sent.push(args) }
    setWindowOpenHandler() {}
    loadFile(file) { calls.push(file); return load(file, this) }
  }
  class View {
    constructor() { this.webContents = new Contents(); views.push(this) }
    setBackgroundColor() {}
    setVisible() {}
    setBounds() {}
  }
  class Window extends EventEmitter {
    constructor() {
      super(); this.webContents = new Contents(); this.destroyed = false
      this.contentView = { addChildView() {}, removeChildView() {}, getBounds: () => ({ width: 1000, height: 700 }) }
      windows.push(this)
    }
    isDestroyed() { return this.destroyed }
    focus() {}
    loadFile() { return Promise.resolve() }
  }
  function module(file) {
    const filename = path.resolve(__dirname, '../../dist-electron', file)
    const exports = {}
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      exports, module: { exports }, console, setTimeout, clearTimeout,
      require: id => id === 'electron' ? { WebContentsView: View, BrowserWindow: Window }
        : id === './ipc' ? { registerTransferIpc() {} } : require(id),
    }, { filename })
    return exports
  }
  return { views, windows, calls, module }
}
function workbench(load) {
  const mock = runtime(load), errors = [], adopted = []
  let descriptor = { manifest: { id: 'a', name: 'A' }, entryPath: 'a.html' }
  const owner = mock.module('workbench/view.js').createWorkbenchView({
    hostWindow: () => ({ isDestroyed: () => false }), resolve: () => descriptor,
    applyGrant() {}, adopt: view => adopted.push(view), log: (level, message) => { if (level === 'error') errors.push(message) },
  })
  return { ...mock, owner, errors, adopted, select: id => { descriptor = { manifest: { id, name: id }, entryPath: id + '.html' } } }
}

test('workbench cold callers wait for the same load and only reuse ready content', async () => {
  const gate = deferred(), fixture = workbench(() => gate.promise)
  const first = fixture.owner.ensure(), second = fixture.owner.ensure()
  assert.equal(first, second)
  let complete = false
  second.then(() => { complete = true })
  await tick()
  assert.equal(complete, false)
  assert.equal(fixture.calls.length, 1)
  gate.resolve()
  assert.equal(await first, await second)
  await fixture.owner.ensure()
  assert.equal(fixture.calls.length, 1)
})

test('superseded workbench navigation cannot mark the old target ready or retry it', async () => {
  const a = deferred(), b = deferred(), fixture = workbench(file => file === 'a.html' ? a.promise : b.promise)
  const first = fixture.owner.ensure()
  await tick()
  fixture.select('b')
  const second = fixture.owner.ensure()
  await tick()
  b.resolve()
  assert.equal(await second, fixture.owner.view)
  a.reject(new Error('ERR_ABORTED'))
  assert.equal(await first, null)
  await fixture.owner.ensure()
  assert.equal(fixture.calls.length, 2)
  assert.equal(fixture.errors.length, 0)
})

test('workbench terminal failure returns null and the next open really retries', async () => {
  let fail = true
  const fixture = workbench(() => fail ? Promise.reject(new Error('failed')) : Promise.resolve())
  assert.equal(await fixture.owner.ensure(), null)
  assert.equal(fixture.calls.length, 2)
  assert.equal(fixture.errors.length, 1)
  fail = false
  assert.equal(await fixture.owner.ensure(), fixture.owner.view)
  assert.equal(fixture.calls.length, 3)
})

test('workbench disposal cancels pending navigation and blocks recreation', async () => {
  const gate = deferred(), fixture = workbench(() => gate.promise)
  const pending = fixture.owner.ensure()
  await tick()
  fixture.owner.dispose()
  gate.reject(new Error('cancelled'))
  assert.equal(await pending, null)
  assert.equal(await fixture.owner.ensure(), null)
  assert.equal(fixture.views.length, 1)
  assert.equal(fixture.errors.length, 0)
})

function transfers(load) {
  const mock = runtime(load), errors = [], adoptions = []
  let serial = 0, layouts = 0, restored = 0
  const island = {
    cancelCollapse() {}, arbiter: { interrupt() {} }, clearPendingMiniReveal() {}, clearAlertCarry() {}, sendAlert() {}, hideWorkbench() {},
    beginTransition: () => ++serial, get transitionSerial() { return serial },
    stageOrigin: (width, height) => ({ x: 0, y: 0, width, height }), stageHitRegion: stage => stage,
    islandState: { patch() {} }, setHitRegion() {}, sendLayout() { layouts++ }, showRest: async () => { restored++ },
  }
  const owner = mock.module('transfers/panel.js').createTransferPanel({
    hostWindow: { isDestroyed: () => false }, views: { adoptTransfer: view => adoptions.push(view), setTransferStage() {} },
    service: { snapshot: () => ({}) }, island, layer: { show() {} }, appRoot: () => '.', sendHost() {}, reportError: message => errors.push(message),
  })
  return { ...mock, owner, errors, adoptions, layouts: () => layouts, restored: () => restored }
}

test('failed transfer load rolls back, releases the view and can be retried', async () => {
  let fail = true
  const fixture = transfers(() => fail ? Promise.reject(new Error('failed')) : Promise.resolve())
  await fixture.owner.open()
  assert.equal(fixture.owner.isOpen, false)
  assert.equal(fixture.owner.view, null)
  assert.equal(fixture.views[0].webContents.isDestroyed(), true)
  assert.equal(fixture.errors.length, 1)
  assert.equal(fixture.restored(), 1)
  fail = false
  await fixture.owner.open()
  assert.equal(fixture.owner.isOpen, true)
  assert.equal(fixture.calls.length, 2)
  assert.equal(fixture.layouts(), 1)
})

test('concurrent transfer opens share loading and apply the latest mode once', async () => {
  const gate = deferred(), fixture = transfers(() => gate.promise)
  const first = fixture.owner.open({ mode: 'files' })
  const second = fixture.owner.open({ mode: 'text', text: 'latest' })
  assert.equal(first, second)
  await tick()
  assert.equal(fixture.calls.length, 1)
  assert.equal(fixture.layouts(), 0)
  gate.resolve()
  await Promise.all([first, second])
  assert.equal(fixture.layouts(), 1)
  const modes = fixture.views[0].webContents.sent.filter(([channel]) => channel === 'transfers:open-mode')
  assert.equal(modes.length, 1)
  assert.equal(modes[0][1].text, 'latest')
})

test('hide then reopen during a pending transfer load cannot reveal an obsolete request', async () => {
  const gate = deferred(), fixture = transfers(() => gate.promise)
  const first = fixture.owner.open({ mode: 'files' })
  await tick()
  fixture.owner.hide()
  const second = fixture.owner.open({ mode: 'text' })
  gate.resolve()
  await Promise.all([first, second])
  assert.equal(fixture.calls.length, 1)
  assert.equal(fixture.layouts(), 1)
  assert.equal(fixture.owner.isOpen, true)
})

test('disposing a loading transfer panel produces neither a late layout nor an unhandled rejection', async () => {
  const gate = deferred(), fixture = transfers(() => gate.promise)
  const pending = fixture.owner.open()
  await tick()
  fixture.owner.dispose()
  gate.reject(new Error('cancelled'))
  await pending
  await fixture.owner.open()
  assert.equal(fixture.layouts(), 0)
  assert.equal(fixture.errors.length, 0)
  assert.equal(fixture.calls.length, 1)
})

function settings(t, load) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'island-panel-failure-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'settings.html'), '<html/>')
  const mock = runtime(load), errors = []
  const owner = mock.module('settings/windows.js').createSettingsWindows({
    preloadDirectory: directory, manager: { get: () => ({ rootDir: directory, manifest: { settings: 'settings.html' } }) },
    views: { helloPayloadFor: () => ({}) }, resources: { icon() {}, root: () => directory }, layer: { watch() {} }, reportError: error => errors.push(error),
  })
  return { ...mock, owner, errors }
}

test('custom settings failure is handled and retry creates a functioning page', async t => {
  let fail = true
  const fixture = settings(t, () => fail ? Promise.reject(new Error('failed')) : Promise.resolve())
  fixture.owner.openPanel('demo')
  await tick()
  assert.equal(fixture.owner.panel, null)
  assert.equal(fixture.errors.length, 1)
  assert.equal(fixture.views[0].webContents.isDestroyed(), true)
  fail = false
  fixture.owner.openPanel('demo')
  await tick()
  assert.equal(fixture.owner.panel.view.webContents.sent.length, 2)
})

test('closing or replacing a settings page cancels navigation without errors or late messages', async t => {
  const gate = deferred()
  let count = 0
  const fixture = settings(t, () => ++count === 1 ? gate.promise : Promise.resolve())
  fixture.owner.openPanel('old')
  fixture.owner.openPanel('new')
  gate.reject(new Error('ERR_ABORTED'))
  await tick()
  assert.equal(fixture.errors.length, 0)
  assert.equal(fixture.views[0].webContents.sent.length, 0)
  assert.equal(fixture.owner.panel.pluginId, 'new')
  fixture.owner.closePanel()
})
