const test = require('node:test')
const assert = require('node:assert/strict')
const { createIslandController } = require('../../dist-electron/island/controller.js')
const { defaultIslandSettings } = require('../../dist-electron/settings/store.js')
const { EventBus } = require('../../dist-electron/events/event-bus.js')

function controller(messages) {
  return createIslandController({
    settings: defaultIslandSettings(), events: new EventBus(),
    host: { window: null, views: null, logger: null, layer: {}, send: (channel, payload) => messages.push({ channel, payload }) },
    plugins: { hidden: new Set(), tools: {}, ordered: () => [], get: () => undefined, list: () => [] },
    workbench: {},
    transfers: { dragging: false, open: false, progressVisible: false, hide() {}, showProgress: () => false },
    mediaKey() {},
  })
}

test('island instances own independent state and transition generations', () => {
  const first = controller([]), second = controller([])
  assert.equal(first.beginTransition(), 1)
  assert.equal(first.beginTransition(), 2)
  assert.equal(second.transitionSerial, 0)
  first.islandState.patch({ pointerInside: true })
  assert.equal(second.islandState.value.pointerInside, false)
})

test('renderer recovery preserves the current custom alert color', () => {
  const messages = [], island = controller(messages)
  island.sendAlert('info', '#22d3ee')
  island.restoreRenderer()
  assert.deepEqual(messages.at(-1), { channel: 'host:alert', payload: { level: 'info', color: '#22d3ee' } })
  island.sendAlert(null)
  island.restoreRenderer()
  assert.equal(messages.at(-1).payload, null)
})

const { createIslandPointer } = require('../../dist-electron/island/pointer.js')
const { createIslandTransitions } = require('../../dist-electron/island/transitions.js')
const { IslandState } = require('../../dist-electron/island/island-state.js')

test('pointer policy respects rounded corners and overlapping auxiliary windows', async () => {
  const state = new IslandState(), messages = [], shown = []
  let point = { x: 150, y: 150 }, overlap = false
  const pointer = createIslandPointer({
    window: { isDestroyed: () => false, getBounds: () => ({ x: 100, y: 100 }), setIgnoreMouseEvents() {} },
    layer: { hidden: false, contains: () => overlap },
    transferOpen: false, dragging: false, alertActive: false,
    settings: defaultIslandSettings(), state, arbiter: { releaseFocus() {} }, cursor: () => point,
    send: (...args) => messages.push(args), cancelCollapse() {}, scheduleTransientCollapse() {},
    showCompact: async value => { shown.push(['compact', value]) }, showIdle: async value => { shown.push(['idle', value]) },
  })
  pointer.setRegion({ x: 0, y: 0, width: 100, height: 100, radius: 20 }, false)
  assert.equal(pointer.contains(100, 100), false)
  assert.equal(pointer.contains(150, 150), true)
  pointer.update()
  assert.equal(state.value.pointerInside, true)
  assert.deepEqual(shown, [['idle', true]])
  overlap = true
  pointer.update()
  assert.equal(state.value.pointerInside, false)
  assert.equal(messages.at(-1)[1], false)
  pointer.dispose()
  point = { x: 180, y: 180 }; overlap = false
  pointer.update()
  assert.equal(state.value.pointerInside, false)
})

test('transition timers recheck eligibility, cancel on disposal, and hide a workbench only once', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let eligible = true, collapsed = 0, hidden = 0
  const transitions = createIslandTransitions({
    canScheduleCollapse: () => true, canCollapse: () => eligible,
    collapse() { collapsed++ }, hideWorkbench() { hidden++ },
  })
  transitions.scheduleCollapse()
  eligible = false
  t.mock.timers.tick(3000)
  assert.equal(collapsed, 0)
  eligible = true
  transitions.scheduleCollapse()
  t.mock.timers.tick(3000)
  assert.equal(collapsed, 1)
  transitions.deferWorkbenchHide()
  transitions.armWorkbenchHide(1000, 200)
  transitions.sample(500, false)
  assert.equal(hidden, 0)
  transitions.sample(439, false)
  transitions.sample(200, true)
  t.mock.timers.tick(900)
  assert.equal(hidden, 1)
  transitions.deferWorkbenchHide()
  transitions.scheduleCollapse()
  const token = transitions.begin()
  transitions.dispose()
  assert.notEqual(transitions.serial, token)
  t.mock.timers.tick(4000)
  assert.equal(hidden, 1)
  assert.equal(collapsed, 1)
})
