// 工作台能力面的端到端验收（真实宿主 + 真实工作台页面 + 真实 preload）。
//
// 为什么必须有这个测试：这层以前**零测试**，结果两处最面向用户的功能烂掉都没人发现
// （DeepSeek 面板整块死掉、网址点不动却显示成功）。所以这里不只测"接口存在"，而是测：
//   1) 每个能力真的能干活（open 分流、http 通本地服务、run 拿到 stdout、storage 往返、resize 被钳制）；
//   2) **失败会如实上报**（这是旧实现最大的毛病：忽略返回值、恒报成功）；
//   3) **没声明就调不通**（能力声明是可执行校验，不是装饰）；
//   4) **不是工作台页面就调不通**（纵深防御）。
//
// 注意两条实测坑：必须用独立 userData（否则和正在运行的实例抢 profile → ERR_FAILED），
// 以及不要每页 create→destroy 窗口（会让渲染进程崩溃）。
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const http = require('node:http')

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'
const { app, BrowserWindow, ipcMain, shell, webContents } = require('electron')

const REPO = path.join(__dirname, '..', '..')
const SANDBOX = path.join(os.tmpdir(), 'island-workbench-api')
const PROFILE = path.join(SANDBOX, 'profile')

fs.rmSync(SANDBOX, { recursive: true, force: true })
fs.mkdirSync(path.join(PROFILE, 'plugins'), { recursive: true })
fs.mkdirSync(PROFILE, { recursive: true })
app.setPath('userData', PROFILE)

// 拦截真实启动：测的是"宿主怎么分流、怎么报错"，不能真去开浏览器/程序。
const opened = { external: [], path: [] }
let openPathResult = ''
shell.openExternal = async (url) => { opened.external.push(url) }
shell.openPath = async (target) => { opened.path.push(target); return openPathResult }

for (const method of ['show', 'showInactive', 'focus']) BrowserWindow.prototype[method] = function () {}

const results = []
// 立即输出：这个测试会开窗口，万一某步把渲染进程搞崩，缓到最后打印就什么线索都没有。
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail: String(detail ?? '') })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `   [${detail}]` : ''}\n`)
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  // 本地 HTTP 服务：证明 http 能力可用，并且**能访问 127.0.0.1 上的本地服务**。
  const server = http.createServer((request, response) => {
    if (request.url === '/json') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ ok: true, path: request.url }))
      return
    }
    if (request.url === '/slow') { setTimeout(() => { response.writeHead(200); response.end('late') }, 5000); return }
    response.writeHead(404); response.end('nope')
  })
  const port = await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))

  const main = require(path.join(REPO, 'dist-electron', 'main.js'))
  await app.whenReady()
  await wait(2500)

  // 右键小岛 = host:open-workbench → enterCustomMode；工作台视图在启动时已预热。
  ipcMain.emit('host:open-workbench')
  await wait(1500)

  const workbench = webContents.getAllWebContents().find(item => item.getURL().includes('console-apps/workbench'))
  check('工作台页面已加载', !!workbench)
  if (!workbench) { server.close(); app.exit(1); return }
  const js = (code) => workbench.executeJavaScript(code)
  const call = async (expression) => JSON.parse(await js(`(async () => JSON.stringify(${expression}))()`))

  // ---- 1) 新接口存在，并且能力集是内置工作台的全集
  check('暴露了 window.workbench 新接口', await js("typeof window.workbench === 'object' && typeof window.workbench.run === 'function'"))
  const caps = await call('await window.workbench.capabilities()')
  const expected = ['system', 'open', 'http', 'run', 'storage', 'resize']
  check('capabilities() 返回内置工作台的全部能力', caps.ok === true && expected.every(name => caps.capabilities.includes(name)), JSON.stringify(caps.capabilities))

  // ---- 2) open：网址走 openExternal，路径走 openPath（旧实现两种情况都调 openPath，所以网址打不开）
  const urlResult = await call("await window.workbench.open('https://example.com/docs')")
  check('open(网址) 成功且走 openExternal', urlResult.ok === true && urlResult.kind === 'url' && opened.external.at(-1) === 'https://example.com/docs', JSON.stringify({ urlResult, external: opened.external }))
  const pathResult = await call("await window.workbench.open('C:\\\\Windows\\\\notepad.exe')")
  check('open(路径) 走 openPath', pathResult.ok === true && pathResult.kind === 'path' && opened.path.at(-1) === 'C:\\Windows\\notepad.exe', JSON.stringify({ pathResult, path: opened.path }))
  const emptyOpen = await call("await window.workbench.open('')")
  check('open(空) 明确报错而不是假装成功', emptyOpen.ok === false && !!emptyOpen.error, JSON.stringify(emptyOpen))
  // 关键回归：openPath 失败时**返回错误字符串**，旧实现忽略它恒报成功
  openPathResult = '找不到该文件'
  const failedOpen = await call("await window.workbench.open('C:\\\\definitely\\\\missing.exe')")
  check('open 失败会如实上报（旧实现恒报成功）', failedOpen.ok === false && failedOpen.error.includes('找不到该文件'), JSON.stringify(failedOpen))
  openPathResult = ''

  // ---- 3) http：能通本地服务，且只允许 http/https
  const httpOk = await call(`await window.workbench.http('http://127.0.0.1:${port}/json')`)
  check('http 能访问本机 127.0.0.1 上的服务', httpOk.ok === true && httpOk.status === 200 && httpOk.body.includes('"ok":true'), JSON.stringify({ status: httpOk.status, body: String(httpOk.body).slice(0, 60) }))
  const http404 = await call(`await window.workbench.http('http://127.0.0.1:${port}/missing')`)
  check('http 如实返回非 2xx（不吞状态码）', http404.ok === false && http404.status === 404, JSON.stringify({ ok: http404.ok, status: http404.status }))
  const httpFile = await call("await window.workbench.http('file:///C:/Windows/win.ini')")
  check('http 拒绝非 http/https', httpFile.ok === false && String(httpFile.error).includes('只允许 http/https'), JSON.stringify(httpFile))
  const httpBad = await call("await window.workbench.http('这不是网址')")
  check('http 拒绝非法网址', httpBad.ok === false && String(httpBad.error).includes('不是合法'), JSON.stringify(httpBad))
  const httpTimeout = await call(`await window.workbench.http('http://127.0.0.1:${port}/slow', { timeoutMs: 1000 })`)
  check('http 超时会报错', httpTimeout.ok === false && String(httpTimeout.error).includes('超时'), JSON.stringify(httpTimeout))

  // ---- 4) run：拿到 stdout 与退出码；失败要报错
  const runOk = await call("await window.workbench.run('cmd.exe', ['/c', 'echo hello-island'])")
  check('run 拿到 stdout 与 code=0', runOk.ok === true && runOk.code === 0 && runOk.stdout.includes('hello-island'), JSON.stringify({ code: runOk.code, stdout: String(runOk.stdout).trim() }))
  const runFail = await call("await window.workbench.run('cmd.exe', ['/c', 'exit 3'])")
  check('run 非零退出码如实上报', runFail.ok === false && runFail.code === 3, JSON.stringify({ ok: runFail.ok, code: runFail.code }))
  const runMissing = await call("await window.workbench.run('definitely-not-a-real-command-xyz')")
  check('run 命令不存在时报错而不是静默', runMissing.ok === false && !!runMissing.error, JSON.stringify({ ok: runMissing.ok, error: String(runMissing.error).slice(0, 80) }))
  const runTimeout = await call("await window.workbench.run('cmd.exe', ['/c', 'ping -n 6 127.0.0.1'], { timeoutMs: 1000 })")
  check('run 超时会终止并报错', runTimeout.ok === false && String(runTimeout.error).includes('超时'), JSON.stringify({ error: String(runTimeout.error).slice(0, 60) }))

  // ---- 5) storage：往返 + all + delete
  await call("await window.workbench.storage.set('probe', { n: 7 })")
  const stored = await call("await window.workbench.storage.get('probe')")
  check('storage 读写往返', stored.ok === true && stored.value && stored.value.n === 7, JSON.stringify(stored))
  const storedAll = await call('await window.workbench.storage.all()')
  check('storage.all 能列出', storedAll.ok === true && storedAll.values && storedAll.values.probe && storedAll.values.probe.n === 7, JSON.stringify(storedAll))
  await call("await window.workbench.storage.delete('probe')")
  const afterDelete = await call("await window.workbench.storage.get('probe')")
  check('storage.delete 生效', afterDelete.ok === true && afterDelete.value === undefined, JSON.stringify(afterDelete))

  // ---- 6) resize：宿主钳制并回报真实值（旧实现是 window.resizeTo，空操作）
  const huge = await call('await window.workbench.resize({ width: 5000, height: 100 })')
  check('resize 被钳制到上限/下限并标记 clamped', huge.ok === true && huge.width === 1280 && huge.height === 480 && huge.clamped === true, JSON.stringify(huge))
  const normal = await call('await window.workbench.resize({ width: 1000, height: 640 })')
  check('resize 合法值原样生效', normal.ok === true && normal.width === 1000 && normal.height === 640 && normal.clamped === false, JSON.stringify(normal))

  // ---- 7) 日志落到工作台自己的文件
  await js("window.workbench.log.info('workbench-api-probe')")
  await wait(600)
  const logFile = path.join(PROFILE, 'island-plugins', 'logs', '__workbench__builtin.log')
  const logText = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''
  check('workbench.log 落到工作台日志文件', logText.includes('workbench-api-probe'), logFile)

  // ---- 8) 能力声明是**可执行校验**：只声明 system 时，run/http 必须调不通
  main.setActiveWorkbench('probe-workbench', ['system'])
  const deniedRun = await call("await window.workbench.run('cmd.exe', ['/c', 'echo should-not-run'])")
  check('未声明 run → 拒绝且错误可读', deniedRun.ok === false && String(deniedRun.error) === 'capability-not-declared:run', JSON.stringify(deniedRun))
  const deniedHttp = await call(`await window.workbench.http('http://127.0.0.1:${port}/json')`)
  check('未声明 http → 拒绝', deniedHttp.ok === false && String(deniedHttp.error) === 'capability-not-declared:http', JSON.stringify(deniedHttp))
  const allowedSystem = await call('await window.workbench.system.status()')
  check('已声明 system → 仍然可用', allowedSystem.ok === true && typeof allowedSystem.cpuPercent === 'number', JSON.stringify({ ok: allowedSystem.ok }))
  const probeCaps = await call('await window.workbench.capabilities()')
  check('capabilities() 反映当前声明', probeCaps.ok === true && probeCaps.capabilities.length === 1 && probeCaps.capabilities[0] === 'system', JSON.stringify(probeCaps))
  main.setActiveWorkbench('builtin', [])

  // ---- 9) 纵深防御：不是工作台页面就调不通
  // 用同一个 preload 但**不是**工作台视图/窗口的普通窗口来发请求。
  const outsider = new BrowserWindow({
    show: false, width: 400, height: 300,
    webPreferences: { preload: path.join(REPO, 'dist-electron', 'preload', 'workbench-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  })
  await outsider.loadURL('data:text/html,<html><body>outsider</body></html>')
  const outsiderResult = JSON.parse(await outsider.webContents.executeJavaScript("(async () => JSON.stringify(await window.workbench.system.status()))()"))
  check('非工作台页面调用被拒（not-a-workbench）', outsiderResult.ok === false && outsiderResult.error === 'not-a-workbench', JSON.stringify(outsiderResult))
  outsider.destroy()

  server.close()
  let failed = 0
  for (const item of results) if (!item.ok) failed += 1
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  app.exit(failed ? 1 : 0)
}

app.whenReady().then(main).catch((error) => { console.error(error); app.exit(1) })
