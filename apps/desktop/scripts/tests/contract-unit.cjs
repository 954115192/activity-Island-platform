// 阶段 B 纯逻辑单测：跑编译产物，不需要 Electron。
const assert = require('node:assert/strict')
const { orderPlugins, pruneOrder, pluginPriority, DEFAULT_PRIORITY } = require('../../dist-electron/plugins/plugin-order.js')
const { fitMiniBar } = require('../../dist-electron/island/mini-bar.js')
const { IntentArbiter } = require('../../dist-electron/island/intent-arbiter.js')

const results = []
function test(name, fn) {
  try { fn(); results.push({ name, ok: true }) }
  catch (error) { results.push({ name, ok: false, detail: String(error && error.message || error) }) }
}
async function testAsync(name, fn) {
  try { await fn(); results.push({ name, ok: true }) }
  catch (error) { results.push({ name, ok: false, detail: String(error && error.message || error) }) }
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const plugin = (id, priority, name) => ({ manifest: { id, name: name ?? id, version: '1.0.0', entry: 'x', priority }, rootDir: '', entryPath: '' })

// ---------------------------------------------------------------- 排序
test('排序：priority 大的在前', () => {
  const list = orderPlugins([plugin('a', 10), plugin('b', 90), plugin('c', 50)])
  assert.deepEqual(list.map(p => p.manifest.id), ['b', 'c', 'a'])
})
test('排序：缺省 priority = 50', () => {
  assert.equal(pluginPriority(plugin('a', undefined)), DEFAULT_PRIORITY)
  const list = orderPlugins([plugin('low', 10), plugin('none', undefined)])
  assert.deepEqual(list.map(p => p.manifest.id), ['none', 'low'])
})
test('排序：用户顺序优先于 priority', () => {
  const list = orderPlugins([plugin('a', 90), plugin('b', 10), plugin('c', 50)], ['b', 'a'])
  assert.deepEqual(list.map(p => p.manifest.id), ['b', 'a', 'c'])
})
test('排序：同优先级按名字（zh-CN）', () => {
  const list = orderPlugins([plugin('x', 50, '乙'), plugin('y', 50, '甲')])
  assert.deepEqual(list.map(p => p.manifest.id), ['y', 'x'])
})
test('pruneOrder：丢掉已卸载并去重', () => {
  assert.deepEqual(pruneOrder(['a', 'gone', 'b', 'a'], ['a', 'b']), ['a', 'b'])
})

// ---------------------------------------------------------------- mini 条装箱
test('装箱：放得下就全保留', () => {
  const fit = fitMiniBar([{ pluginId: 'a', width: 150 }, { pluginId: 'b', width: 150 }], 8, 134, 1040, 34)
  assert.deepEqual(fit.kept.map(s => s.pluginId), ['a', 'b'])
  assert.equal(fit.dropped, 0)
})
test('装箱：超宽时按顺序丢尾部并留出 +N 宽度', () => {
  const segments = Array.from({ length: 10 }, (_, index) => ({ pluginId: `p${index}`, width: 150 }))
  const fit = fitMiniBar(segments, 8, 134, 500, 34)
  assert.ok(fit.dropped > 0, '应该丢一些')
  assert.ok(fit.kept.length + fit.dropped === 10)
  assert.ok(fit.contentWidth + 16 <= 500, `内容宽度 ${fit.contentWidth} 应该放得下`)
  assert.deepEqual(fit.kept.map(s => s.pluginId), segments.slice(0, fit.kept.length).map(s => s.pluginId))
})
test('装箱：单段本身就超宽也要保留一段', () => {
  const fit = fitMiniBar([{ pluginId: 'huge', width: 900 }], 8, 134, 500, 34)
  assert.deepEqual(fit.kept.map(s => s.pluginId), ['huge'])
})

// ---------------------------------------------------------------- 意图仲裁
function makeHarness(options = {}) {
  const calls = []
  const intents = []
  const host = {
    canAlert: () => options.canAlert?.() ?? true,
    showAlert: (alert) => calls.push(['showAlert', alert.pluginId, alert.key]),
    endAlert: () => calls.push(['endAlert']),
    grantFocus: (request) => { calls.push(['grantFocus', request.pluginId, request.view]); return options.hasView?.(request) ?? true },
    releaseFocus: () => calls.push(['releaseFocus']),
    sendIntent: (pluginId, message) => intents.push({ pluginId, ...message }),
  }
  return { arbiter: new IntentArbiter(host), calls, intents }
}

const main = async () => {
  // alert：基本 + ttl 到期
  await testAsync('alert：granted → ttl 到期 expired', async () => {
    const { arbiter, calls, intents } = makeHarness()
    arbiter.requestAlert({ pluginId: 'a', key: 'k1', level: 'warn', ttl: 1000 })
    assert.deepEqual(intents.at(-1), { pluginId: 'a', kind: 'alert', result: 'granted', key: 'k1' })
    assert.deepEqual(calls[0], ['showAlert', 'a', 'k1'])
    await wait(1150)
    assert.equal(intents.at(-1).result, 'expired')
    assert.ok(calls.some(call => call[0] === 'endAlert'))
    arbiter.dispose()
  })

  // alert：队列 + 同 key 覆盖
  await testAsync('alert：队列上限 3、同 key 覆盖、到期补位', async () => {
    const { arbiter, intents } = makeHarness()
    arbiter.requestAlert({ pluginId: 'a', key: 'k1', ttl: 1000 })
    arbiter.requestAlert({ pluginId: 'b', key: 'k1', ttl: 1000 })
    assert.equal(intents.at(-1).result, 'queued')
    arbiter.requestAlert({ pluginId: 'c', key: 'k1', ttl: 1000 })
    assert.equal(intents.at(-1).result, 'queued')
    arbiter.requestAlert({ pluginId: 'd', key: 'k1', ttl: 1000 })
    assert.equal(intents.at(-1).result, 'queued')
    arbiter.requestAlert({ pluginId: 'e', key: 'k1', ttl: 1000 })
    assert.deepEqual(intents.at(-1), { pluginId: 'e', kind: 'alert', result: 'denied', key: 'k1', reason: 'busy' })
    // 同 key 覆盖：不占新位置，重新计时
    arbiter.requestAlert({ pluginId: 'a', key: 'k1', ttl: 1000 })
    assert.equal(intents.at(-1).result, 'granted')
    await wait(1150)
    // a 到期后 b 补位
    assert.deepEqual(intents.filter(i => i.result === 'granted').map(i => i.pluginId), ['a', 'a', 'b'])
    arbiter.dispose()
  })

  // alert：岛不可用时排队，noteIdle 后放行
  await testAsync('alert：展开态占用时排队，noteIdle 后放行', async () => {
    let canAlert = false
    const { arbiter, intents } = makeHarness({ canAlert: () => canAlert })
    arbiter.requestAlert({ pluginId: 'a', key: 'k1', ttl: 1000 })
    assert.equal(intents.at(-1).result, 'queued')
    canAlert = true
    arbiter.noteIdle()
    assert.equal(intents.at(-1).result, 'granted')
    arbiter.dispose()
  })

  // alert：只有拥有者能撤销
  await testAsync('alert：只有拥有者能撤销', async () => {
    const { arbiter, intents } = makeHarness()
    arbiter.requestAlert({ pluginId: 'a', key: 'k1', ttl: 5000 })
    assert.equal(arbiter.dismissAlert('b'), false)
    assert.equal(arbiter.dismissAlert('a'), true)
    assert.equal(intents.at(-1).result, 'dismissed')
    arbiter.dispose()
  })

  // focus：granted → preempted
  await testAsync('focus：granted → 用户操作打断得到 preempted', async () => {
    const { arbiter, calls, intents } = makeHarness()
    arbiter.requestFocus({ pluginId: 'a', view: 'medium' })
    assert.deepEqual(intents.at(-1), { pluginId: 'a', kind: 'focus', result: 'granted', reason: undefined })
    arbiter.releaseFocus('preempted')
    assert.equal(intents.at(-1).result, 'preempted')
    assert.ok(calls.some(call => call[0] === 'releaseFocus'))
    arbiter.dispose()
  })

  // focus：排队 1 个，第三个被拒；释放后补位
  await testAsync('focus：队列 1、第三个 denied(busy)、释放后补位', async () => {
    const { arbiter, intents } = makeHarness()
    arbiter.requestFocus({ pluginId: 'a', view: 'medium' })
    arbiter.requestFocus({ pluginId: 'b', view: 'medium' })
    assert.equal(intents.at(-1).result, 'queued')
    arbiter.requestFocus({ pluginId: 'c', view: 'medium' })
    assert.deepEqual(intents.at(-1), { pluginId: 'c', kind: 'focus', result: 'denied', reason: 'busy' })
    arbiter.releaseFocus('self', 'a')
    assert.deepEqual(intents.at(-1), { pluginId: 'b', kind: 'focus', result: 'granted', reason: undefined })
    assert.equal(arbiter.focusedPluginId(), 'b')
    arbiter.dispose()
  })

  // focus：没有对应视图 → denied(no-view)
  await testAsync('focus：没有该视图 → denied(no-view)', async () => {
    const { arbiter, intents } = makeHarness({ hasView: (request) => request.view !== 'large' })
    arbiter.requestFocus({ pluginId: 'a', view: 'large' })
    assert.deepEqual(intents.at(-1), { pluginId: 'a', kind: 'focus', result: 'denied', reason: 'no-view' })
    arbiter.dispose()
  })

  // focus：独占优先于提醒
  await testAsync('focus：独占优先，正在显示的提醒收 preempted 且不放行队列', async () => {
    const { arbiter, intents } = makeHarness()
    arbiter.requestAlert({ pluginId: 'a', key: 'k1', ttl: 5000 })
    arbiter.requestAlert({ pluginId: 'b', key: 'k2', ttl: 5000 })
    arbiter.requestFocus({ pluginId: 'c', view: 'medium' })
    assert.deepEqual(intents.filter(i => i.kind === 'alert').map(i => `${i.pluginId}:${i.result}`), ['a:granted', 'b:queued', 'a:preempted'])
    assert.equal(intents.at(-1).kind, 'focus')
    assert.equal(intents.at(-1).result, 'granted')
    arbiter.dispose()
  })

  // 用户手动展开：抢占上一位独占者
  await testAsync('claimFocus：用户手动展开抢占上一位独占者', async () => {
    const { arbiter, intents } = makeHarness()
    arbiter.requestFocus({ pluginId: 'a', view: 'medium' })
    arbiter.claimFocus({ pluginId: 'b', view: 'medium', reason: 'user' })
    assert.deepEqual(intents.at(-1), { pluginId: 'a', kind: 'focus', result: 'preempted', reason: undefined })
    assert.equal(arbiter.focusedPluginId(), 'b')
    arbiter.dispose()
  })

  // interrupt：提醒与独占都让位
  await testAsync('interrupt：提醒与独占都让位（控制台打开）', async () => {
    const { arbiter, calls, intents } = makeHarness()
    arbiter.requestAlert({ pluginId: 'a', key: 'k1', ttl: 5000 })
    arbiter.requestFocus({ pluginId: 'a', view: 'medium' })
    arbiter.interrupt()
    assert.deepEqual(intents.filter(i => i.result === 'preempted').map(i => i.kind), ['alert', 'focus'])
    assert.ok(calls.some(call => call[0] === 'endAlert'))
    arbiter.dispose()
  })

  let failed = 0
  console.log('=== 阶段 B 单元测试 ===')
  for (const item of results) {
    if (!item.ok) failed += 1
    console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.detail ? `   [${item.detail}]` : ''}`)
  }
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  process.exit(failed ? 1 : 0)
}

main().catch((error) => { console.error(error); process.exit(1) })
