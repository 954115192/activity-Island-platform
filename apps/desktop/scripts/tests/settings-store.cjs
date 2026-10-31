const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { SettingsStore } = require('../../dist-electron/settings/store.js')
const { SettingsController } = require('../../dist-electron/settings/controller.js')

function fixture(t, initial) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'island-settings-store-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'nested', 'settings.json')
  if (initial !== undefined) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(initial)) }
  const store = new SettingsStore(file)
  const events = []
  const controller = new SettingsController(store, {
    pluginIds: () => ['a', 'b'],
    applyLayout: async change => { events.push(['layout', change, JSON.parse(fs.readFileSync(file, 'utf8')).islandTop]) },
    changed: snapshot => events.push(['changed', snapshot]),
    launchAtLogin: () => ({ ok: false, enabled: false, error: 'denied' }),
  })
  return { store, file, events, controller }
}

test('settings load normalizes old files without replacing the live value', t => {
  const { store } = fixture(t, { islandTop: 900, miniScale: 0.1, pluginOrder: ['a', 2], pluginModes: { a: 'resident', b: 'wrong' }, workbenchGrants: { a: ['run', 4] } })
  const value = store.value
  store.load()
  assert.equal(store.value, value)
  assert.equal(value.islandTop, 200)
  assert.equal(value.miniScale, 0.5)
  assert.deepEqual(value.pluginOrder, ['a'])
  assert.deepEqual(value.pluginModes, { a: 'resident' })
  assert.deepEqual(value.workbenchGrants, { a: ['run'] })
  assert.equal(value.checkUpdatesOnLaunch, true)
})

test('missing and malformed settings retain defaults; snapshots cannot mutate persisted collections', t => {
  const { store, file } = fixture(t)
  store.load()
  assert.equal(store.value.islandTop, 8)
  store.value.workbenchGrants = { a: ['run'] }
  const snapshot = store.snapshot()
  snapshot.pluginOrder.push('other')
  snapshot.workbenchGrants.a.push('http')
  assert.deepEqual(store.value.pluginOrder, [])
  assert.deepEqual(store.value.workbenchGrants.a, ['run'])
  store.save()
  fs.writeFileSync(file, '{bad json')
  store.load()
  assert.equal(store.value.islandTop, 8)
})

test('settings changes persist before relayout, then broadcast the resulting snapshot', async t => {
  const { controller, store, events, file } = fixture(t)
  const result = await controller.setTop(19.8)
  assert.equal(result.islandTop, 20)
  assert.equal(events[0][0], 'layout')
  assert.equal(events[0][2], 20)
  assert.equal(events[1][0], 'changed')
  await controller.setScale(9)
  assert.equal(store.value.miniScale, 1.5)
  await controller.setPluginOrder(['b', 'missing', 'b', 'a'])
  assert.deepEqual(store.value.pluginOrder, ['b', 'a'])
  await assert.rejects(controller.setIdleMode('invalid'), /unknown-idle-mode/)
  controller.setCheckUpdates(false)
  assert.equal(JSON.parse(fs.readFileSync(file)).checkUpdatesOnLaunch, false)
})

test('failed system startup change does not save or broadcast a false success', t => {
  const { controller, store, events, file } = fixture(t)
  assert.deepEqual(controller.setLaunchAtLogin(true), { ok: false, enabled: false, error: 'denied' })
  assert.equal(store.value.launchAtLogin, false)
  assert.equal(fs.existsSync(file), false)
  assert.deepEqual(events, [])
})
