// 后台脚本 → 插件页面 的端到端验收：真实宿主（dist-electron/main.js）+ 临时 profile + 真插件。
// 覆盖用户报的问题：后台脚本在跑，但插件页面永远收不到数据（宿主把事件当成"别人发的"给过滤掉了）。
// 全程不显示窗口、不碰真实 userData、不碰开发目录。
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'
const { app, BrowserWindow, ipcMain } = require('electron')

const REPO = path.join(__dirname, '..', '..')
const SANDBOX = path.join(os.tmpdir(), 'island-bg-e2e')
const PROFILE = path.join(SANDBOX, 'profile')
const USER_PLUGINS = path.join(PROFILE, 'plugins')
const DEV_ROOT = path.join(SANDBOX, 'dev')
const PLUGIN_ID = 'bg-probe'
const DEV_PLUGIN = path.join(DEV_ROOT, PLUGIN_ID)
const STORAGE = path.join(PROFILE, 'plugin-data', `${PLUGIN_ID}.json`)
const LOG = path.join(PROFILE, 'island-plugins', 'logs', `${PLUGIN_ID}.log`)

fs.rmSync(SANDBOX, { recursive: true, force: true })
fs.mkdirSync(USER_PLUGINS, { recursive: true })
fs.mkdirSync(path.join(DEV_PLUGIN, 'dist'), { recursive: true })
fs.mkdirSync(path.join(DEV_PLUGIN, 'resources'), { recursive: true })
fs.mkdirSync(PROFILE, { recursive: true })
app.setPath('userData', PROFILE)

// 插件：后台脚本每 200ms 吐一行 JSON；页面收到就写进 storage（测试从宿主机读文件断言）。
fs.writeFileSync(path.join(DEV_PLUGIN, 'plugin.json'), JSON.stringify({
  id: PLUGIN_ID, name: 'BG 探针', version: '0.1.0', runtime: 'web-app', priority: 50,
  entry: 'dist/index.html', resident: true,
  small: { enabled: true, width: 150, height: 40 }, medium: { width: 420, height: 200 }, large: { width: 640, height: 340 },
  background: { entry: 'resources/emit.js' },
}, null, 2))
fs.writeFileSync(path.join(DEV_PLUGIN, 'dist', 'index.html'),
  '<!doctype html><html><head><meta charset="utf-8"><title>bg</title></head><body><div id="root">bg</div><script src="app.js"></script></body></html>')
fs.writeFileSync(path.join(DEV_PLUGIN, 'dist', 'app.js'), `
  const island = window.dynamicIsland
  const seen = []
  island.events.on('state', (payload) => {
    seen.push(payload)
    island.storage.set('received', { count: seen.length, title: payload && payload.title, playing: payload && payload.playing })
  })
  island.events.on('boom', (payload) => { island.storage.set('boom', payload) })
  island.events.on('pid', (payload) => { island.storage.set('pid', payload) })
  island.log.info('bg-probe booted')
`)
fs.writeFileSync(path.join(DEV_PLUGIN, 'resources', 'emit.js'), `
  process.stdout.write(JSON.stringify({ type: 'pid', payload: { pid: process.pid } }) + '\\n')
  let n = 0
  const timer = setInterval(() => {
    n += 1
    process.stdout.write(JSON.stringify({ type: 'state', title: 'probe-' + n, artist: 'island', playing: n % 2 === 0 }) + '\\n')
    if (n === 3) process.stdout.write(JSON.stringify({ type: 'boom', title: 'boom', playing: false }) + '\\n')
    if (n === 2) process.stdout.write('this line is not json\\n')
  }, 200)
  process.on('SIGTERM', () => { clearInterval(timer); process.exit(0) })
`)

for (const method of ['show', 'showInactive', 'focus']) BrowserWindow.prototype[method] = function () {}

const results = []
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: String(detail ?? '') })
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const readStorage = () => {
  try { return JSON.parse(fs.readFileSync(STORAGE, 'utf8')) } catch { return null }
}

async function main() {
  // 走正常安装路径装进临时 profile（记录源码目录）
  const { PluginManager } = require(path.join(REPO, 'dist-electron', 'plugins', 'plugin-manager.js'))
  const manager = new PluginManager([USER_PLUGINS], USER_PLUGINS)
  manager.discover()
  manager.installDirectory(DEV_PLUGIN)
  check('插件装上且登记了源码目录', !!manager.sourceOf(PLUGIN_ID))

  require(path.join(REPO, 'dist-electron', 'main.js'))
  await app.whenReady()
  await wait(3000)

  // 后台脚本应该真的被拉起来：storage 里的计数在涨说明"脚本 stdout → 宿主 → 插件页面 → storage"整条链路通了
  let first = null
  for (let tick = 0; tick < 60; tick += 1) {
    const value = readStorage()
    if (value?.received?.count >= 1) { first = value; break }
    await wait(200)
  }
  check('插件页面收到了自己后台脚本的事件', !!first, first ? JSON.stringify(first.received) : 'storage 里一直没有 received')
  check('payload 是脚本输出的原始对象', first?.received?.title?.startsWith('probe-') === true, String(first?.received?.title))
  check('事件确实在持续推（不止第一条）', await (async () => {
    for (let tick = 0; tick < 40; tick += 1) { if ((readStorage()?.received?.count ?? 0) >= 3) return true; await wait(200) }
    return false
  })())

  check('自定义事件名也能收到（type 就是事件名）', !!readStorage()?.boom, JSON.stringify(readStorage()?.boom ?? null))
  const log = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : ''
  check('非 JSON 的 stdout 行进日志（不丢诊断信息）', log.includes('this line is not json'), log.slice(-160))
  check('插件自己的 log 也落盘', log.includes('bg-probe booted'), log.slice(-160))

  // 文件监听不能被后台脚本的运行时文件带崩（state.js 每秒改写不该触发热重载）
  const installedApp = fs.readFileSync(path.join(USER_PLUGINS, PLUGIN_ID, 'dist', 'app.js'), 'utf8')
  fs.writeFileSync(path.join(DEV_PLUGIN, 'dist', 'state.js'), `window.__STATE__=${Date.now()}`)
  await wait(1200)
  check('插件目录里的 state.js 不触发同步（防热重载风暴）', fs.readFileSync(path.join(USER_PLUGINS, PLUGIN_ID, 'dist', 'app.js'), 'utf8') === installedApp)

  // 热重载后旧的后台进程必须真的死掉，否则每改一次代码就泄漏一个进程
  const firstPid = readStorage()?.pid?.pid
  check('后台脚本把 pid 报上来了', Number.isInteger(firstPid), String(firstPid))
  const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
  check('后台脚本确实在跑', alive(firstPid))
  // 真改源码 → 应该同步 + 重载 + 换一个新进程
  fs.writeFileSync(path.join(DEV_PLUGIN, 'dist', 'app.js'), `${fs.readFileSync(path.join(DEV_PLUGIN, 'dist', 'app.js'), 'utf8')}\n// touched\n`)
  await wait(3000)
  check('真改源码仍然会同步到安装目录', fs.readFileSync(path.join(USER_PLUGINS, PLUGIN_ID, 'dist', 'app.js'), 'utf8').includes('// touched'))
  let secondPid = null
  for (let tick = 0; tick < 40; tick += 1) {
    const value = readStorage()?.pid?.pid
    if (Number.isInteger(value) && value !== firstPid) { secondPid = value; break }
    await wait(200)
  }
  check('热重载后后台脚本被重新拉起', Number.isInteger(secondPid), `${firstPid} → ${secondPid}`)
  await wait(500)
  check('旧的后台进程被杀掉（不泄漏进程）', !alive(firstPid), alive(firstPid) ? `pid ${firstPid} 还活着` : '')
  check('新进程是活的', Number.isInteger(secondPid) && alive(secondPid), String(secondPid))

  console.log('=== 后台脚本事件端到端验收（真实宿主）===')
  let failed = 0
  for (const item of results) { if (!item.ok) failed += 1; console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.detail ? `   [${item.detail}]` : ''}`) }
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  app.exit(failed ? 1 : 0)
}

app.whenReady().then(main).catch((error) => { console.error(error); app.exit(1) })
