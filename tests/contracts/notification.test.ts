import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NOTIFICATION_CAPABILITIES,
  NOTIFICATION_CONTRACT_VERSION,
  NOTIFICATION_EVENT,
  type DomainEvent,
  type NotificationPayload,
} from '@activity-island/platform-contracts'

function samplePayload(): NotificationPayload {
  return {
    sourceKind: 'windows',
    appId: 'com.example.app',
    appName: '示例应用',
    title: '构建完成',
    body: 'main 分支 #128 通过。',
    level: 'info',
  }
}

function sampleEvent(): DomainEvent<NotificationPayload> {
  return {
    eventId: 'evt-1',
    type: NOTIFICATION_EVENT.received,
    version: NOTIFICATION_CONTRACT_VERSION,
    occurredAt: '2026-10-27T10:00:00.000Z',
    source: 'desktop',
    subject: 'com.example.app',
    sensitivity: 'private',
    payload: samplePayload(),
  }
}

test('通知事件类型统一使用 notification. 前缀且互不重复', () => {
  const values = Object.values(NOTIFICATION_EVENT)
  assert.ok(values.every((value) => value.startsWith('notification.')))
  assert.equal(new Set(values).size, values.length)
})

test('契约版本为正整数', () => {
  assert.ok(Number.isInteger(NOTIFICATION_CONTRACT_VERSION))
  assert.ok(NOTIFICATION_CONTRACT_VERSION > 0)
})

test('能力标识互不重复且使用 notifications 领域前缀', () => {
  const values = Object.values(NOTIFICATION_CAPABILITIES)
  assert.ok(values.every((value) => value.startsWith('notifications.')))
  assert.equal(new Set(values).size, values.length)
})

test('领域事件公共结构完整', () => {
  const event = sampleEvent()
  for (const field of ['eventId', 'type', 'version', 'occurredAt', 'source', 'sensitivity', 'payload']) {
    assert.ok(field in event, `缺少字段 ${field}`)
  }
  assert.ok(!Number.isNaN(Date.parse(event.occurredAt)))
  assert.ok(Number.isInteger(event.version))
})

test('通知载荷必需字段与取值范围合法', () => {
  const payload = samplePayload()
  assert.ok(['windows', 'local-trigger', 'phone', 'extension'].includes(payload.sourceKind))
  assert.ok(['info', 'warn', 'critical'].includes(payload.level))
  assert.ok(payload.appId.length > 0)
  assert.ok(payload.title.length > 0)
})

test('事件版本与通知契约版本一致', () => {
  assert.equal(sampleEvent().version, NOTIFICATION_CONTRACT_VERSION)
})
