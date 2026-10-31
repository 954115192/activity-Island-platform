import test from 'node:test'
import assert from 'node:assert/strict'
import {
  InMemoryHistoryStore,
  MockNotificationSource,
  NotificationServiceImpl,
  ServiceFault,
} from '@activity-island/platform-services'
import type { NotificationAlert, NotificationPayload } from '@activity-island/platform-contracts'

interface FakeClock {
  clock: () => Date
  advance: (ms: number) => void
}

function createClock(): FakeClock {
  let current = Date.parse('2026-10-27T10:00:00Z')
  return {
    clock: () => new Date(current),
    advance: (ms) => {
      current += ms
    },
  }
}

let seq = 0

function payload(overrides: Partial<NotificationPayload> = {}): NotificationPayload {
  seq += 1
  return {
    sourceKind: 'windows',
    appId: 'com.example.app',
    appName: '示例应用',
    title: `通知 ${seq}`,
    body: '通知正文',
    level: 'info',
    ...overrides,
  }
}

function collectAlerts(service: NotificationServiceImpl): NotificationAlert[] {
  const alerts: NotificationAlert[] = []
  service.onAlert((alert) => alerts.push(alert))
  return alerts
}

test('ingest 生成标准事件并写入历史', async () => {
  const { clock } = createClock()
  const service = new NotificationServiceImpl({ clock })

  const event = await service.ingest(payload())

  assert.equal(event.type, 'notification.received')
  assert.equal(event.source, 'desktop')
  assert.equal(event.subject, 'com.example.app')
  assert.equal(event.sensitivity, 'private')
  assert.ok(event.eventId.length > 0)
  assert.equal(event.occurredAt, clock().toISOString())

  const page = await service.queryHistory()
  assert.equal(page.total, 1)
  assert.equal(page.items[0].event.eventId, event.eventId)
})

test('来源种类映射到事件来源字段', async () => {
  const service = new NotificationServiceImpl()
  assert.equal((await service.ingest(payload({ sourceKind: 'local-trigger' }))).source, 'external')
  assert.equal((await service.ingest(payload({ sourceKind: 'phone' }))).source, 'phone')
  assert.equal((await service.ingest(payload({ sourceKind: 'extension' }))).source, 'extension')
})

test('dedupeKey 在合并窗口内折叠为同一条通知', async () => {
  const { clock, advance } = createClock()
  const service = new NotificationServiceImpl({ clock })

  const first = await service.ingest(payload({ dedupeKey: 'build-128' }))
  const second = await service.ingest(payload({ dedupeKey: 'build-128', title: '重复推送' }))

  assert.equal(second.eventId, first.eventId)
  const page = await service.queryHistory()
  assert.equal(page.total, 1)
  assert.equal(page.items[0].repeatCount, 1)

  advance(61_000)
  const third = await service.ingest(payload({ dedupeKey: 'build-128' }))
  assert.notEqual(third.eventId, first.eventId)
})

test('暂停时不提醒，但历史照常保留', async () => {
  const service = new NotificationServiceImpl({ policy: { paused: true } })
  const alerts = collectAlerts(service)

  await service.ingest(payload())

  assert.equal(alerts.length, 0)
  assert.equal((await service.queryHistory()).total, 1)
})

test('忽略名单拦截提醒，历史保留', async () => {
  const service = new NotificationServiceImpl({ policy: { ignoreApps: ['示例'] } })
  const alerts = collectAlerts(service)

  await service.ingest(payload({ appId: 'com.example.noise', appName: '示例噪声' }))
  await service.ingest(payload({ appId: 'com.example.keep', appName: '其他应用' }))

  assert.equal(alerts.length, 1)
  assert.equal((await service.queryHistory()).total, 2)
})

test('允许名单为空表示全部允许，非空时只放行匹配项', async () => {
  const service = new NotificationServiceImpl({ policy: { allowApps: ['白名单'] } })
  const alerts = collectAlerts(service)

  await service.ingest(payload({ appName: '白名单应用' }))
  await service.ingest(payload({ appName: '无关应用' }))

  assert.equal(alerts.length, 1)
})

test('免打扰时段拦截普通级别，critical 按配置放行', async () => {
  // 用本地时间构造 02:30，免打扰 02:00–03:00
  const service = new NotificationServiceImpl({
    policy: { quietHoursEnabled: true, quietStart: '02:00', quietEnd: '03:00' },
    clock: () => new Date(2026, 9, 27, 2, 30),
  })
  const alerts = collectAlerts(service)

  await service.ingest(payload({ level: 'info' }))
  assert.equal(alerts.length, 0)

  await service.ingest(payload({ level: 'critical' }))
  assert.equal(alerts.length, 1)

  const daytime = new NotificationServiceImpl({
    policy: { quietHoursEnabled: true, quietStart: '02:00', quietEnd: '03:00' },
    clock: () => new Date(2026, 9, 27, 12, 0),
  })
  const daytimeAlerts = collectAlerts(daytime)
  await daytime.ingest(payload({ level: 'info' }))
  assert.equal(daytimeAlerts.length, 1)
})

test('历史查询支持搜索、级别与分页', async () => {
  const service = new NotificationServiceImpl()
  await service.ingest(payload({ title: '磁盘空间不足', body: 'C 盘剩余 8GB', level: 'warn' }))
  await service.ingest(payload({ title: '构建完成', appName: '流水线' }))
  await service.ingest(payload({ title: '备份已开始' }))

  const searched = await service.queryHistory({ search: '磁盘' })
  assert.equal(searched.total, 1)
  assert.equal(searched.items[0].event.payload.title, '磁盘空间不足')

  const warned = await service.queryHistory({ levels: ['warn'] })
  assert.equal(warned.total, 1)

  const paged = await service.queryHistory({ limit: 1, offset: 1 })
  assert.equal(paged.items.length, 1)
  assert.equal(paged.total, 3)
})

test('dismissHistory 标记撤回并广播事件', async () => {
  const service = new NotificationServiceImpl()
  const updates: number[] = []
  service.onEvent(() => updates.push(1))

  const event = await service.ingest(payload())
  assert.ok(await service.dismissHistory(event.eventId))
  assert.equal(await service.dismissHistory('not-exist'), false)

  const record = (await service.queryHistory()).items[0]
  assert.ok(record.dismissedAt)
  assert.equal(updates.length, 2) // 接入 + 撤回
})

test('保留上限裁掉最旧的记录', async () => {
  const service = new NotificationServiceImpl({ history: new InMemoryHistoryStore({ maxRecords: 2 }) })

  const first = await service.ingest(payload())
  await service.ingest(payload())
  await service.ingest(payload())

  const page = await service.queryHistory()
  assert.equal(page.total, 2)
  assert.ok(!page.items.some((record) => record.event.eventId === first.eventId))
})

test('sensitive 载荷不落历史，只保留摘要字段', async () => {
  const service = new NotificationServiceImpl()
  await service.ingest(payload({ raw: '<toast>原始 XML</toast>' }))

  const record = (await service.queryHistory()).items[0]
  assert.equal(record.event.sensitivity, 'sensitive')
  assert.equal(record.event.payload.raw, undefined)
})

test('自定义停留时长：默认值可设置，接口显式 ttl 优先', async () => {
  const service = new NotificationServiceImpl({ defaultTtl: { info: 30 } })
  const alerts = collectAlerts(service)

  await service.ingest(payload({ level: 'info' }))
  assert.equal(alerts[0].ttlSeconds, 30)

  // 运行中更新
  service.setDefaultTtl({ warn: 45 })
  await service.ingest(payload({ level: 'warn' }))
  assert.equal(alerts[1].ttlSeconds, 45)

  // 未设置的级别保持默认
  await service.ingest(payload({ level: 'critical' }))
  assert.equal(alerts[2].ttlSeconds, 15)

  // 接口载荷显式带 ttl 时优先于默认值
  await service.ingest(payload({ level: 'info', ttlSeconds: 5 }))
  assert.equal(alerts[3].ttlSeconds, 5)

  // 非法值被钳制
  service.setDefaultTtl({ info: 999 })
  await service.ingest(payload({ level: 'info' }))
  assert.equal(alerts[4].ttlSeconds, 300)
})

test('模拟来源经管道接入并写入历史', async () => {
  const service = new NotificationServiceImpl()
  const source = new MockNotificationSource(service)

  await source.start()
  assert.equal(source.status().state, 'running')

  const event = await source.emit({ title: '手工模拟通知' })
  assert.equal(event.source, 'desktop')
  assert.equal(event.payload.appId, 'com.example.mock')

  const page = await service.queryHistory()
  assert.equal(page.total, 1)
  assert.equal(page.items[0].event.eventId, event.eventId)

  await source.stop()
  assert.equal(source.status().state, 'stopped')
})

test('非法载荷抛出结构化错误', async () => {
  const service = new NotificationServiceImpl()
  await assert.rejects(service.ingest(payload({ title: '   ' })), (error: unknown) => {
    return error instanceof ServiceFault && error.code === 'invalid-request'
  })
  await assert.rejects(service.updatePolicy({ quietStart: '25:00' }), (error: unknown) => {
    return error instanceof ServiceFault && error.code === 'invalid-request'
  })
})

test('静默回填写入历史但不产生提醒，后续新通知正常提醒', async () => {
  const service = new NotificationServiceImpl()
  const alerts = collectAlerts(service)
  await service.ingestEntry(payload(), { suppressAlert: true })
  assert.equal((await service.queryHistory()).total, 1)
  assert.equal(alerts.length, 0)
  await service.ingestEntry(payload())
  assert.equal(alerts.length, 1)
})

test('服务重建后从历史恢复去重，持续重复使用滑动窗口', async () => {
  const time = createClock()
  const history = new InMemoryHistoryStore({ clock: time.clock })
  const first = new NotificationServiceImpl({ history, clock: time.clock })
  const input = payload({ dedupeKey: 'restart' })
  const original = await first.ingestEntry(input)
  time.advance(30_000)
  const restarted = new NotificationServiceImpl({ history, clock: time.clock })
  const alerts = collectAlerts(restarted)
  assert.equal((await restarted.ingestEntry(input)).event.eventId, original.event.eventId)
  time.advance(40_000)
  assert.equal((await restarted.ingestEntry(input)).deduped, true)
  assert.equal((await restarted.queryHistory()).total, 1)
  assert.equal(alerts.length, 0)
  time.advance(60_000)
  assert.equal((await restarted.ingestEntry(input)).deduped, false)
  assert.equal(alerts.length, 1)
})
