// 通知服务本地演示：在终端启动本地触发接口（真实回环端口）与模拟通知源，
// 通知经过统一管道时打印到控制台。壳层落地前用于验证与体验。
//
// 运行：npm run demo
//      （等价于 node --experimental-strip-types tools/notification-demo.ts）

import { randomUUID } from 'node:crypto'
import {
  LocalTriggerSource,
  MockNotificationSource,
  NotificationServiceImpl,
  isServiceFault,
} from '@activity-island/platform-services'

const PORT = 5720
// 演示用令牌：每次启动随机生成，仅本机回环有效
const TOKEN = `dev-${randomUUID().slice(0, 8)}`

const service = new NotificationServiceImpl()
const mock = new MockNotificationSource(service, { intervalMs: 10_000 })
const trigger = new LocalTriggerSource({ ingress: service, token: TOKEN })
service.registerSource(mock)
service.registerSource(trigger)

service.onEvent((record) => {
  const payload = record.event.payload
  console.log(`\n[进入历史] ${payload.appName} · ${payload.title}（${payload.level}）`)
  if (payload.body) console.log(`           ${payload.body}`)
  if (record.repeatCount > 0) console.log(`           重复推送已合并，累计 ${record.repeatCount + 1} 次`)
})

service.onAlert((alert) => {
  const payload = alert.event.payload
  console.log(`🔔 岛上提醒：${payload.title}（${payload.level}，停留 ${alert.ttlSeconds} 秒）`)
})

async function main(): Promise<void> {
  await mock.start()
  try {
    await trigger.start()
  } catch (cause) {
    if (isServiceFault(cause)) {
      console.warn(`⚠ 本地触发接口未能启动：${cause.message}`)
      console.warn('  模拟通知演示不受影响；如需接口演示请释放端口或修改 PORT。')
    } else {
      throw cause
    }
  }

  console.log('\n━━━ 通知服务演示 ━━━')
  console.log(`模拟来源：每 10 秒发送一条示例通知`)
  console.log(`本地触发：${trigger.status().detail ?? '未启动'}`)
  console.log(`访问令牌：${TOKEN}`)
  console.log('\n用另一条命令推一条通知试试（Git Bash）：')
  console.log(
    `curl -X POST http://127.0.0.1:${PORT}/api/v1/notifications \\` +
      `\n  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \\` +
      `\n  -d '{"title":"你好灵动岛","content":"来自 curl 的第一条通知","app":{"id":"demo","name":"演示"},"level":"warn"}'`,
  )
  console.log('\n按 Ctrl+C 退出')
}

async function shutdown(): Promise<void> {
  console.log('\n正在退出…')
  await service.stopAllSources()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
process.on('SIGBREAK', () => void shutdown())

main().catch((error) => {
  console.error('演示启动失败：', error)
  process.exit(1)
})
