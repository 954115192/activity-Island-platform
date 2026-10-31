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
