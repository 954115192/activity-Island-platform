import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LOCAL_TRIGGER_DEFAULTS,
  LocalTriggerSource,
  NodeHttpTransport,
  NotificationServiceImpl,
  handleLocalTriggerRequest,
  hostForScope,
  type LocalHttpRequest,
  type LocalHttpResponse,
} from '@activity-island/platform-services'

const TOKEN = 'secret-token'

interface Setup {
  service: NotificationServiceImpl
  deps: {
    ingress: NotificationServiceImpl
    resolveToken: () => Promise<string>
    maxBodyBytes: number
  }
}

function setup(maxBodyBytes = LOCAL_TRIGGER_DEFAULTS.maxBodyBytes): Setup {
  const service = new NotificationServiceImpl()
  return {
    service,
    deps: {
      ingress: service,
      resolveToken: async () => TOKEN,
      maxBodyBytes,
    },
  }
}

function request(overrides: Partial<LocalHttpRequest> = {}): LocalHttpRequest {
  return {
    method: 'POST',
    path: '/api/v1/notifications',
    query: new URLSearchParams(),
    headers: {},
    body: Buffer.alloc(0),
    ...overrides,
  }
}

function authorized(body: string, overrides: Partial<LocalHttpRequest> = {}): LocalHttpRequest {
  return request({
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: Buffer.from(body, 'utf8'),
    ...overrides,
  })
}

async function body(response: LocalHttpResponse): Promise<Record<string, any>> {
  return JSON.parse(response.body ?? '{}') as Record<string, any>
}

test('health 不需要认证且不返回数据', async () => {
  const { deps } = setup()
  const response = await handleLocalTriggerRequest(request({ method: 'GET', path: '/api/v1/health' }), deps)
  assert.equal(response.status, 200)
  const data = await body(response)
  assert.equal(data.ok, true)
  assert.equal(data.contractVersion, 1)
  assert.equal((data as Record<string, unknown>).history, undefined)
})

test('缺少或错误的令牌返回 401', async () => {
  const { deps } = setup()
  const noAuth = await handleLocalTriggerRequest(request({ body: Buffer.from('{"title":"t"}') }), deps)
  assert.equal(noAuth.status, 401)

  const wrongAuth = await handleLocalTriggerRequest(
    authorized('{"title":"t"}', { headers: { authorization: 'Bearer wrong' } }),
    deps,
  )
  assert.equal(wrongAuth.status, 401)
})

test('POST JSON 通知返回 202 并进入历史', async () => {
  const { service, deps } = setup()
  const response = await handleLocalTriggerRequest(
    authorized(JSON.stringify({ title: '构建完成', content: '用时 42 秒', app: { id: 'ci', name: 'CI 机器人' }, level: 'warn' })),
    deps,
  )
  assert.equal(response.status, 202)
  const data = await body(response)
  assert.equal(data.ok, true)
  assert.ok(typeof data.eventId === 'string')

  const page = await service.queryHistory()
  assert.equal(page.total, 1)
  const record = page.items[0]
  assert.equal(record.event.source, 'external')
  assert.equal(record.event.payload.appId, 'ci')
  assert.equal(record.event.payload.appName, 'CI 机器人')
  assert.equal(record.event.payload.level, 'warn')
})

test('字段别名与查询串兜底生效', async () => {
  const { service, deps } = setup()

  await handleLocalTriggerRequest(
    authorized(JSON.stringify({ name: '别名标题', message: '别名正文' })),
    deps,
  )
  const record = (await service.queryHistory()).items[0]
  assert.equal(record.event.payload.title, '别名标题')
  assert.equal(record.event.payload.body, '别名正文')

  await handleLocalTriggerRequest(
    authorized('', { query: new URLSearchParams('title=查询标题&content=查询正文') }),
    deps,
  )
  const latest = (await service.queryHistory()).items[0]
  assert.equal(latest.event.payload.title, '查询标题')
  assert.equal(latest.event.payload.body, '查询正文')
})

test('form 与纯文本请求按宽松规则解析', async () => {
  const { service, deps } = setup()

  await handleLocalTriggerRequest(
    request({
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: Buffer.from('title=表单标题&content=表单正文'),
    }),
    deps,
  )
  const formRecord = (await service.queryHistory()).items[0]
  assert.equal(formRecord.event.payload.title, '表单标题')

  await handleLocalTriggerRequest(
    authorized('', { headers: { authorization: `Bearer ${TOKEN}` }, body: Buffer.from('第一行标题\n第二行正文') }),
    deps,
  )
  const textRecord = (await service.queryHistory()).items[0]
  assert.equal(textRecord.event.payload.title, '第一行标题')
  assert.equal(textRecord.event.payload.body, '第二行正文')
})

test('dedupeKey 在接口层同样生效', async () => {
  const { deps } = setup()
  const first = await handleLocalTriggerRequest(authorized('{"title":"一次","dedupeKey":"job-1"}'), deps)
  const second = await handleLocalTriggerRequest(authorized('{"title":"两次","dedupeKey":"job-1"}'), deps)

  assert.equal((await body(first)).deduped, false)
  assert.equal((await body(second)).deduped, true)
  assert.equal((await body(second)).eventId, (await body(first)).eventId)
})

test('缺少标题与正文返回 400，超限返回 413', async () => {
  const { deps } = setup()
  const empty = await handleLocalTriggerRequest(authorized('{}'), deps)
  assert.equal(empty.status, 400)

  const limited = setup(16)
  const oversized = await handleLocalTriggerRequest(
    authorized('{"title":"这个标题超过了十六个字节的限制"}'),
    limited.deps,
  )
  assert.equal(oversized.status, 413)
})

test('DELETE 撤回通知，再次撤回返回 404', async () => {
  const { service, deps } = setup()
  const created = await handleLocalTriggerRequest(authorized('{"title":"待撤回"}'), deps)
  const eventId = (await body(created)).eventId as string

  const deleted = await handleLocalTriggerRequest(
    request({ method: 'DELETE', path: `/api/v1/notifications/${eventId}`, headers: { authorization: `Bearer ${TOKEN}` } }),
    deps,
  )
  assert.equal(deleted.status, 200)

  const record = (await service.queryHistory()).items[0]
  assert.ok(record.dismissedAt)

  const again = await handleLocalTriggerRequest(
    request({ method: 'DELETE', path: `/api/v1/notifications/${eventId}`, headers: { authorization: `Bearer ${TOKEN}` } }),
    deps,
  )
  assert.equal(again.status, 404)
})

test('未知路径 404，不支持的方法 405', async () => {
  const { deps } = setup()
  assert.equal((await handleLocalTriggerRequest(request({ method: 'GET', path: '/api/v1/unknown' }), deps)).status, 404)
  assert.equal(
    (await handleLocalTriggerRequest(request({ method: 'PUT', path: '/api/v1/notifications' }), deps)).status,
    405,
  )
  assert.equal(
    (await handleLocalTriggerRequest(request({ method: 'OPTIONS', path: '/api/v1/notifications' }), deps)).status,
    405,
  )
})

test('Node 传输端到端：真实端口接收推送', async () => {
  const { service, deps } = setup()
  const transport = new NodeHttpTransport()
  transport.onRequest((incoming) => handleLocalTriggerRequest(incoming, deps))
  const { actualPort } = await transport.listen({ host: '127.0.0.1', port: 0 })

  try {
    const response = await fetch(`http://127.0.0.1:${actualPort}/api/v1/notifications`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: '端到端通知', content: '通过真实回环端口送达' }),
    })
    assert.equal(response.status, 202)
    assert.equal(((await response.json()) as { ok: boolean }).ok, true)
    assert.equal((await service.queryHistory()).total, 1)
  } finally {
    await transport.close()
  }
})

test('JSON 里的数字 ttl 与 level 正常解析', async () => {
  const { service, deps } = setup()
  const response = await handleLocalTriggerRequest(
    authorized(JSON.stringify({ title: '数字字段', ttl: 20, level: 'warn' })),
    deps,
  )
  assert.equal(response.status, 202)
  const record = (await service.queryHistory()).items[0]
  assert.equal(record.event.payload.ttlSeconds, 20)
  assert.equal(record.event.payload.level, 'warn')
})

test('LocalTriggerSource 生命周期与状态', async () => {
  const { service } = setup()
  const source = new LocalTriggerSource({ ingress: service, token: TOKEN, port: 0 })

  assert.equal(source.status().state, 'stopped')
  await source.start()
  assert.equal(source.status().state, 'running')
  assert.match(source.status().detail ?? '', /http:\/\/127\.0\.0\.1:\d+/)
  await source.stop()
  assert.equal(source.status().state, 'stopped')
})

test('局域网模式暴露网卡地址作为端点', async () => {
  const { service } = setup()
  const source = new LocalTriggerSource({
    ingress: service,
    token: TOKEN,
    port: 0,
    host: '0.0.0.0',
    displayHosts: ['192.168.1.5', '10.0.0.8'],
  })

  await source.start()
  const endpoints = source.endpointList()
  assert.equal(endpoints.length, 2)
  assert.match(endpoints[0], /^http:\/\/192\.168\.1\.5:\d+\/api\/v1\/notifications$/)
  assert.match(endpoints[1], /^http:\/\/10\.0\.0\.8:\d+\/api\/v1\/notifications$/)
  await source.stop()
  assert.deepEqual(source.endpointList(), [])
})

test('本机模式只暴露回环端点', async () => {
  const { service } = setup()
  const source = new LocalTriggerSource({ ingress: service, token: TOKEN, port: 0, host: '127.0.0.1' })
  await source.start()
  assert.match(source.endpointList()[0], /^http:\/\/127\.0\.0\.1:\d+/)
  await source.stop()
})

test('hostForScope 映射可访问范围', () => {
  assert.equal(hostForScope('local'), '127.0.0.1')
  assert.equal(hostForScope('lan'), '0.0.0.0')
})
