const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const handlers = {}
const elements = Object.fromEntries(['small', 's-badge', 's-title', 's-sub', 's-count', 'medium', 'app'].map(id => [id, {
  innerHTML: '', textContent: '', className: '', classList: { toggle() {} },
  addEventListener(name, callback) { handlers[`${id}:${name}`] = callback },
}]))
let modeChange
let intentChange
const island = {
  ready: Promise.resolve(),
  notifications: { snapshot: async () => ({ status: { totalRecords: 0 }, items: [] }), settingsAll: async () => ({}), onSettingsChange() {} },
  settings: { all: async () => ({}), onChange() {} },
  events: { on(name, callback) { handlers[name] = callback } },
  alert() {},
  onIntent(callback) { intentChange = callback },
  ui: { onModeChange(callback) { modeChange = callback } },
}
const window = { dynamicIsland: island, findVerificationCode: () => null }
const document = { getElementById: id => elements[id] }
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../modules/system-notifications/app.js'), 'utf8'), { window, document, setTimeout, Date, console })

const item = (id, title) => ({ id, app: '手机', title, content: '', ts: Date.now() })
const click = action => handlers['app:click']({ target: { closest: () => ({ getAttribute: () => action }) }, stopPropagation() {} })
const tick = () => new Promise(resolve => setImmediate(resolve))

;(async () => {
  await tick()
  handlers['notif:item'](item('1', '第一条'))
  handlers['notif:alert']({ id: '1' })
  assert.equal(elements['s-count'].hidden, true)
  handlers['notif:item'](item('2', '第二条'))
  handlers['notif:alert']({ id: '2' })
  assert.equal(elements['s-count'].textContent, '+1')
  assert.equal(elements['s-count'].hidden, false)
  handlers['notif:item']({ ...item('2', '第二条'), level: 'critical' })
  assert.equal(elements['s-count'].className, 's-count critical')
  modeChange('medium')
  assert.match(elements.medium.innerHTML, /第二条/)
  assert.match(elements.medium.innerHTML, /1 \/ 2/)
  await click('older')
  assert.match(elements.medium.innerHTML, /第一条/)
  handlers['notif:item'](item('3', '第三条'))
  assert.match(elements.medium.innerHTML, /第一条/)
  assert.match(elements.medium.innerHTML, /3 \/ 3/)
  await click('newer')
  assert.match(elements.medium.innerHTML, /第二条/)
  await click('newer')
  assert.match(elements.medium.innerHTML, /第三条/)
  modeChange('small')
  assert.equal(elements['s-title'].textContent, '第三条')
  assert.equal(elements['s-count'].hidden, true)
  handlers['notif:alert']({ id: '3' })
  handlers['notif:alert']({ id: '4' })
  assert.equal(elements['s-count'].textContent, '+1')
  intentChange({ kind: 'alert', key: 'system-notification', result: 'expired' })
  assert.equal(elements['s-count'].hidden, true)
  handlers['notif:removed']({ clear: true })
  modeChange('medium')
  assert.match(elements.medium.innerHTML, /还没有捕获到新通知/)
  console.log('notification navigation passed')
})().catch(error => { console.error(error); process.exitCode = 1 })
