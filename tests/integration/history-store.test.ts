import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonFileHistoryStore, NotificationServiceImpl } from '@activity-island/platform-services'
import type { NotificationPayload } from '@activity-island/platform-contracts'

const CLOCK = (): Date => new Date('2026-10-27T10:00:00Z')

let seq = 0

function payload(overrides: Partial<NotificationPayload> = {}): NotificationPayload {
  seq += 1
  return {
    sourceKind: 'windows',
    appId: 'com.example.app',
    appName: '示例应用',
    title: `持久化通知 ${seq}`,
    body: '正文',
    level: 'info',
    ...overrides,
  }
}

test('JSON 文件历史存储：落盘后可恢复', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'island-history-'))
  const filePath = join(directory, 'history.json')

  try {
    let idCounter = 0
    const first = new JsonFileHistoryStore({ filePath, clock: CLOCK })
    const writer = new NotificationServiceImpl({
      history: first,
      clock: CLOCK,
      idFactory: () => `evt-${(idCounter += 1)}`,
    })

    const keep = await writer.ingest(payload())
    await writer.ingest(payload())
    first.saveNow()

    const reopened = new JsonFileHistoryStore({ filePath, clock: CLOCK })
    assert.equal(reopened.size(), 2)
    assert.ok(reopened.get(keep.eventId))

    const reader = new NotificationServiceImpl({ history: reopened, clock: CLOCK })
    const page = await reader.queryHistory({ search: '持久化通知' })
    assert.equal(page.total, 2)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
