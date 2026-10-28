// LocalSend v2：设备发现、接收确认和流式传输。此服务不依赖 Electron 或页面生命周期。
import { EventEmitter } from 'node:events'
import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto'
import { createReadStream, createWriteStream, constants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import dgram from 'node:dgram'
import http from 'node:http'
import https from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TLSSocket } from 'node:tls'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import selfsigned from 'selfsigned'
import type { NearbyDevice, TransferFile, TransferSession, TransferSnapshot, TransferState } from './contracts'

const GROUP = '224.0.0.167'
const DEFAULT_PORT = 53317
const API = '/api/localsend/v2'
const MAX_FILES = 200
const TERMINAL = new Set<TransferState>(['completed', 'rejected', 'cancelled', 'failed'])
const digest = (value: string) => value.replace(/:/g, '').toUpperCase()
const remoteHost = (value = '') => value.replace(/^::ffff:/, '')
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

export function isLocalAddress(host: string): boolean {
  return /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
    && /^\d{1,3}(\.\d{1,3}){3}$/.test(host) && host.split('.').every(n => Number(n) <= 255)
}

export function safeFileName(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 240 || /[<>:"/\\|?*\x00-\x1f]/.test(value)
    || /[. ]$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value) || value === '.' || value === '..') {
    throw new Error('文件名不受支持；首版只接收文件，不接收文件夹')
  }
  return value
}

interface Pending {
  response: ServerResponse
  timer: NodeJS.Timeout
}
interface Active {
  record: TransferSession
  host: string
  fingerprint: string
  tokens: Map<string, string>
  received: Set<string>
  uploading: Set<string>
  controller: AbortController
  pending?: Pending
  paths: string[]
  directory: string
  activityAt: number
}
interface Options {
  baseDir: string
  saveDirectory: string
  alias?: string
  port?: number
  discovery?: boolean
  offerTimeoutMs?: number
}

export class LocalSendService extends EventEmitter {
  private server?: https.Server
  private udp?: dgram.Socket
  private timer?: NodeJS.Timeout
  private notifyTimer?: NodeJS.Timeout
  private identity?: { private: string; cert: string }
  private fingerprint = ''
  private devices = new Map<string, NearbyDevice>()
  private active = new Map<string, Active>()
  private draft: Array<TransferFile & { path: string }> = []
  private state: TransferSnapshot['status'] = 'stopped'
  private error?: string
  private port: number
  private alias: string
  private saveDirectory: string
  private stopping = false
  private starting?: Promise<void>
  private lastAnnounce = 0
  private historyWrite = Promise.resolve()
  private lastNetwork = ''

  constructor(private readonly options: Options) {
    super()
    this.port = options.port ?? DEFAULT_PORT
    this.alias = (options.alias || os.hostname()).slice(0, 60)
    this.saveDirectory = options.saveDirectory
  }

  snapshot(): TransferSnapshot {
    return {
      version: 1, alias: this.alias, port: this.port, addresses: this.addresses(),
      saveDirectory: this.saveDirectory, status: this.state, error: this.error,
      devices: [...this.devices.values()].filter(d => Date.now() - d.lastSeen < 75000).sort((a, b) => a.alias.localeCompare(b.alias)),
      draft: this.draft.map(({ path: _path, ...file }) => ({ ...file })),
      sessions: [...this.active.values()].map(a => ({ ...a.record, files: a.record.files.map(f => ({ ...f })) })).reverse(),
    }
  }

  private addresses(): string[] {
    return Object.values(os.networkInterfaces()).flatMap(list => (list ?? []).filter(i => i.family === 'IPv4' && !i.internal && isLocalAddress(i.address)).map(i => i.address))
  }

  start(): Promise<void> {
    if (this.state === 'running') return Promise.resolve()
    if (this.starting) return this.starting
    this.starting = this.startInternal().finally(() => { this.starting = undefined })
    return this.starting
  }

  private async startInternal(): Promise<void> {
    this.stopping = false
    this.state = 'starting'
    this.error = undefined
    this.changed()
    try {
      await fs.mkdir(this.options.baseDir, { recursive: true })
      await fs.mkdir(this.saveDirectory, { recursive: true })
      try {
        const config = JSON.parse(await fs.readFile(path.join(this.options.baseDir, 'settings.json'), 'utf8'))
        if (typeof config.alias === 'string' && config.alias.trim()) this.alias = config.alias.slice(0, 60)
        if (typeof config.saveDirectory === 'string' && path.isAbsolute(config.saveDirectory)) {
          await fs.mkdir(config.saveDirectory, { recursive: true })
          this.saveDirectory = config.saveDirectory
        }
      } catch { /* 首次启动使用默认配置。 */ }
      // 仅清理本功能创建且已过期的临时文件，不接触正式接收文件。
      for (const name of await fs.readdir(this.saveDirectory)) {
        if (!/^\.island-[a-f0-9-]+\.part$/.test(name)) continue
        const temporary = path.join(this.saveDirectory, name)
        const stat = await fs.lstat(temporary)
        if (stat.isFile() && !stat.isSymbolicLink() && Date.now() - stat.mtimeMs > 86400000) await fs.unlink(temporary).catch(() => {})
      }
      await this.loadIdentity()
      if (!this.active.size) {
        try {
          const history = JSON.parse(await fs.readFile(path.join(this.options.baseDir, 'history.json'), 'utf8'))
          for (const record of (history.version === 1 && Array.isArray(history.records) ? history.records : []).slice(0, 50).reverse()) {
            if (!TERMINAL.has(record.state) || typeof record.id !== 'string' || !Array.isArray(record.files)) continue
            this.active.set(record.id, { record, host: '', fingerprint: '', tokens: new Map(), received: new Set(), uploading: new Set(), controller: new AbortController(), paths: [], directory: '', activityAt: 0 })
          }
        } catch { /* 首次启动或损坏的历史不影响收发。 */ }
      }
      const server = https.createServer({ ...this.identity, key: this.identity!.private, requestCert: true, rejectUnauthorized: false }, (req, res) => {
        void this.handle(req, res).catch(error => {
          if (!res.headersSent) this.json(res, 400, { message: message(error) })
          else res.destroy()
        })
      })
      this.server = server
      server.headersTimeout = 15000
      server.requestTimeout = 0 // 大文件用空闲超时约束，不限制传输总时长。
      server.setTimeout(120000, socket => socket.destroy())
      const listen = (port: number) => new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '0.0.0.0', () => { server.off('error', reject); resolve() })
      })
      try { await listen(this.port) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || this.options.port !== undefined) throw error
        await listen(0) // 本机 LocalSend 已运行时共存；发现消息携带实际端口。
      }
      this.port = (server.address() as { port: number }).port
      server.on('error', error => { this.error = message(error); this.changed() })
      this.state = 'running'
      if (this.options.discovery !== false) await this.startDiscovery()
      this.timer = setInterval(() => {
        for (const [id, device] of this.devices) if (Date.now() - device.lastSeen > 75000) this.devices.delete(id)
        for (const active of this.active.values()) {
          if (active.record.direction === 'incoming' && active.record.state === 'transferring' && Date.now() - active.activityAt > 120000) this.update(active, 'failed', '对方长时间未传输数据，请重新发送')
        }
        this.announce()
        this.changed()
      }, 25000)
      this.timer.unref()
      this.changed()
    } catch (error) {
      this.state = 'error'
      this.error = (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
        ? 'LocalSend 端口 53317 已被占用，请关闭本机 LocalSend 或其他占用程序后重试'
        : `文件传输启动失败：${message(error)}`
      if (this.server) { this.server.closeAllConnections(); this.server.close(); this.server = undefined }
      this.changed()
    }
  }

  private async loadIdentity(): Promise<void> {
    const file = path.join(this.options.baseDir, 'identity.json')
    try {
      const identity = JSON.parse(await fs.readFile(file, 'utf8'))
      if (typeof identity.private !== 'string' || typeof identity.cert !== 'string') throw new Error('identity')
      const certificate = new X509Certificate(identity.cert)
      if (Date.parse(certificate.validTo) < Date.now()) throw new Error('expired')
      this.identity = identity
    } catch {
      this.identity = await new Promise((resolve, reject) => selfsigned.generate(
        [{ name: 'commonName', value: 'Activity Island' }],
        { keySize: 2048, days: 3650, algorithm: 'sha256' },
        (error, result) => error ? reject(error) : resolve({ private: result.private, cert: result.cert }),
      ))
      await fs.writeFile(file, JSON.stringify(this.identity), { mode: 0o600 })
    }
    this.fingerprint = digest(new X509Certificate(this.identity!.cert).fingerprint256)
  }

  private info() {
    return { alias: this.alias, version: '2.0', deviceModel: 'Activity Island · Windows', deviceType: 'desktop', fingerprint: this.fingerprint, port: this.port, protocol: 'https', download: false }
  }

  private async startDiscovery(): Promise<void> {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.udp = socket
    socket.on('error', () => { this.error = '自动发现不可用，可使用“连接地址”添加设备；请检查防火墙和局域网设置'; this.changed() })
    socket.on('message', (data, rinfo) => {
      if (data.length > 8192 || !isLocalAddress(rinfo.address)) return
      try {
        const info = JSON.parse(data.toString('utf8'))
        const device = this.remember(info, rinfo.address)
        if (device && info.announce === true) void this.register(device).catch(() => {})
      } catch { /* 忽略其他组播数据。 */ }
    })
    await new Promise<void>(resolve => { socket.once('error', () => resolve()); socket.bind(DEFAULT_PORT, () => resolve()) })
    try {
      const addresses = this.addresses()
      if (!addresses.length) socket.addMembership(GROUP)
      for (const address of addresses) { try { socket.addMembership(GROUP, address) } catch { /* 某网卡不支持多播。 */ } }
      socket.setMulticastTTL(1)
      this.announce()
    } catch { this.error = '自动发现不可用，可使用“连接地址”添加设备' }
  }

  announce(): void {
    if (!this.udp || Date.now() - this.lastAnnounce < 1500) return
    this.lastAnnounce = Date.now()
    const network = this.addresses().sort().join(',')
    if (network !== this.lastNetwork) {
      this.lastNetwork = network
      for (const address of this.addresses()) { try { this.udp.addMembership(GROUP, address) } catch { /* 已加入或网卡暂不可用。 */ } }
    }
    const packet = Buffer.from(JSON.stringify({ ...this.info(), announce: true }))
    for (const address of this.addresses()) {
      try { this.udp.setMulticastInterface(address); this.udp.send(packet, DEFAULT_PORT, GROUP, () => {}) } catch { /* 网络切换时下次重试。 */ }
    }
  }

  private remember(raw: Record<string, unknown>, host: string, certificateFingerprint?: string): NearbyDevice | undefined {
    if (!isLocalAddress(host) || typeof raw.fingerprint !== 'string' || typeof raw.alias !== 'string'
      || !String(raw.version).startsWith('2.') || !Number.isInteger(raw.port) || Number(raw.port) < 1 || Number(raw.port) > 65535
      || !['http', 'https'].includes(String(raw.protocol))) return
    const fingerprint = digest(certificateFingerprint || raw.fingerprint)
    if (!fingerprint || fingerprint === this.fingerprint) return
    // 设备标识独立于临时 IP；发现信息不是可信身份，只用于用户确认前的展示。
    const device: NearbyDevice = { id: fingerprint, fingerprint, host, port: Number(raw.port), protocol: raw.protocol as 'http' | 'https',
      alias: raw.alias.slice(0, 60) || '附近设备', deviceModel: String(raw.deviceModel ?? '').slice(0, 100), deviceType: String(raw.deviceType ?? 'desktop').slice(0, 30), lastSeen: Date.now() }
    if (this.devices.size >= 100 && !this.devices.has(device.id)) return
    this.devices.set(device.id, device)
    this.changed()
    return device
  }

  async connect(address: string): Promise<void> {
    if (typeof address !== 'string') throw new Error('请输入局域网 IPv4 地址')
    const url = new URL(address.includes('://') ? address : `https://${address}`)
    if (!['http:', 'https:'].includes(url.protocol) || !isLocalAddress(url.hostname) || url.username || url.password) throw new Error('请输入局域网 IPv4 地址，例如 192.168.1.8:53317')
    const peer: NearbyDevice = { id: '', alias: '', deviceType: '', deviceModel: '', fingerprint: '', host: url.hostname, port: Number(url.port || DEFAULT_PORT), protocol: url.protocol === 'https:' ? 'https' : 'http', lastSeen: Date.now() }
    await this.register(peer)
  }

  private async register(peer: NearbyDevice): Promise<void> {
    const reply = await this.request(peer, '/register', this.info(), undefined, 5000)
    if (reply.status !== 200 || !this.remember({ ...reply.body, port: peer.port, protocol: peer.protocol }, peer.host, reply.fingerprint)) throw new Error('对方未返回兼容的 LocalSend 设备信息')
  }

  async selectFiles(paths: string[]): Promise<void> {
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_FILES || paths.some(p => typeof p !== 'string' || !path.isAbsolute(p))) throw new Error('请选择 1–200 个本地文件')
    const files = []
    for (const filePath of [...new Set(paths)]) {
      const stat = await fs.lstat(filePath)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('首版支持普通文件，请将文件夹打包后再发送')
      files.push({ id: randomUUID(), fileName: safeFileName(path.basename(filePath)), size: stat.size, fileType: 'application/octet-stream', path: filePath })
    }
    this.draft = files
    this.changed()
  }

  clearDraft(): void { this.draft = []; this.changed() }

  async configure(values: { alias?: string; saveDirectory?: string }): Promise<void> {
    if (values.alias !== undefined) {
      if (typeof values.alias !== 'string' || !values.alias.trim() || values.alias.length > 60) throw new Error('设备名称需要 1–60 个字符')
      this.alias = values.alias.trim()
    }
    if (values.saveDirectory) {
      if (!path.isAbsolute(values.saveDirectory)) throw new Error('保存目录必须为绝对路径')
      await fs.mkdir(values.saveDirectory, { recursive: true })
      this.saveDirectory = values.saveDirectory
    }
    await fs.writeFile(path.join(this.options.baseDir, 'settings.json'), JSON.stringify({ version: 1, alias: this.alias, saveDirectory: this.saveDirectory }))
    this.lastAnnounce = 0
    this.announce()
    this.changed()
  }

  private newSession(direction: 'incoming' | 'outgoing', peer: NearbyDevice, files: TransferFile[]): Active {
    for (const [id, session] of this.active) if (this.active.size >= 50 && TERMINAL.has(session.record.state)) this.active.delete(id)
    const record: TransferSession = { id: randomUUID(), direction, peer: peer.alias, deviceId: peer.id, files,
      state: 'waiting', bytes: 0, total: files.reduce((sum, f) => sum + f.size, 0), createdAt: Date.now() }
    const active: Active = { record, host: peer.host, fingerprint: peer.fingerprint, tokens: new Map(), received: new Set(), uploading: new Set(), controller: new AbortController(), paths: [], directory: this.saveDirectory, activityAt: Date.now() }
    this.active.set(record.id, active)
    return active
  }

  private update(active: Active, state: TransferState, error?: string): void {
    if (TERMINAL.has(active.record.state)) return
    active.record.state = state
    active.record.error = error
    if (TERMINAL.has(state)) {
      if (active.pending) { clearTimeout(active.pending.timer); this.json(active.pending.response, state === 'rejected' ? 403 : 409, { message: error || state }); active.pending = undefined }
      if (state !== 'completed') active.controller.abort()
      this.persist()
    }
    this.changed()
  }

  private persist(): void {
    // 仅保存传输摘要；不保存凭据、绝对源路径或临时授权。
    const records = this.snapshot().sessions.filter(s => TERMINAL.has(s.state)).slice(0, 50)
    this.historyWrite = this.historyWrite.then(() => fs.writeFile(path.join(this.options.baseDir, 'history.json.tmp'), JSON.stringify({ version: 1, records })))
      .then(() => fs.rename(path.join(this.options.baseDir, 'history.json.tmp'), path.join(this.options.baseDir, 'history.json'))).catch(() => {})
  }

  async send(deviceId: string, pin?: string): Promise<string> {
    const peer = this.devices.get(deviceId)
    if (this.state !== 'running') throw new Error('文件传输服务未就绪')
    if (!peer || Date.now() - peer.lastSeen > 75000) throw new Error('设备已离线，请刷新或重新连接')
    if (!this.draft.length) throw new Error('请先添加文件')
    if ([...this.active.values()].some(a => a.record.direction === 'outgoing' && !TERMINAL.has(a.record.state))) throw new Error('已有发送任务，请等待完成或取消')
    if (pin && !/^\d{4,12}$/.test(pin)) throw new Error('接收码应为 4–12 位数字')
    const sourceFiles = this.draft.map(f => ({ ...f }))
    const active = this.newSession('outgoing', peer, sourceFiles.map(({ path: _path, ...f }) => f))
    this.draft = []
    this.changed()
    void this.sendInternal(active, peer, sourceFiles, pin).catch(error => {
      this.update(active, 'failed', message(error))
    })
    return active.record.id
  }

  private async sendInternal(active: Active, peer: NearbyDevice, sources: Array<TransferFile & { path: string }>, pin?: string): Promise<void> {
    const signal = active.controller.signal
    this.update(active, 'verifying')
    for (const source of sources) {
      const hash = createHash('sha256')
      const stream = createReadStream(source.path, { signal })
      for await (const chunk of stream) hash.update(chunk)
      const stat = await fs.stat(source.path)
      if (stat.size !== source.size) throw new Error('源文件已变化，请重新添加')
      source.sha256 = hash.digest('hex')
      active.record.files.find(f => f.id === source.id)!.sha256 = source.sha256
    }
    this.update(active, 'waiting')
    const reply = await this.request(peer, `/prepare-upload${pin ? `?pin=${encodeURIComponent(pin)}` : ''}`, {
      info: this.info(), files: Object.fromEntries(sources.map(({ path: _path, ...f }) => [f.id, f])),
    }, signal, this.options.offerTimeoutMs ?? 95000)
    if (reply.status === 403) { this.update(active, 'rejected', '对方拒绝了接收'); return }
    if (reply.status === 401) throw new Error('对方需要接收码，请重新添加文件并填写接收码后发送')
    if (reply.status !== 200 || typeof reply.body.sessionId !== 'string' || !reply.body.files || typeof reply.body.files !== 'object') throw new Error(`对方未接受请求（HTTP ${reply.status}），请重试`)
    const remoteId = reply.body.sessionId
    const accepted = reply.body.files as Record<string, unknown>
    const selected = sources.filter(f => typeof accepted[f.id] === 'string')
    if (!selected.length) throw new Error('对方未选择任何文件')
    active.record.files = active.record.files.filter(f => selected.some(s => s.id === f.id))
    active.record.total = selected.reduce((sum, f) => sum + f.size, 0)
    const cancelRemote = () => { void this.request(peer, `/cancel?sessionId=${encodeURIComponent(remoteId)}`, {}, undefined, 3000).catch(() => {}) }
    signal.addEventListener('abort', cancelRemote, { once: true })
    try {
      if (signal.aborted) { cancelRemote(); return }
      this.update(active, 'transferring')
      for (const source of selected) {
        const query = new URLSearchParams({ sessionId: remoteId, fileId: source.id, token: String(accepted[source.id]) })
        await this.upload(peer, `/upload?${query}`, source, active)
      }
      peer.lastSeen = Date.now()
      this.update(active, 'completed')
    } finally { signal.removeEventListener('abort', cancelRemote) }
  }

  accept(id: string): void {
    const active = this.active.get(id)
    if (!active?.pending || active.record.state !== 'waiting') throw new Error('请求已过期或已被处理')
    const { response, timer } = active.pending
    clearTimeout(timer)
    active.pending = undefined
    for (const file of active.record.files) active.tokens.set(file.id, randomBytes(32).toString('hex'))
    this.json(response, 200, { sessionId: id, files: Object.fromEntries(active.tokens) })
    active.activityAt = Date.now()
    this.update(active, 'transferring')
  }

  reject(id: string): void { const a = this.active.get(id); if (a?.pending) this.update(a, 'rejected', '已拒绝接收') }
  cancel(id: string): void { const a = this.active.get(id); if (a) this.update(a, 'cancelled', '传输已取消') }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = remoteHost(req.socket.remoteAddress)
    if (!isLocalAddress(host)) { this.json(res, 403, { message: '仅支持局域网' }); return }
    const url = new URL(req.url || '/', 'https://localhost')
    const route = url.pathname
    if (req.method === 'GET' && route === `${API}/info`) { this.json(res, 200, this.info()); return }
    if (req.method !== 'POST') { this.json(res, 405, {}); return }
    if (route === `${API}/upload`) { await this.receive(req, res, url); return }
    const body = await this.body(req)
    if (route === `${API}/register`) {
      this.remember(body, host, this.clientFingerprint(req))
      this.json(res, 200, this.info())
    } else if (route === `${API}/prepare-upload`) {
      if ([...this.active.values()].some(a => a.record.direction === 'incoming' && !TERMINAL.has(a.record.state))) { this.json(res, 409, {}); return }
      const peer = body.info && typeof body.info === 'object' ? this.remember(body.info as Record<string, unknown>, host, this.clientFingerprint(req)) : undefined
      if (!peer || !body.files || typeof body.files !== 'object' || Array.isArray(body.files)) throw new Error('无效的发送请求')
      const entries = Object.entries(body.files as Record<string, Record<string, unknown>>)
      if (!entries.length || entries.length > MAX_FILES) throw new Error('文件数量超出范围')
      const files: TransferFile[] = entries.map(([id, raw]) => {
        if (!raw || typeof raw !== 'object' || !id || id.length > 200 || raw.id !== id || !Number.isSafeInteger(raw.size) || Number(raw.size) < 0 || Number(raw.size) > 1024 ** 4) throw new Error('文件元数据无效')
        if (raw.sha256 != null && (typeof raw.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(raw.sha256))) throw new Error('文件校验值无效')
        return { id, fileName: safeFileName(raw.fileName), size: Number(raw.size), fileType: String(raw.fileType || 'application/octet-stream').slice(0, 100), sha256: raw.sha256 as string | undefined }
      })
      const total = files.reduce((sum, f) => sum + f.size, 0)
      if (!Number.isSafeInteger(total)) throw new Error('文件总大小超出范围')
      const disk = await fs.statfs(this.saveDirectory)
      if (disk.bavail * disk.bsize < total) throw new Error('接收磁盘空间不足')
      // statfs 是异步的，需要再次检查，防止并发请求在检查期间同时占用接收槽。
      if ([...this.active.values()].some(a => a.record.direction === 'incoming' && !TERMINAL.has(a.record.state))) { this.json(res, 409, {}); return }
      const active = this.newSession('incoming', peer, files)
      req.setTimeout(0)
      const timer = setTimeout(() => this.update(active, 'rejected', '接收请求已超时'), this.options.offerTimeoutMs ?? 90000)
      timer.unref()
      active.pending = { response: res, timer }
      res.on('close', () => { if (active.pending && !res.writableFinished) this.update(active, 'cancelled', '对方已取消发送') })
      this.changed()
      this.emit('offer', { ...active.record })
    } else if (route === `${API}/cancel`) {
      const active = this.active.get(url.searchParams.get('sessionId') || '')
      if (!active || active.record.direction !== 'incoming' || active.host !== host || !this.matchesClient(req, active)) { this.json(res, 403, {}); return }
      this.cancel(active.record.id)
      this.json(res, 200, {})
    } else this.json(res, 404, {})
  }

  private clientFingerprint(req: IncomingMessage): string | undefined {
    const certificate = (req.socket as TLSSocket).getPeerCertificate()
    return certificate?.fingerprint256 ? digest(certificate.fingerprint256) : undefined
  }
  private matchesClient(req: IncomingMessage, active: Active): boolean {
    const fingerprint = this.clientFingerprint(req)
    return !fingerprint || fingerprint === active.fingerprint
  }

  private async receive(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const active = this.active.get(url.searchParams.get('sessionId') || '')
    const id = url.searchParams.get('fileId') || ''
    const file = active?.record.files.find(f => f.id === id)
    if (!active || active.record.direction !== 'incoming' || !file || active.record.state !== 'transferring'
      || active.host !== remoteHost(req.socket.remoteAddress) || !this.matchesClient(req, active)
      || !active.tokens.has(id) || active.tokens.get(id) !== url.searchParams.get('token')) { this.json(res, 403, {}); req.resume(); return }
    if (active.received.has(id) || active.uploading.has(id)) { this.json(res, 409, {}); req.resume(); return }
    if (req.headers['content-length'] !== undefined && Number(req.headers['content-length']) !== file.size) { this.json(res, 400, {}); req.resume(); return }
    active.uploading.add(id)
    const directory = active.directory
    active.activityAt = Date.now()
    const temporary = path.join(directory, `.island-${active.record.id}-${randomUUID()}.part`)
    let bytes = 0
    const hash = createHash('sha256')
    const meter = new Transform({ transform: (chunk: Buffer, _encoding, callback) => {
      bytes += chunk.length
      if (bytes > file.size) { callback(new Error('接收数据超过声明的文件大小')); return }
      hash.update(chunk)
      active.activityAt = Date.now()
      active.record.bytes += chunk.length
      this.changed()
      callback(null, chunk)
    } })
    req.setTimeout(30000, () => req.destroy(new Error('接收超时')))
    try {
      await pipeline(req, meter, createWriteStream(temporary, { flags: 'wx' }), { signal: active.controller.signal })
      if (bytes !== file.size) throw new Error('文件未完整接收')
      const actual = hash.digest('hex')
      if (file.sha256 && actual.toLowerCase() !== file.sha256.toLowerCase()) throw new Error('文件 SHA-256 校验失败')
      if (active.controller.signal.aborted) throw new Error('传输已取消')
      const destination = await this.publish(temporary, directory, file.fileName)
      active.paths.push(destination)
      active.received.add(id)
      active.uploading.delete(id)
      this.json(res, 200, {})
      if (active.received.size === active.record.files.length) this.update(active, 'completed')
      else this.changed()
    } catch (error) {
      active.uploading.delete(id)
      await fs.unlink(temporary).catch(() => {})
      if (!res.destroyed && !res.headersSent) this.json(res, 422, { message: message(error) })
      this.update(active, 'failed', message(error))
    }
  }

  private async publish(temporary: string, directory: string, name: string): Promise<string> {
    const ext = path.extname(name)
    const stem = path.basename(name, ext)
    for (let i = 0; i < 1000; i++) {
      const destination = path.join(directory, i ? `${stem} (${i})${ext}` : name)
      try {
        // 同目录硬链接原子发布且不覆盖；不支持硬链接的文件系统使用独占复制。
        try { await fs.link(temporary, destination) }
        catch (error) { if (['ENOTSUP', 'EPERM', 'EOPNOTSUPP'].includes((error as NodeJS.ErrnoException).code || '')) await fs.copyFile(temporary, destination, constants.COPYFILE_EXCL); else throw error }
        await fs.unlink(temporary)
        return destination
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
    throw new Error('同名文件过多，请更换接收目录')
  }

  private request(peer: NearbyDevice, route: string, body: unknown, signal?: AbortSignal, timeout = 15000): Promise<{ status: number; body: Record<string, unknown>; fingerprint?: string }> {
    return new Promise((resolve, reject) => {
      const bytes = Buffer.from(JSON.stringify(body))
      let fingerprint: string | undefined
      const request = (peer.protocol === 'https' ? https : http).request({
        hostname: peer.host, port: peer.port, path: `${API}${route}`, method: 'POST', agent: false,
        rejectUnauthorized: false, key: this.identity?.private, cert: this.identity?.cert, signal,
        headers: { 'Content-Type': 'application/json', 'Content-Length': bytes.length },
      }, response => {
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 262144) response.destroy(new Error('响应过大')); else chunks.push(chunk) })
        response.on('error', reject)
        response.on('end', () => {
          try { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: response.statusCode || 500, body: text ? JSON.parse(text) : {}, fingerprint }) }
          catch { reject(new Error('对方响应格式无效')) }
        })
      })
      if (peer.protocol === 'https') request.on('socket', socket => (socket as TLSSocket).once('secureConnect', () => {
        fingerprint = digest((socket as TLSSocket).getPeerCertificate().fingerprint256 || '')
        if (!fingerprint || (peer.fingerprint && fingerprint !== digest(peer.fingerprint))) request.destroy(new Error('设备证书发生变化，请重新发现设备'))
      }))
      request.setTimeout(timeout, () => request.destroy(new Error('等待对方响应超时')))
      request.on('error', reject)
      request.end(bytes)
    })
  }

  private async upload(peer: NearbyDevice, route: string, file: TransferFile & { path: string }, active: Active): Promise<void> {
    const signal = active.controller.signal
    await new Promise<void>((resolve, reject) => {
      const request = (peer.protocol === 'https' ? https : http).request({
        hostname: peer.host, port: peer.port, path: `${API}${route}`, method: 'POST', agent: false,
        rejectUnauthorized: false, key: this.identity?.private, cert: this.identity?.cert, signal,
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': file.size },
      }, response => {
        response.resume()
        response.on('error', reject)
        response.on('end', () => response.statusCode === 200 ? resolve() : reject(new Error(`文件发送失败（HTTP ${response.statusCode}）`)))
      })
      if (peer.protocol === 'https') request.on('socket', socket => (socket as TLSSocket).once('secureConnect', () => {
        if (digest((socket as TLSSocket).getPeerCertificate().fingerprint256 || '') !== digest(peer.fingerprint)) request.destroy(new Error('设备证书不匹配'))
      }))
      request.setTimeout(30000, () => request.destroy(new Error('文件传输超时')))
      request.on('error', reject)
      const meter = new Transform({ transform: (chunk: Buffer, _encoding, callback) => {
        active.record.bytes += chunk.length
        this.changed()
        callback(null, chunk)
      } })
      void pipeline(createReadStream(file.path), meter, request, { signal }).catch(reject)
    })
  }

  private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
    req.setTimeout(15000, () => req.destroy())
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) { size += chunk.length; if (size > 262144) throw new Error('请求过大'); chunks.push(chunk) }
    const text = Buffer.concat(chunks).toString('utf8')
    if (!text) return {}
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('无效的请求')
    return parsed
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    if (res.destroyed || res.writableEnded) return
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  private changed(): void {
    if (this.notifyTimer || this.stopping) return
    this.notifyTimer = setTimeout(() => { this.notifyTimer = undefined; if (!this.stopping) this.emit('change', this.snapshot()) }, 100)
    this.notifyTimer.unref()
  }

  async stop(): Promise<void> {
    if (this.starting) await this.starting
    this.stopping = true
    if (this.timer) clearInterval(this.timer)
    if (this.notifyTimer) clearTimeout(this.notifyTimer)
    for (const active of this.active.values()) if (!TERMINAL.has(active.record.state)) this.update(active, 'cancelled', '应用已关闭')
    try { this.udp?.close() } catch { /* 已停止。 */ }
    this.udp = undefined
    if (this.server) {
      const server = this.server
      this.server = undefined
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
    this.state = 'stopped'
    await this.historyWrite
  }
}
