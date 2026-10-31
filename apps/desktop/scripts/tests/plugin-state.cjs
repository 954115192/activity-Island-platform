const test = require('node:test')
const assert = require('node:assert/strict')
const { PluginToolState } = require('../../dist-electron/plugins/tool-state.js')
const { PluginReloader } = require('../../dist-electron/plugins/reloader.js')

test('plugin tools reject undeclared tools and invalid views, merge updates and clear runtime state', () => {
  const descriptor = { manifest: { id: 'demo', tools: [{ id: 'status', title: 'Status', view: { type: 'text', text: 'initial' } }] } }
  const changes = []
  const tools = new PluginToolState(id => id === 'demo' ? descriptor : undefined, (id, value) => changes.push({ id, value }))
  tools.update('other', 'status', { notice: 'wrong plugin' })
  tools.update('demo', 'missing', { notice: 'wrong tool' })
  tools.update('demo', 'status', { view: { type: { toString: () => 'text' } } })
  assert.equal(changes.length, 0)
  tools.update('demo', 'status', { notice: 'live' })
  assert.equal(tools.list('demo')[0].notice, 'live')
  assert.deepEqual(tools.list('demo')[0].view, { type: 'text', text: 'initial' })
  tools.update('demo', 'status', { notice: null })
  assert.equal(tools.list('demo')[0].notice, undefined)
  tools.clear('demo')
  assert.deepEqual(tools.list('demo'), descriptor.manifest.tools)
  assert.equal(descriptor.manifest.tools[0].updatedAt, undefined)
})

test('hot reload picks up services created after registration and suppresses sync-generated reloads', async () => {
  let manager = null, views = null
  let loads = 0, syncs = 0
  const plugin = { manifest: { id: 'demo' }, rootDir: 'installed' }
  const reloader = new PluginReloader({
    get manager() { return manager }, get views() { return views },
    background: null, watcher: null, logger: null,
    enabled: () => true, syncSettingsSchemas() {}, resetPlugin() {},
    refreshIsland: async () => {}, changed() {},
  })
  await reloader.reload('demo', 'source')
  manager = { syncFromSource() { syncs++; return true }, discover: () => [plugin] }
  views = { destroy() {}, ensure: async () => { loads++ } }
  await reloader.reload('demo', 'source')
  await reloader.reload('demo', 'installed')
  assert.equal(syncs, 1)
  assert.equal(loads, 1)
})

test('repeated installed-file events cannot cause an unbounded reload storm', async () => {
  let loads = 0, errors = 0
  const plugin = { manifest: { id: 'demo' } }
  const reloader = new PluginReloader({
    manager: { discover: () => [plugin] },
    views: { destroy() {}, ensure: async () => { loads++ } },
    background: null, watcher: null,
    logger: { append(_id, level) { if (level === 'error') errors++ } },
    enabled: () => true, syncSettingsSchemas() {}, resetPlugin() {},
    refreshIsland: async () => {}, changed() {},
  })
  for (let i = 0; i < 9; i++) await reloader.reload('demo', 'installed')
  assert.equal(loads, 8)
  assert.equal(errors, 1)
})

test('disposed hot reload cannot reattach watchers after an in-flight view load finishes', async () => {
  let finishLoad
  const pending = new Promise(resolve => { finishLoad = resolve })
  let watched = 0, refreshed = 0, changed = 0
  const reloader = new PluginReloader({
    manager: { discover: () => [{ manifest: { id: 'demo' } }], list: () => [] },
    views: { destroy() {}, ensure: () => pending },
    background: null, watcher: { watch() { watched++ } }, logger: null,
    enabled: () => true, syncSettingsSchemas() {}, resetPlugin() {},
    refreshIsland: async () => { refreshed++ }, changed() { changed++ },
  })
  const loading = reloader.reload('demo', 'installed')
  reloader.dispose()
  finishLoad(null)
  await loading
  reloader.watch()
  assert.deepEqual([watched, refreshed, changed], [0, 0, 0])
})
