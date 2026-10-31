const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const platform = require('../../dist-electron/shared/platform.js')
const { workbenchHttp, workbenchRun } = require('../../dist-electron/workbench/operations.js')

test('Electron facades share one platform runtime and error identity', async () => {
  for (const [file, symbol] of Object.entries({ service: 'NotificationServiceImpl', history: 'JsonFileHistoryStore', policy: 'DEFAULT_POLICY', 'local-trigger': 'LocalTriggerSource', 'local-trigger-node': 'NodeHttpTransport', 'service-fault': 'ServiceFault' })) {
    assert.equal(require(`../../dist-electron/notifications/${file}.js`)[symbol], platform[symbol])
  }
  await assert.rejects(() => new platform.NotificationServiceImpl().ingestEntry(null), platform.ServiceFault)
})

test('Workbench HTTP stops reading at the response limit', async () => {
  const limit = 2 * 1024 * 1024
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/plain' })
    response.end(Buffer.alloc(limit + 1000, 120))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const result = await workbenchHttp(`http://127.0.0.1:${server.address().port}`)
    assert.equal(result.ok, true)
    assert.equal(result.truncated, true)
    assert.equal(Buffer.byteLength(result.body), limit)
    const denied = await workbenchHttp('file:///secret')
    assert.equal(denied.ok, false)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})

test('Workbench command runner preserves exit status and arguments', async () => {
  const result = await workbenchRun(process.execPath, ['-e', 'process.stdout.write(process.argv[1]); process.exit(3)', 'hello world'])
  assert.equal(result.ok, false)
  assert.equal(result.code, 3)
  assert.equal(result.stdout, 'hello world')
})
