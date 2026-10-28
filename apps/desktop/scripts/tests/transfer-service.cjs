// 使用真实 HTTPS 与二进制文件验证 LocalSend v2；不依赖 Electron、网络多播或实体设备。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const https = require('node:https')
const { randomBytes, createHash } = require('node:crypto')
const { LocalSendService, safeFileName, isLocalAddress } = require('../../dist-electron/transfers/service.js')

const waitFor = async (predicate, timeout = 12000) => {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待传输状态超时')
    await new Promise(resolve => setTimeout(resolve, 30))
  }
}
async function pair(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'island-transfer-'))
  const services = []
  t.after(async () => { await Promise.all(services.map(s => s.stop())); await fs.rm(root, { recursive: true, force: true }) })
  for (const name of ['sender', 'receiver']) {
    const service = new LocalSendService({ baseDir: path.join(root, name), saveDirectory: path.join(root, name, 'files'), alias: name, port: 0, discovery: false, offerTimeoutMs: 1500 })
    services.push(service)
    await service.start()
    assert.equal(service.snapshot().status, 'running', service.snapshot().error)
  }
  const [sender, receiver] = services
  await sender.connect(`127.0.0.1:${receiver.snapshot().port}`)
  assert.equal(sender.snapshot().devices.length, 1)
  assert.equal(receiver.snapshot().devices.length, 1)
  return { sender, receiver, root, peer: sender.snapshot().devices[0].id }
}

function request(port, route, body, token) {
  return new Promise((resolve, reject) => {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))
    const req = https.request({ host: '127.0.0.1', port, path: '/api/localsend/v2' + route, method: 'POST', rejectUnauthorized: false, agent: false,
      headers: { 'Content-Type': token ? 'application/octet-stream' : 'application/json', 'Content-Length': bytes.length } }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') }))
    })
    req.on('error', reject)
    req.end(bytes)
  })
}

test('LocalSend：接受前不传文件；多文件、零字节、中文名、同名避让及 SHA-256', async t => {
  const { sender, receiver, root, peer } = await pair(t)
  const data = randomBytes(2 * 1024 * 1024 + 31)
  const source = path.join(root, '设计稿.bin')
  const empty = path.join(root, 'empty.txt')
  await fs.writeFile(source, data)
  await fs.writeFile(empty, '')
  await fs.writeFile(path.join(root, 'receiver', 'files', '设计稿.bin'), 'existing')
  await sender.selectFiles([source, empty])
  await sender.send(peer)
  await waitFor(() => receiver.snapshot().sessions.some(s => s.state === 'waiting'))
  assert.deepEqual(await fs.readdir(path.join(root, 'receiver', 'files')), ['设计稿.bin'])
  assert.equal(sender.snapshot().sessions[0].bytes, 0)
  receiver.accept(receiver.snapshot().sessions[0].id)
  await waitFor(() => sender.snapshot().sessions[0].state === 'completed')
  assert.equal(receiver.snapshot().sessions[0].state, 'completed')
  assert.deepEqual(await fs.readFile(path.join(root, 'receiver', 'files', '设计稿 (1).bin')), data)
  assert.equal(await fs.readFile(path.join(root, 'receiver', 'files', '设计稿.bin'), 'utf8'), 'existing')
  assert.equal((await fs.stat(path.join(root, 'receiver', 'files', 'empty.txt'))).size, 0)
  assert.equal(receiver.snapshot().sessions[0].bytes, data.length)
  assert.equal((await fs.readdir(path.join(root, 'receiver', 'files'))).some(f => f.endsWith('.part')), false)
})

test('LocalSend：拒绝与等待超时均不写文件', async t => {
  const { sender, receiver, root, peer } = await pair(t)
  const source = path.join(root, 'one.txt')
  await fs.writeFile(source, 'hello')
  await sender.selectFiles([source]); await sender.send(peer)
  await waitFor(() => receiver.snapshot().sessions.some(s => s.state === 'waiting'))
  receiver.reject(receiver.snapshot().sessions[0].id)
  await waitFor(() => sender.snapshot().sessions[0].state === 'rejected')
  assert.deepEqual(await fs.readdir(path.join(root, 'receiver', 'files')), [])
  await sender.selectFiles([source]); await sender.send(peer)
  await waitFor(() => sender.snapshot().sessions[0].state === 'rejected' || sender.snapshot().sessions[0].state === 'failed')
  assert.deepEqual(await fs.readdir(path.join(root, 'receiver', 'files')), [])
})

test('LocalSend：等待期间取消会通知接收端', async t => {
  const { sender, receiver, root, peer } = await pair(t)
  const source = path.join(root, 'cancel.txt')
  await fs.writeFile(source, 'cancel me')
  await sender.selectFiles([source]); const id = await sender.send(peer)
  await waitFor(() => receiver.snapshot().sessions.some(s => s.state === 'waiting'))
  sender.cancel(id)
  await waitFor(() => receiver.snapshot().sessions[0].state === 'cancelled')
  assert.equal(sender.snapshot().sessions[0].state, 'cancelled')
  assert.deepEqual(await fs.readdir(path.join(root, 'receiver', 'files')), [])
})

test('LocalSend：按公开协议独立客户端可接入；错误 token 和校验不通过不能落盘', async t => {
  const { receiver, root } = await pair(t)
  const port = receiver.snapshot().port
  const data = Buffer.from('actual content')
  const file = { id: 'f1', fileName: 'external.txt', size: data.length, fileType: 'text/plain', sha256: createHash('sha256').update('wrong content').digest('hex') }
  const prepare = request(port, '/prepare-upload', { info: { alias: 'External LocalSend', version: '2.0', fingerprint: 'unverified-peer', port: 53317, protocol: 'https', deviceType: 'mobile' }, files: { f1: file } })
  await waitFor(() => receiver.snapshot().sessions.some(s => s.state === 'waiting'))
  receiver.accept(receiver.snapshot().sessions[0].id)
  const accepted = await prepare
  assert.equal(accepted.status, 200)
  const query = new URLSearchParams({ sessionId: accepted.body.sessionId, fileId: 'f1', token: 'bad' })
  assert.equal((await request(port, '/upload?' + query, data, true)).status, 403)
  query.set('token', accepted.body.files.f1)
  assert.equal((await request(port, '/upload?' + query, data, true)).status, 422)
  assert.equal(receiver.snapshot().sessions[0].state, 'failed')
  assert.deepEqual(await fs.readdir(path.join(root, 'receiver', 'files')), [])
})

test('接收文件名不允许目录穿越、绝对路径和 Windows 特殊设备名', () => {
  for (const value of ['../x', 'a/b', 'a\\b', 'C:\\x', 'CON', 'nul.txt', 'x:stream', '.', '..', 'bad.']) assert.throws(() => safeFileName(value), value)
  assert.equal(safeFileName('中文 1.txt'), '中文 1.txt')
  assert.equal(isLocalAddress('8.8.8.8'), false)
  assert.equal(isLocalAddress('192.168.1.8'), true)
  assert.equal(isLocalAddress('192.168.1.999'), false)
})

test('传输摘要与设备证书重启后恢复；不保存源路径和会话令牌', async t => {
  const { sender, receiver, root, peer } = await pair(t)
  const source = path.join(root, 'persist.txt')
  await fs.writeFile(source, 'persist')
  await sender.selectFiles([source]); await sender.send(peer)
  await waitFor(() => receiver.snapshot().sessions.some(s => s.state === 'waiting'))
  receiver.reject(receiver.snapshot().sessions[0].id)
  await waitFor(() => sender.snapshot().sessions[0].state === 'rejected')
  const originalId = receiver.snapshot().devices[0].id
  await sender.stop()
  const stored = await fs.readFile(path.join(root,'sender','history.json'),'utf8')
  assert.equal(stored.includes(source), false)
  assert.equal(stored.includes('token'), false)
  const restarted = new LocalSendService({ baseDir:path.join(root,'sender'), saveDirectory:path.join(root,'sender','files'), port:0, discovery:false })
  t.after(() => restarted.stop())
  await restarted.start()
  assert.equal(restarted.snapshot().sessions[0].state, 'rejected')
  await restarted.connect(`127.0.0.1:${receiver.snapshot().port}`)
  assert.equal(receiver.snapshot().devices[0].id, originalId)
})
