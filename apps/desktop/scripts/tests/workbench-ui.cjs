// 控制台「工作台」管理页验收（隐藏窗口 + 真实 preload + 桩 IPC）。
//
// 这一页的形态是明确的：**列表克制，只显示「名字 + 示例图」；点进去才看详情。**
// 所以断言分成两层：
//   - 列表层：卡片数量、名字、示例图（有图用图 / 没图画首字占位）、不堆能力标签；
//   - 详情层：能力逐条人话列出并标红、未确认要弹确认框（取消则不启用）、参数、
//     日志、重载、导出插件包、卸载（两步）。
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'

// 独立 profile：和正在运行的实例抢 userData 会让 loadFile 直接 ERR_FAILED (-2)
const PROFILE = path.join(os.tmpdir(), 'island-workbench-ui', 'profile')
fs.rmSync(path.dirname(PROFILE), { recursive: true, force: true })
fs.mkdirSync(PROFILE, { recursive: true })
app.setPath('userData', PROFILE)

const results = []
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: String(detail ?? '') })

const TRUST = '工作台能访问网络并执行本机程序与脚本，启用等于信任它。'
// 1×1 透明 PNG —— 当"作者提供的示例图"
const PREVIEW = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const state = { acknowledged: [], activated: [], uninstalled: [], reloaded: [], exported: [], paramsSaved: [] }

const workbenches = [
  {
    id: 'builtin', name: '内置工作台', version: '1.0.0', description: '', preview: null, builtin: true, active: true, sourceDir: null,
    hasSettings: false, paramCount: 0,
    capabilities: [{ capability: 'system', label: '读取 CPU、内存、网络等系统信息' }], unacknowledged: [],
  },
  {
    id: 'ops-board', name: '运维台', version: '1.2.0', description: '一屏看服务与脚本', preview: PREVIEW, builtin: false, active: false,
    sourceDir: 'C:\\dev\\island-plugin\\ops-board', hasSettings: true, paramCount: 2,
    capabilities: [
      { capability: 'run', label: '执行本机命令与脚本' },
      { capability: 'http', label: '访问网络（含本机 127.0.0.1 上的服务）' },
      { capability: 'storage', label: '保存这个工作台自己的数据' },
    ],
    unacknowledged: ['run', 'http', 'storage'],
  },
  {
    id: 'quiet-desk', name: '安静桌面', version: '0.3.0', description: '', preview: null, builtin: false, active: false,
    sourceDir: null, hasSettings: false, paramCount: 0,
    capabilities: [{ capability: 'system', label: '读取 CPU、内存、网络等系统信息' }], unacknowledged: [],
  },
]

const stub = (channel, handler) => ipcMain.handle(channel, handler)
stub('settings:get', () => ({ idleMode: 'float', islandTop: 8, miniScale: 1, pluginOrder: [] }))
stub('settings:set-plugin-order', (_e, order) => ({ idleMode: 'float', islandTop: 8, miniScale: 1, pluginOrder: order }))
stub('host:plugins:list', () => ([]))
stub('host:plugins:issues', () => ([]))
stub('host:workbenches:list', () => ({ ok: true, trustNotice: TRUST, workbenches, issues: [{ directory: 'X:\\broken', reason: 'workbench.json 不是合法 JSON' }] }))
stub('host:workbenches:acknowledge', (_e, id, capabilities) => { state.acknowledged.push({ id, capabilities }); return { ok: true, grants: capabilities } })
stub('host:workbenches:activate', (_e, id) => {
  if (id === 'ops-board' && state.acknowledged.length === 0) return { ok: false, error: 'capabilities-not-acknowledged', missing: ['run', 'http', 'storage'] }
  state.activated.push(id)
  return { ok: true, id }
})
stub('host:workbenches:uninstall', (_e, id) => { state.uninstalled.push(id); return { ok: true } })
stub('host:workbenches:reload', (_e, id) => { state.reloaded.push(id); return { ok: true, capabilities: ['system'] } })
stub('host:workbenches:export-package', (_e, id) => { state.exported.push(id); return { ok: true, path: `C:\\Users\\me\\Downloads\\${id}-1.2.0.islandplugin`, bytes: 4096 } })
stub('host:workbenches:settings', (_e, id) => ({ ok: true, values: { city: '上海', token: 'x' }, schema: { fields: [
  { key: 'city', label: '城市', type: 'text', default: '北京' },
  { key: 'token', label: '令牌', type: 'password' },
] } }))
stub('host:workbenches:settings:set', (_e, id, patch) => { state.paramsSaved.push({ id, patch }); return { ok: true, values: patch } })
stub('host:plugins:logs', () => ({ lines: ['[info] workbench probe'] }))

async function main() {
  const win = new BrowserWindow({
    width: 960, height: 700, show: false,
    webPreferences: { preload: path.join(__dirname, '..', '..', 'dist-electron', 'preload', 'settings-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  })
  const errors = []
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) errors.push(String(message).slice(0, 200)) })
  await win.loadFile(path.join(__dirname, '..', '..', 'console-apps', 'settings', 'index.html'))
  await new Promise(resolve => setTimeout(resolve, 700))
  const js = (code) => win.webContents.executeJavaScript(code)
  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))

  check('页面无异常', errors.length === 0, errors.join(' | '))
  await js("document.querySelector('[data-tab=\"workbench\"]').click()")
  await wait(600)

  // ---- 列表层：克制 —— 只有名字 + 示例图
  check('有「工作台」分页', await js("getComputedStyle(document.querySelector('#workbench')).display !== 'none'"))
  check('信任提示渲染出来了', (await js("document.querySelector('#workbench-trust').textContent")).includes('信任'))
  check('三个工作台都渲染成卡片', await js("document.querySelectorAll('#workbench-list .wb-card').length === 3"), await js("document.querySelectorAll('#workbench-list .wb-card').length"))
  check('卡片上有名字', (await js("document.querySelector('#workbench-list .wb-card').textContent")).includes('内置工作台'))
  check('列表里**不**堆能力标签（详情才看）', await js("document.querySelectorAll('#workbench-list .wb-cap').length === 0"))
  check('列表里**不**放操作按钮（详情才看）', await js("document.querySelectorAll('#workbench-list button[data-wb-uninstall], #workbench-list button[data-wb-logs]').length === 0"))
  check('有示例图的卡片用 img', await js("!!document.querySelector('[data-wb-open=\"ops-board\"] .wb-thumb img')"))
  check('没有示例图的卡片用首字占位', await js("document.querySelector('[data-wb-open=\"quiet-desk\"] .wb-thumb .letter')?.textContent === '安'"), await js("document.querySelector('[data-wb-open=\"quiet-desk\"] .wb-thumb .letter')?.textContent"))
  check('正在使用的那个有标记', await js("document.querySelector('[data-wb-open=\"builtin\"] .wb-flag')?.textContent === '使用中'"))
  check('未加载的工作台显示原因', (await js("document.querySelector('#workbench-issues').textContent")).includes('不是合法 JSON'))

  // ---- 详情层
  await js("document.querySelector('[data-wb-open=\"ops-board\"]').click()")
  await wait(400)
  check('点卡片进详情（宿主模态框）', await js("!document.querySelector('#plugin-modal').hidden && document.querySelector('#plugin-modal-title').textContent === '运维台'"))
  check('详情里有示例图', await js("!!document.querySelector('#plugin-modal-content .wb-detail-thumb img')"))
  const caps = await js("Array.from(document.querySelectorAll('#plugin-modal-content .wb-cap')).map(el => ({ text: el.textContent, risky: el.classList.contains('risky') }))")
  check('详情里能力逐条人话列出', caps.some(c => c.text.includes('执行本机命令与脚本')) && caps.some(c => c.text.includes('访问网络')), JSON.stringify(caps.map(c => c.text)))
  check('会碰机器/网络的能力被标红', caps.filter(c => c.risky).length >= 2, JSON.stringify(caps.filter(c => c.risky).map(c => c.text)))
  check('详情里有源码目录与版本', (await js("document.querySelector('#plugin-modal-content').textContent")).includes('C:\\dev\\island-plugin\\ops-board'))
  check('内置工作台没有导出/卸载按钮', await js("(() => { document.querySelector('#plugin-modal-close').click(); document.querySelector('[data-wb-open=\"builtin\"]').click(); return !document.querySelector('#plugin-modal-content [data-wb-export]') || document.querySelector('#plugin-modal-content [data-wb-export]').hidden })()"))

  // ---- 未确认能力 → 先确认；取消则不启用
  await js("document.querySelector('#plugin-modal-close').click()")
  await js("document.querySelector('[data-wb-open=\"ops-board\"]').click()")
  await wait(300)
  await js("document.querySelector('#plugin-modal-content [data-wb-activate]').click()")
  await wait(400)
  check('未确认能力时先弹确认框', await js("document.querySelector('#plugin-modal-content').textContent.includes('确认')"))
  check('确认框里列清它要做什么', await js("document.querySelectorAll('#plugin-modal-content .wb-cap').length === 3"))
  await js("document.querySelector('#wb-cancel').click()")
  await wait(300)
  check('取消后不启用', state.activated.length === 0, JSON.stringify(state.activated))
  check('取消后也不记录确认', state.acknowledged.length === 0, JSON.stringify(state.acknowledged))

  // ---- 确认并启用
  await js("document.querySelector('[data-wb-open=\"ops-board\"]').click()")
  await wait(300)
  await js("document.querySelector('#plugin-modal-content [data-wb-activate]').click()")
  await wait(300)
  await js("document.querySelector('#wb-confirm').click()")
  await wait(600)
  check('确认后先记录能力再启用', state.acknowledged.length === 1 && state.activated.join(',') === 'ops-board', JSON.stringify({ ack: state.acknowledged, act: state.activated }))
  check('启用后有内嵌反馈（不是原生弹窗）', (await js("!document.querySelector('#workbench-notice').hidden")) && (await js("document.querySelector('#workbench-notice').textContent")).includes('已启用'), await js("document.querySelector('#workbench-notice').textContent"))

  // ---- 参数 / 日志 / 重载 / 导出
  await js("document.querySelector('[data-wb-open=\"ops-board\"]').click()")
  await wait(300)
  await js("document.querySelector('#plugin-modal-content [data-wb-params]').click()")
  await wait(400)
  check('参数走宿主渲染的表单', await js("document.querySelector('#plugin-modal-content input[data-key=\"city\"]')?.value === '上海'"))
  await js("document.querySelector('#wb-save-params').click()")
  await wait(400)
  check('保存参数走工作台参数通道', state.paramsSaved.length === 1 && state.paramsSaved[0].id === 'ops-board', JSON.stringify(state.paramsSaved))
  check('保存后有反馈', (await js("document.querySelector('#wb-save-params').textContent")).includes('已保存'))

  await js("document.querySelector('#plugin-modal-close').click()")
  await js("document.querySelector('[data-wb-open=\"ops-board\"]').click()")
  await wait(300)
  await js("document.querySelector('#plugin-modal-content [data-wb-logs]').click()")
  await wait(400)
  check('日志走宿主模态框', await js("document.querySelector('#plugin-log-body').textContent.includes('workbench probe')"))
  await js("document.querySelector('#plugin-modal-close').click()")

  await js("document.querySelector('[data-wb-open=\"ops-board\"]').click()")
  await wait(300)
  await js("document.querySelector('#plugin-modal-content [data-wb-reload]').click()")
  await wait(600)
  check('重载走工作台重载通道', state.reloaded.join(',') === 'ops-board', JSON.stringify(state.reloaded))

  await js("document.querySelector('[data-wb-open=\"ops-board\"]').click()")
  await wait(300)
  await js("document.querySelector('#plugin-modal-content [data-wb-export]').click()")
  await wait(500)
  check('控制台能导出插件包', state.exported.join(',') === 'ops-board', JSON.stringify(state.exported))
  check('导出后给出路径反馈', (await js("document.querySelector('#workbench-notice').textContent")).includes('已导出'), await js("document.querySelector('#workbench-notice').textContent"))

  // ---- 卸载：两步确认
  await js("document.querySelector('[data-wb-open=\"ops-board\"]').click()")
  await wait(300)
  await js("document.querySelector('#plugin-modal-content [data-wb-uninstall]').click()")
  await wait(200)
  check('卸载第一次点击只变成确认态', await js("document.querySelector('#plugin-modal-content [data-wb-uninstall]').textContent.includes('确认卸载')") && state.uninstalled.length === 0)
  await js("document.querySelector('#plugin-modal-content [data-wb-uninstall]').click()")
  await wait(500)
  check('第二次点击才真的卸载', state.uninstalled.join(',') === 'ops-board', JSON.stringify(state.uninstalled))

  console.log('=== 控制台管理·工作台页验收 ===')
  let failed = 0
  for (const item of results) { if (!item.ok) failed += 1; console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.detail ? `   [${item.detail}]` : ''}`) }
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  win.destroy()
  app.exit(failed ? 1 : 0)
}

app.whenReady().then(main).catch((error) => { console.error(error); app.exit(1) })
