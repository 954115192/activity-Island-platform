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
  assert.equal(sender.snapshot().sessions[0].preparedBytes, data.length)
  receiver.accept(receiver.snapshot().sessions[0].id)
  await waitFor(() => sender.snapshot().sessions[0].state === 'completed')
  assert.equal(receiver.snapshot().sessions[0].state, 'completed')
  assert.deepEqual(await fs.readFile(path.join(root, 'receiver', 'files', '设计稿 (1).bin')), data)
  assert.equal(await fs.readFile(path.join(root, 'receiver', 'files', '设计稿.bin'), 'utf8'), 'existing')
  assert.equal((await fs.stat(path.join(root, 'receiver', 'files', 'empty.txt'))).size, 0)
  assert.equal(receiver.snapshot().sessions[0].bytes, data.length)
  assert.equal((await fs.readdir(path.join(root, 'receiver', 'files'))).some(f => f.endsWith('.part')), false)
})

test('文件夹可超过 200 个文件，空目录有提示且保留文件相对路径', async t => {
  const { sender, receiver, root, peer } = await pair(t)
  const folder = path.join(root, '分享目录')
  await fs.mkdir(path.join(folder, '空目录'), { recursive: true })
  await fs.mkdir(path.join(folder, '子目录'), { recursive: true })
  await Promise.all(Array.from({ length: 205 }, (_, i) => fs.writeFile(path.join(folder, '子目录', `${i}.txt`), String(i))))
  await sender.selectFolders([folder])
  assert.equal(sender.snapshot().draft.length, 205)
  assert.match(sender.snapshot().draftNotice, /1 个空文件夹/)
  await sender.send(peer)
  await waitFor(() => receiver.snapshot().sessions.some(s => s.state === 'waiting'))
  const offer = receiver.snapshot().sessions[0]
  assert.equal(offer.files.length, 205)
  assert.ok(offer.files.some(f => f.fileName === '分享目录/子目录/0.txt'))
  receiver.accept(offer.id)
  await waitFor(() => sender.snapshot().sessions[0].state === 'completed', 30000)
  assert.equal(await fs.readFile(path.join(root, 'receiver', 'files', '分享目录', '子目录', '0.txt'), 'utf8'), '0')
  await assert.rejects(fs.stat(path.join(root, 'receiver', 'files', '分享目录', '空目录')), { code: 'ENOENT' })
  await assert.rejects(sender.selectFolders([path.join(folder, '空目录')]), /空文件夹不会传输/)
})

test('1000 个文件可以提交，超过上限时保留原草稿', async t => {
  const { sender, receiver, root, peer } = await pair(t)
  const folder = path.join(root, '批量')
  await fs.mkdir(folder)
  await Promise.all(Array.from({ length: 1000 }, (_, i) => fs.writeFile(path.join(folder, `${i}.txt`), '')))
  await sender.selectFolders([folder])
  assert.equal(sender.snapshot().draft.length, 1000)
  await fs.writeFile(path.join(folder, 'extra.txt'), '')
  await assert.rejects(sender.selectFolders([folder]), /最多传输 1000 个文件/)
  assert.equal(sender.snapshot().draft.length, 1000)
  await sender.send(peer)
  await waitFor(() => receiver.snapshot().sessions.some(s => s.state === 'waiting'))
  assert.equal(receiver.snapshot().sessions[0].files.length, 1000)
  receiver.reject(receiver.snapshot().sessions[0].id)
  await waitFor(() => sender.snapshot().sessions[0].state === 'rejected')
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

test('文件被拒绝后保留草稿，可重新发送并在成功后清理原草稿', async t => {
  const { sender, receiver, root, peer } = await pair(t)
  const source = path.join(root, '重试.txt')
  await fs.writeFile(source, 'retry')
  await sender.selectFiles([source])
  const id = await sender.send(peer)
  await waitFor(() => receiver.snapshot().sessions.some(s => s.state === 'waiting'))
  assert.equal(sender.snapshot().draft.length, 1)
  receiver.reject(receiver.snapshot().sessions[0].id)
  await waitFor(() => sender.snapshot().sessions.find(s => s.id === id).state === 'rejected')
  assert.equal(sender.snapshot().sessions.find(s => s.id === id).canRetry, true)
  const retryId = await sender.retrySend(id)
  await waitFor(() => receiver.snapshot().sessions.some(s => s.state === 'waiting'))
  receiver.accept(receiver.snapshot().sessions.find(s => s.state === 'waiting').id)
  await waitFor(() => sender.snapshot().sessions.find(s => s.id === retryId).state === 'completed')
  assert.equal(sender.snapshot().draft.length, 0)
  assert.equal(await fs.readFile(path.join(root, 'receiver', 'files', '重试.txt'), 'utf8'), 'retry')
})

test('文本被拒绝后可以重新发送，历史不存储正文或重试来源', async t => {
  const { sender, receiver, root, peer } = await pair(t)
  const text = '文本重试示例'
  const id = await sender.sendText(peer, text)
  await waitFor(() => receiver.snapshot().sessions.some(s => s.state === 'waiting'))
  receiver.reject(receiver.snapshot().sessions[0].id)
  await waitFor(() => sender.snapshot().sessions.find(s => s.id === id).state === 'rejected')
  const retryId = await sender.retrySend(id)
  await waitFor(() => receiver.snapshot().sessions.some(s => s.state === 'waiting'))
  receiver.accept(receiver.snapshot().sessions.find(s => s.state === 'waiting').id)
  await waitFor(() => sender.snapshot().sessions.find(s => s.id === retryId).state === 'completed')
  await sender.stop()
  const history = await fs.readFile(path.join(root, 'sender', 'history.json'), 'utf8')
  assert.equal(history.includes(text), false)
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

test('传输记录与设备证书重启后恢复；文件位置可定位且不保存会话令牌', async t => {
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
  assert.equal(Object.values(JSON.parse(stored).records[0].locations)[0], source)
  assert.equal(stored.includes('token'), false)
  const restarted = new LocalSendService({ baseDir:path.join(root,'sender'), saveDirectory:path.join(root,'sender','files'), port:0, discovery:false })
  t.after(() => restarted.stop())
  await restarted.start()
  assert.equal(restarted.snapshot().sessions[0].state, 'rejected')
  assert.equal(await restarted.locationFor(restarted.snapshot().sessions[0].id), source)
  await fs.unlink(source)
  await assert.rejects(restarted.locationFor(restarted.snapshot().sessions[0].id), /已移动或删除/)
  await restarted.connect(`127.0.0.1:${receiver.snapshot().port}`)
  assert.equal(receiver.snapshot().devices[0].id, originalId)
})

test('接收目录被删除后自动重建并保存文件', async t => {
  const { sender, receiver, root, peer } = await pair(t)
  const dir = path.join(root, 'receiver', 'files')
  await fs.rm(dir, { recursive: true })
  const source = path.join(root, '恢复目录.txt')
  await fs.writeFile(source, 'ok')
  await sender.selectFiles([source]); await sender.send(peer)
  await waitFor(() => receiver.snapshot().sessions.some(s => s.state === 'waiting'))
  await fs.rm(dir, { recursive: true })
  receiver.accept(receiver.snapshot().sessions[0].id)
  await waitFor(() => sender.snapshot().sessions[0].state === 'completed')
  const record = receiver.snapshot().sessions[0]
  assert.equal(await receiver.locationFor(record.id, record.files[0].id), path.join(dir, '恢复目录.txt'))
  assert.equal(await fs.readFile(path.join(dir, '恢复目录.txt'), 'utf8'), 'ok')
})

test('对方提前返回取消响应时停止上传，不等待响应正文结束', async t => {
  const { sender, receiver, root, peer } = await pair(t)
  const server = receiver.server
  const handler = server.listeners('request')[0]
  server.removeAllListeners('request')
  server.on('request', (req, res) => {
    if (req.url.startsWith('/api/localsend/v2/upload?')) {
      res.writeHead(403)
      res.write('cancelled')
      setTimeout(() => { if (!res.destroyed) res.end() }, 3000).unref()
      req.resume()
    } else handler(req, res)
  })
  const source = path.join(root, 'large.bin')
  await fs.writeFile(source, randomBytes(24 * 1024 * 1024))
  await sender.selectFiles([source]); const id = await sender.send(peer)
  await waitFor(() => receiver.snapshot().sessions.some(s => s.state === 'waiting'))
  receiver.accept(receiver.snapshot().sessions[0].id)
  await waitFor(() => sender.snapshot().sessions.find(s => s.id === id).state === 'failed', 2000)
  const result = sender.snapshot().sessions.find(s => s.id === id)
  assert.match(result.error, /对方已取消或拒绝接收/)
  assert.ok(result.bytes < result.total, `${result.bytes} / ${result.total}`)
})

test('接收端在传输途中取消时，发送端停止读取和发送', async t => {
  const { sender, receiver, root, peer } = await pair(t)
  const source = path.join(root, 'slow.bin')
  await fs.writeFile(source, randomBytes(8 * 1024 * 1024))
  await sender.selectFiles([source]); const id = await sender.send(peer)
  await waitFor(() => receiver.snapshot().sessions.some(s => s.state === 'waiting'))
  const nodeFs = require('node:fs')
  const original = nodeFs.createReadStream
  const { Transform } = require('node:stream')
  nodeFs.createReadStream = (file, options) => file === source
    ? original(file, options).pipe(new Transform({ transform(chunk, _enc, callback) { setTimeout(() => callback(null, chunk), 10) } }))
    : original(file, options)
  t.after(() => { nodeFs.createReadStream = original })
  const incoming = receiver.snapshot().sessions[0].id
  receiver.accept(incoming)
  await waitFor(() => receiver.snapshot().sessions.find(s => s.id === incoming).bytes > 0)
  receiver.cancel(incoming)
  await waitFor(() => sender.snapshot().sessions.find(s => s.id === id).state === 'failed', 5000)
  const result = sender.snapshot().sessions.find(s => s.id === id)
  assert.ok(result.bytes < result.total)
  assert.equal((await fs.readdir(path.join(root, 'receiver', 'files'))).some(f => f.endsWith('.part')), false)
})

test('LocalSend：追加与逐项移除草稿；重复文件不重复，失败保留原选择', async t => {
  const { sender, root } = await pair(t)
  const first = path.join(root, 'first.txt')
  const second = path.join(root, 'second.txt')
  await fs.writeFile(first, 'first')
  await fs.writeFile(second, 'second')
  await sender.selectFiles([first])
  const firstId = sender.snapshot().draft[0].id
  await sender.selectFiles([first, second], true)
  assert.equal(sender.snapshot().draft.length, 2)
  assert.equal(sender.snapshot().draft[0].id, firstId)
  await assert.rejects(sender.selectFiles([path.join(root,'missing.txt')], true))
  assert.equal(sender.snapshot().draft.length, 2)
  sender.removeDraftFile(firstId)
  assert.deepEqual(sender.snapshot().draft.map(f => f.fileName), ['second.txt'])
  assert.equal('path' in sender.snapshot().draft[0], false)
  sender.clearDraft()
  assert.equal(sender.snapshot().draft.length, 0)
})

test('文本分享：LocalSend preview / 204，无 txt 落盘、保留文件草稿、正文不写历史', async t => {
  const { sender, receiver, root, peer } = await pair(t)
  const file = path.join(root, 'keep.txt')
  await fs.writeFile(file, 'keep')
  await sender.selectFiles([file])
  const text = '你好，灵动岛 🌏\nhttps://example.com/?a=1&b=2\n<script>不应执行</script>'
  await sender.sendText(peer, text)
  await waitFor(() => receiver.snapshot().sessions[0]?.state === 'waiting')
  const offer = receiver.snapshot().sessions[0]
  assert.equal(offer.files[0].kind, 'text')
  assert.equal(offer.files[0].preview, text)
  assert.throws(() => receiver.textForCopy(offer.id), /先接受/)
  receiver.accept(offer.id)
  await waitFor(() => sender.snapshot().sessions[0]?.state === 'completed')
  assert.equal(receiver.textForCopy(offer.id), text)
  assert.equal(receiver.snapshot().sessions[0].bytes, Buffer.byteLength(text))
  assert.deepEqual(await fs.readdir(path.join(root,'receiver','files')), [])
  assert.equal(sender.snapshot().draft[0].fileName, 'keep.txt')
  await sender.stop()
  await receiver.stop()
  for (const name of ['sender','receiver']) {
    const history = await fs.readFile(path.join(root,name,'history.json'),'utf8')
    assert.equal(history.includes('preview'), false)
    assert.equal(history.includes('不应执行'), false)
  }
  await assert.rejects(sender.sendText(peer, '   '))
  await assert.rejects(sender.sendText(peer, '字'.repeat(24000)), /64 KB/)
})

test('独立 LocalSend 文本客户端：完整预览 204、拒绝、部分预览上传后读正文', async t => {
  const { receiver, root } = await pair(t)
  const info = { alias:'LocalSend 手机', version:'2.0', fingerprint:'external-text', port:53317, protocol:'https', deviceType:'mobile' }
  const text = '第一行\n第二行 😊'
  const bytes = Buffer.from(text)
  const metadata = { id:'message', fileName:'message.txt', size:bytes.length, fileType:'text/plain', preview:text }
  let pending = request(receiver.snapshot().port, '/prepare-upload', { info, files:{ message:metadata } })
  await waitFor(() => receiver.snapshot().sessions[0]?.state === 'waiting')
  receiver.accept(receiver.snapshot().sessions[0].id)
  assert.equal((await pending).status, 204)
  assert.equal(receiver.textForCopy(receiver.snapshot().sessions[0].id), text)
  assert.deepEqual(await fs.readdir(path.join(root,'receiver','files')), [])
  pending = request(receiver.snapshot().port, '/prepare-upload', { info, files:{ message:metadata } })
  await waitFor(() => receiver.snapshot().sessions[0]?.state === 'waiting')
  receiver.reject(receiver.snapshot().sessions[0].id)
  assert.equal((await pending).status, 403)
  // 部分 preview 不应当作正文；接受后继续走正常 upload，校验完整字节。
  pending = request(receiver.snapshot().port, '/prepare-upload', { info, files:{ message:{...metadata, preview:'第一行'} } })
  await waitFor(() => receiver.snapshot().sessions[0]?.state === 'waiting')
  const id = receiver.snapshot().sessions[0].id
  receiver.accept(id)
  const reply = await pending
  assert.equal(reply.status, 200)
  const query = new URLSearchParams({sessionId:reply.body.sessionId,fileId:'message',token:reply.body.files.message})
  assert.equal((await request(receiver.snapshot().port, '/upload?'+query, bytes, true)).status, 200)
  assert.equal(receiver.textForCopy(id), text)
  assert.deepEqual(await fs.readdir(path.join(root,'receiver','files')), [])
  // 完整预览和声明的哈希不一致，不能直接确认成功。
  assert.equal((await request(receiver.snapshot().port, '/prepare-upload', { info, files:{message:{...metadata,sha256:'0'.repeat(64)}} })).status, 400)
})
