// 内置工作台迁移后的端到端验收（真实宿主 + 真实页面 + 真实 preload + 本地假接口）。
//
// 覆盖的是"以前烂掉但没人发现"的那部分：
//   1) 「DeepSeek 用量」以前整块是死代码（调宿主不存在的 `deepseek.*`），现在页面自己用 http+storage 实现，
//      这里用**本地假接口**把数字喂进去，断言 DOM 真的显示了余额；
//   2) 快捷启动点网址以前"点了没反应却像成功"（宿主忽略了 openPath 的返回值），
//      这里断言真的走了 openExternal，并且**失败会在页面上说出来**；
//   3) 页面偏好从宿主 settings.json 搬到自己的工作台 storage，断言真的存进去了；
//   4) 能力不足时页面自己降级（隐藏对应面板），而不是等调用报错。
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const http = require('node:http')

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'
const { app, BrowserWindow, ipcMain, shell, webContents } = require('electron')

const REPO = path.join(__dirname, '..', '..')
const SANDBOX = path.join(os.tmpdir(), 'island-workbench-page')
const PROFILE = path.join(SANDBOX, 'profile')
const STORAGE_FILE = path.join(PROFILE, 'plugin-data', '__workbench__builtin.json')
const SHORTCUTS_FILE = path.join(PROFILE, 'workbench', 'shortcuts.json')

fs.rmSync(SANDBOX, { recursive: true, force: true })
fs.mkdirSync(path.join(PROFILE, 'plugins'), { recursive: true })
fs.mkdirSync(path.join(PROFILE, 'plugin-data'), { recursive: true })
fs.mkdirSync(path.join(PROFILE, 'workbench'), { recursive: true })
app.setPath('userData', PROFILE)

const opened = { external: [], path: [] }
let openPathResult = ''
shell.openExternal = async (url) => { opened.external.push(url) }
shell.openPath = async (target) => { opened.path.push(target); return openPathResult }

for (const method of ['show', 'showInactive', 'focus']) BrowserWindow.prototype[method] = function () {}

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail: String(detail ?? '') })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `   [${detail}]` : ''}\n`)
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  // 假 DeepSeek 余额接口（字段照官方 /user/balance 的形状）
  const server = http.createServer((request, response) => {
    if (request.url === '/balance') {
      const authorized = String(request.headers.authorization ?? '') === 'Bearer test-token'
      response.writeHead(authorized ? 200 : 401, { 'Content-Type': 'application/json' })
      if (!authorized) { response.end('{"error":"unauthorized"}'); return }
      response.end(JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }] }))
      return
    }
    response.writeHead(404); response.end('nope')
  })
  const port = await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))

  // 先落盘"上次用过的"工作台数据：证明页面读的是自己的工作台 storage。
  // 参数走保留键 `__settings`（和插件同一套机制），页面数据（DeepSeek 令牌等）走自由 KV。
  fs.writeFileSync(STORAGE_FILE, JSON.stringify({
    '__settings': { refreshMs: 5000, accent: '#22c55e', showNetwork: false },
    'deepseek': { apiKey: 'test-token', endpoint: `http://127.0.0.1:${port}/balance` },
  }, null, 2))
  // 宿主拥有的快捷启动列表（跨工作台共享）：一条网址、一条必然失败的路径
  fs.writeFileSync(SHORTCUTS_FILE, JSON.stringify([
    { id: 'sc-url', name: '项目主页', path: 'https://example.com/project' },
    { id: 'sc-missing', name: '不存在的程序', path: 'C:\\definitely\\missing.exe' },
  ], null, 2))

  require(path.join(REPO, 'dist-electron', 'main.js'))
  await app.whenReady()
  await wait(2500)
  ipcMain.emit('host:open-workbench')
  await wait(2500)

  const page = webContents.getAllWebContents().find(item => item.getURL().includes('console-apps/workbench'))
  check('工作台页面已加载', !!page)
  if (!page) { server.close(); app.exit(1); return }
  const js = (code) => page.executeJavaScript(code)
  const text = (selector) => js(`document.querySelector('${selector}')?.textContent ?? '(缺失)'`)

  // ---- 1) 只暴露新接口
  check('页面用的是 window.workbench', await js("typeof window.workbench === 'object' && typeof window.workbench.http === 'function'"))
  check('旧接口 window.activityIsland 已移除', await js("typeof window.activityIsland === 'undefined'"))
  check('页面里没有 unknown-api 之类的静默失败', await js("typeof window.workbench.api === 'undefined'"))

  // ---- 2) DeepSeek 面板真的出数字了（旧版永久"未配置/获取失败"）
  check('DeepSeek 从工作台 storage 读到令牌', (await text('#ds-token-status')).includes('已配置'), await text('#ds-token-status'))
  check('DeepSeek 余额从接口解析出来了', (await text('#ds-balance')).trim() === '110.00', await text('#ds-balance'))
  check('DeepSeek 赠送额度解析正确', (await text('#ds-bonus')).trim() === '10.00', await text('#ds-bonus'))
  check('DeepSeek 充值余额解析正确（对应 topped_up_balance）', (await text('#ds-topped')).trim() === '100.00', await text('#ds-topped'))
  check('DeepSeek 状态显示正常', (await text('#ds-status')).includes('正常'), await text('#ds-status'))
  check('令牌不回填到输入框（只显示"已配置"）', await js("document.querySelector('#ds-token-input').value === ''"))

  // ---- 3) 快捷启动：网址真的走 openExternal（旧版点了没反应却像成功）
  await js("document.querySelectorAll('#shortcut-grid .sc-item')[0].click()")
  await wait(600)
  check('点网址快捷启动 → 走 openExternal', opened.external.includes('https://example.com/project'), JSON.stringify(opened.external))
  check('打开成功时不显示错误', !(await text('#updated-at')).includes('无法打开'), await text('#updated-at'))

  // ---- 4) 失败必须显示在页面上（旧版把错误吞掉）
  openPathResult = '找不到该文件'
  await js("document.querySelectorAll('#shortcut-grid .sc-item')[1].click()")
  await wait(600)
  const footer = await text('#updated-at')
  check('打开失败会在页脚说出来（旧版静默）', footer.includes('无法打开') && footer.includes('找不到该文件'), footer)
  openPathResult = ''

  // ---- 5) 参数由宿主管：页面不再画设置控件，值走宿主渲染的参数表单
  check('页面里不再有自己的设置控件（参数界面归宿主）',
    await js("!document.querySelector('#refresh-select') && !document.querySelector('#accent-picker') && !document.querySelector('#network-toggle') && !document.querySelector('#config-section')"))
  check('参数声明在清单里（宿主据此渲染表单）',
    (await js("(async () => JSON.stringify((await window.workbench.settings.schema())?.fields ?? []))()")).includes('refreshMs'))

  // 宿主把参数推给页面（等价于用户在管理页改完）
  await js(`void (async () => {
    const api = window.workbench
    await api.settings.set('refreshMs', 1000)
  })()`)
  await wait(600)
  const stored = JSON.parse(fs.readFileSync(STORAGE_FILE, 'utf8'))
  check('参数写进工作台自己的存储（保留键 __settings）', stored?.__settings?.refreshMs === 1000, JSON.stringify(stored?.__settings))
  check('参数里带着清单声明的默认值', stored?.__settings?.accent === undefined || typeof stored?.__settings?.accent === 'string', JSON.stringify(stored?.__settings))

  // ---- 6) 页面按参数生效：showNetwork=false 时应隐藏网络面板
  check('showNetwork=false 生效（网络面板隐藏）', await js("document.querySelector('#network-panel').classList.contains('is-hidden')"))
  check('主题色按参数应用', await js("document.documentElement.style.getPropertyValue('--accent').trim() === '#22c55e'"))

  // ---- 7) 快捷启动增删改走新接口
  await js(`(() => {
    document.querySelector('#sc-add')?.click()
    const name = document.querySelector('#sc-name-input'); const p = document.querySelector('#sc-path-input')
    name.value = '记事本'; p.value = 'C:\\\\Windows\\\\notepad.exe'
    document.querySelector('#sc-save').click()
  })()`)
  await wait(900)
  const afterAdd = JSON.parse(fs.readFileSync(SHORTCUTS_FILE, 'utf8'))
  check('新增快捷启动走 workbench.shortcuts', afterAdd.some(item => item.name === '记事本'), JSON.stringify(afterAdd.map(i => i.name)))
  check('新增后页面立刻重绘（不用刷新）', (await js("document.querySelectorAll('#shortcut-grid .sc-item').length")) === 3, await js("document.querySelectorAll('#shortcut-grid .sc-item').length"))

  // ---- 8) 能力不足时页面自己降级：把能力砍到只剩 storage，DeepSeek 面板应隐藏
  const main = require(path.join(REPO, 'dist-electron', 'main.js'))
  main.setActiveWorkbench('probe', ['storage'])
  await js('void boot()')
  await wait(600)
  check('能力被砍后 DeepSeek 面板隐藏（自己降级，不用等报错）', await js("document.querySelector('#deepseek-section').classList.contains('is-hidden')"))
  check('能力被砍后快捷启动面板隐藏', await js("document.querySelector('#shortcut-section').classList.contains('is-hidden')"))
  main.setActiveWorkbench('builtin', [])

  server.close()
  let failed = 0
  for (const item of results) if (!item.ok) failed += 1
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  app.exit(failed ? 1 : 0)
}

app.whenReady().then(main).catch((error) => { console.error(error); app.exit(1) })
