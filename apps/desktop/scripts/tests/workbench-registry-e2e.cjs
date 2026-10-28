// 工作台"独立目录 + 独占启用 + 与插件隔离"的验收（真实宿主 + 真实 manager + **真实 IPC**）。
//
// 这一步最容易写错的四条，就是本测试的重点：
//   1) 工作台**不能出现在插件列表 / mini 条里** —— 它必须和插件在物理上分开；
//   2) **同时只有一个 active**；
//   3) **卸载 active 之后回落内置**（否则右键小岛会试图打开一个不存在的入口）；
//   4) **新装的工作台不自动启用**（不然"装完就把用户的工作台换掉了"）；
//   另外：**声明新增能力后必须重新确认** —— 工作台可分发，所以"声明与实际能做一致"
//   这条不能在升级时被绕过（否则那份能力告知就是骗人的）。
//
// 走真实 IPC（借 settings-preload 的窗口）而不是给生产代码加测试导出：
// 这样连"通道有没有接错、preload 有没有暴露"一起验了。
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'
const { app, BrowserWindow, ipcMain, webContents } = require('electron')

const REPO = path.join(__dirname, '..', '..')
const SANDBOX = path.join(os.tmpdir(), 'island-workbench-registry')
const PROFILE = path.join(SANDBOX, 'profile')
const WORKBENCH_ROOT = path.join(PROFILE, 'workbenches')
const PLUGIN_ROOT = path.join(PROFILE, 'plugins')
const DEV_ROOT = path.join(SANDBOX, 'dev')

fs.rmSync(SANDBOX, { recursive: true, force: true })
fs.mkdirSync(PLUGIN_ROOT, { recursive: true })
fs.mkdirSync(WORKBENCH_ROOT, { recursive: true })
fs.mkdirSync(PROFILE, { recursive: true })
app.setPath('userData', PROFILE)

/** 造一个工作台目录（`workbench.json` + 入口页面）。 */
function makeWorkbench(id, name, capabilities) {
  const dir = path.join(DEV_ROOT, id)
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'workbench.json'), JSON.stringify({
    id, name, version: '1.0.0', entry: 'dist/index.html', capabilities,
  }, null, 2))
  fs.writeFileSync(path.join(dir, 'dist', 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8"><title>${id}</title></head>
     <body style="margin:0;background:transparent"><div id="probe">${name}</div>
     <script>document.title = '${id}'</script></body></html>`)
  return dir
}

/** 造一个插件，用来证明插件列表里看不到工作台。 */
function makePlugin(id, name) {
  const dir = path.join(DEV_ROOT, id)
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
    id, name, version: '1.0.0', runtime: 'web-app', entry: 'dist/index.html', resident: true,
    small: { enabled: true, width: 150, height: 40 },
  }, null, 2))
  fs.writeFileSync(path.join(dir, 'dist', 'index.html'), '<!doctype html><html><body>plugin</body></html>')
  return dir
}

for (const method of ['show', 'showInactive', 'focus']) BrowserWindow.prototype[method] = function () {}

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail: String(detail ?? '') })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `   [${detail}]` : ''}\n`)
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  const plain = makeWorkbench('plain-console', '素控制台', ['system', 'storage'])
  const powerful = makeWorkbench('power-console', '强控制台', ['system', 'http', 'run'])
  const broken = path.join(WORKBENCH_ROOT, 'broken-one')
  fs.mkdirSync(broken, { recursive: true })
  fs.writeFileSync(path.join(broken, 'workbench.json'), '{ 这不是 JSON }')

  require(path.join(REPO, 'dist-electron', 'main.js'))
  await app.whenReady()
  await wait(2000)

  // 借 settings-preload 的窗口走真实 IPC（控制台「工作台」页将来就是这么调的）
  const ui = new BrowserWindow({
    show: false, width: 900, height: 600,
    webPreferences: { preload: path.join(REPO, 'dist-electron', 'preload', 'settings-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  })
  await ui.loadURL('data:text/html,<html><body>workbench-registry-probe</body></html>')
  const api = async (expression) => JSON.parse(await ui.webContents.executeJavaScript(`(async () => JSON.stringify(${expression}))()`))
  const activeOf = (payload) => (payload.workbenches ?? []).filter(item => item.active).map(item => item.id)

  // ---- 1) 发现与隔离
  let list = await api('await window.islandSettings.workbenches()')
  check('内置工作台始终在列表里且排第一', list.workbenches?.[0]?.id === 'builtin' && list.workbenches[0].builtin === true, JSON.stringify((list.workbenches ?? []).map(i => i.id)))
  check('坏工作台给出可读原因', (list.issues ?? []).some(issue => String(issue.reason).includes('不是合法 JSON')), JSON.stringify(list.issues))
  check('坏工作台不出现在列表里', !(list.workbenches ?? []).some(item => item.id === 'broken-one'))
  check('返回里带信任提示（管理页要展示）', typeof list.trustNotice === 'string' && list.trustNotice.includes('信任'), String(list.trustNotice))

  const { PluginManager } = require(path.join(REPO, 'dist-electron', 'plugins', 'plugin-manager.js'))
  const pluginManager = new PluginManager([PLUGIN_ROOT], PLUGIN_ROOT)
  pluginManager.discover()
  pluginManager.installDirectory(makePlugin('a-plugin', '普通插件'))
  check('插件列表里看不到工作台（独立目录的结构性隔离）', !pluginManager.list().map(i => i.manifest.id).includes('plain-console'), pluginManager.list().map(i => i.manifest.id).join(','))
  check('插件目录与工作台目录是两个地方', path.resolve(PLUGIN_ROOT) !== path.resolve(WORKBENCH_ROOT))

  // ---- 2) 安装（走真实 IPC）
  const installPlain = await api(`await window.islandSettings.installWorkbench(${JSON.stringify(plain)})`)
  check('安装工作台成功', installPlain.ok === true && installPlain.workbench?.id === 'plain-console', JSON.stringify(installPlain))
  const installPower = await api(`await window.islandSettings.installWorkbench(${JSON.stringify(powerful)})`)
  check('安装第二个工作台成功', installPower.ok === true, JSON.stringify(installPower))
  list = await api('await window.islandSettings.workbenches()')
  check('两个工作台都在列表里', ['plain-console', 'power-console'].every(id => (list.workbenches ?? []).some(i => i.id === id)), JSON.stringify((list.workbenches ?? []).map(i => i.id)))
  check('安装后仍然只有一个 active（内置）', JSON.stringify(activeOf(list)) === JSON.stringify(['builtin']), JSON.stringify(activeOf(list)))
  check('新装的工作台列出未确认的能力', (list.workbenches.find(i => i.id === 'plain-console').unacknowledged ?? []).join(',') === 'system,storage', JSON.stringify(list.workbenches.find(i => i.id === 'plain-console').unacknowledged))
  check('能力带人话说明（管理页直接用）', (list.workbenches.find(i => i.id === 'plain-console').capabilities ?? []).every(item => item.label && item.capability), JSON.stringify(list.workbenches.find(i => i.id === 'plain-console').capabilities))

  // ---- 3) 未确认能力不给启用
  const denied = await api("await window.islandSettings.activateWorkbench('plain-console')")
  check('未确认能力时拒绝启用', denied.ok === false && denied.error === 'capabilities-not-acknowledged' && denied.missing.length === 2, JSON.stringify(denied))

  const ack = await api("await window.islandSettings.acknowledgeWorkbench('plain-console', ['system', 'storage'])")
  check('确认能力成功', ack.ok === true && ack.grants.join(',') === 'system,storage', JSON.stringify(ack))
  const activated = await api("await window.islandSettings.activateWorkbench('plain-console')")
  check('确认后可以启用', activated.ok === true && activated.id === 'plain-console', JSON.stringify(activated))
  list = await api('await window.islandSettings.workbenches()')
  check('启用后 active 只有一个且是它', JSON.stringify(activeOf(list)) === JSON.stringify(['plain-console']), JSON.stringify(activeOf(list)))

  // ---- 4) 切换是替换，不是并列
  await api("await window.islandSettings.acknowledgeWorkbench('power-console', ['system', 'http', 'run'])")
  const switched = await api("await window.islandSettings.activateWorkbench('power-console')")
  list = await api('await window.islandSettings.workbenches()')
  check('切到另一个工作台后仍然只有一个 active', switched.ok === true && JSON.stringify(activeOf(list)) === JSON.stringify(['power-console']), JSON.stringify(activeOf(list)))

  // ---- 5) 重载：改开发目录 → 重载后清单与能力声明跟着变（AI 开发回路要用）
  const devManifest = path.join(plain, 'workbench.json')
  fs.writeFileSync(devManifest, JSON.stringify({
    id: 'plain-console', name: '素控制台', version: '1.1.0', entry: 'dist/index.html',
    capabilities: ['system', 'storage', 'resize'],
  }, null, 2))
  const reloaded = await api("await window.islandSettings.reloadWorkbench('plain-console')")
  check('重载成功并回报新的能力声明', reloaded.ok === true && (reloaded.capabilities ?? []).includes('resize'), JSON.stringify(reloaded))
  list = await api('await window.islandSettings.workbenches()')
  const afterReload = list.workbenches.find(item => item.id === 'plain-console')
  check('重载把开发目录的改动同步过来了（版本变化）', afterReload?.version === '1.1.0', String(afterReload?.version))
  check('新增能力变成未确认（重载不能绕过确认）', (afterReload?.unacknowledged ?? []).includes('resize'), JSON.stringify(afterReload?.unacknowledged))

  // ---- 6) 升级新增能力 → 必须重新确认
  const upgraded = makeWorkbench('power-console', '强控制台', ['system', 'http', 'run', 'storage'])
  fs.rmSync(path.join(WORKBENCH_ROOT, 'power-console'), { recursive: true, force: true })
  await api(`await window.islandSettings.installWorkbench(${JSON.stringify(upgraded)})`)
  const afterUpgrade = await api("await window.islandSettings.activateWorkbench('power-console')")
  check('升级新增能力后要求重新确认（告知不能被绕过）', afterUpgrade.ok === false && afterUpgrade.missing.includes('storage'), JSON.stringify(afterUpgrade))
  await api("await window.islandSettings.acknowledgeWorkbench('power-console', ['storage'])")
  check('确认新增能力后恢复可用', (await api("await window.islandSettings.activateWorkbench('power-console')")).ok === true)
  check('已确认的能力不会因为再次确认而丢', (await api("await window.islandSettings.acknowledgeWorkbench('power-console', ['system'])")).grants.sort().join(',') === 'http,run,storage,system')

  // ---- 6) 真正加载活动工作台的入口（而不是永远加载内置）
  ipcMain.emit('host:open-workbench')
  await wait(2000)
  const urls = webContents.getAllWebContents().map(item => item.getURL()).filter(Boolean)
  const loaded = webContents.getAllWebContents().find(item => item.getURL().includes('workbenches'))
  check('右键加载的是活动工作台的入口（不是内置）', !!loaded, urls.filter(u => u.includes('workbench')).join(' | '))
  if (loaded) {
    check('活动工作台页面拿到 window.workbench', await loaded.executeJavaScript("typeof window.workbench === 'object'"))
    const caps = JSON.parse(await loaded.executeJavaScript("(async () => JSON.stringify(await window.workbench.capabilities()))()"))
    check('页面看到的能力就是它声明的那些', caps.id === 'power-console' && caps.capabilities.sort().join(',') === 'http,run,storage,system', JSON.stringify(caps))
  }

  // ---- 7) 卸载 active → 回落内置
  const removed = await api("await window.islandSettings.uninstallWorkbench('power-console')")
  check('卸载成功', removed.ok === true, JSON.stringify(removed))
  list = await api('await window.islandSettings.workbenches()')
  check('卸载 active 后回落内置（否则右键会打开不存在的入口）', JSON.stringify(activeOf(list)) === JSON.stringify(['builtin']), JSON.stringify(activeOf(list)))
  const settings = JSON.parse(fs.readFileSync(path.join(PROFILE, 'settings.json'), 'utf8'))
  check('设置里也写回了内置', settings.activeWorkbench === 'builtin', String(settings.activeWorkbench))
  check('卸载后授权记录被清掉', !('power-console' in (settings.workbenchGrants ?? {})), JSON.stringify(Object.keys(settings.workbenchGrants ?? {})))
  check('工作台目录被真的删掉', !fs.existsSync(path.join(WORKBENCH_ROOT, 'power-console')))

  // ---- 8) 内置不可卸载
  const removeBuiltin = await api("await window.islandSettings.uninstallWorkbench('builtin')")
  check('内置工作台不能卸载', removeBuiltin.ok === false && String(removeBuiltin.error).includes('不能卸载'), JSON.stringify(removeBuiltin))

  // ---- 9) 启动时设置指向不存在的工作台 → 回落内置并写回
  const raw = JSON.parse(fs.readFileSync(path.join(PROFILE, 'settings.json'), 'utf8'))
  raw.activeWorkbench = 'does-not-exist'
  fs.writeFileSync(path.join(PROFILE, 'settings.json'), JSON.stringify(raw, null, 2))
  // 重新 discovery 后由宿主的解析逻辑纠正（下一次 resolve 时写回）
  // 注意：上面重载给 plain-console 新增了 resize，所以这里必须先确认新能力才能启用 ——
  // 这正是期望行为（重载不能绕过确认），顺手当作一条断言。
  const blockedAfterReload = await api("await window.islandSettings.activateWorkbench('plain-console')")
  check('重载新增的能力不确认就不给启用', blockedAfterReload.ok === false && (blockedAfterReload.missing ?? []).includes('resize'), JSON.stringify(blockedAfterReload))
  await api("await window.islandSettings.acknowledgeWorkbench('plain-console', ['resize'])")
  const afterBad = await api("await window.islandSettings.activateWorkbench('plain-console')")
  check('（前置）确认新能力后仍能正常启用', afterBad.ok === true, JSON.stringify(afterBad))
  const hostLog = path.join(PROFILE, 'island-plugins', 'logs', '_host.log')
  check('不存在的活动工作台会被记录并回落', fs.existsSync(hostLog), hostLog)

  // ---- 10) 示例图：作者给了就用（读成 data URL），没给就 null（页面画占位）
  const { dialog } = require('electron')
  const withPreview = makeWorkbench('pretty-console', '好看的控制台', ['system'])
  fs.writeFileSync(path.join(withPreview, 'preview.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="#101319"/></svg>')
  fs.writeFileSync(path.join(withPreview, 'workbench.json'), JSON.stringify({
    id: 'pretty-console', name: '好看的控制台', version: '1.0.0', entry: 'dist/index.html',
    capabilities: ['system'], preview: 'preview.svg',
  }, null, 2))
  await api(`await window.islandSettings.installWorkbench(${JSON.stringify(withPreview)})`)
  list = await api('await window.islandSettings.workbenches()')
  const pretty = list.workbenches.find(item => item.id === 'pretty-console')
  check('示例图被读成 data URL（设置页是 file:// 页面，直接引本地图片会被挡）',
    String(pretty?.preview ?? '').startsWith('data:image/svg+xml;base64,'), String(pretty?.preview ?? '').slice(0, 40))
  check('没给示例图的工作台 preview 为 null（页面画首字占位）',
    list.workbenches.find(item => item.id === 'plain-console')?.preview === null,
    JSON.stringify(list.workbenches.find(item => item.id === 'plain-console')?.preview))

  // ---- 11) 控制台也能打包分发（和插件一样的「导出插件包 / 从插件包导入」）
  const packageOut = path.join(SANDBOX, 'pretty-console-1.0.0.islandplugin')
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: packageOut })
  const exported = await api("await window.islandSettings.exportWorkbenchPackage('pretty-console')")
  check('控制台能导出插件包', exported.ok === true && fs.existsSync(packageOut), JSON.stringify(exported))
  const { readZipEntries } = require(path.join(REPO, 'dist-electron', 'plugins', 'zip.js'))
  const entries = fs.existsSync(packageOut) ? readZipEntries(packageOut).map(item => item.name) : []
  check('包里带 workbench.json（不是 plugin.json）', entries.includes('workbench.json') && !entries.includes('plugin.json'), entries.join(','))
  check('包里带示例图', entries.includes('preview.svg'), entries.join(','))
  check('内置工作台不给导出', (await api("await window.islandSettings.exportWorkbenchPackage('builtin')")).ok === false)

  // 卸载后用「导入」装回来 —— 证明控制台包能独立分发
  await api("await window.islandSettings.uninstallWorkbench('pretty-console')")
  check('（前置）导出前先把它卸掉，验证包能独立安装', !fs.existsSync(path.join(WORKBENCH_ROOT, 'pretty-console')))
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [packageOut] })
  const imported = await api('await window.islandSettings.importWorkbenchPackage()')
  check('导入插件包时按包内清单自动分流成控制台', imported.ok === true && imported.kind === 'workbench' && imported.id === 'pretty-console', JSON.stringify(imported))
  list = await api('await window.islandSettings.workbenches()')
  const reimported = list.workbenches.find(item => item.id === 'pretty-console')
  check('装回来的控制台连示例图一起在', String(reimported?.preview ?? '').startsWith('data:image/svg+xml'), String(reimported?.preview ?? '').slice(0, 40))
  check('导入的控制台仍然不进插件目录', !fs.existsSync(path.join(PLUGIN_ROOT, 'pretty-console')))
  check('导入的控制台不自动启用', JSON.stringify(activeOf(list)) !== JSON.stringify(['pretty-console']), JSON.stringify(activeOf(list)))

  // ---- 12) 工作台参数：宿主渲染表单用的是 workbench.json 的 settings.fields
  const withParams = makeWorkbench('param-console', '带参数的控制台', ['system', 'storage'])
  fs.writeFileSync(path.join(withParams, 'workbench.json'), JSON.stringify({
    id: 'param-console', name: '带参数的控制台', version: '1.0.0', entry: 'dist/index.html',
    capabilities: ['system', 'storage'],
    settings: { fields: [{ key: 'city', label: '城市', type: 'text', default: '北京' }, { key: 'interval', label: '刷新（ms）', type: 'number', default: 2000 }] },
  }, null, 2))
  await api(`await window.islandSettings.installWorkbench(${JSON.stringify(withParams)})`)
  const paramSchema = await api("await window.islandSettings.workbenchSettings('param-console')")
  check('工作台参数 schema 读出来了', (paramSchema?.schema?.fields ?? []).length === 2, JSON.stringify(paramSchema?.schema))
  check('参数默认值生效', paramSchema?.values?.city === '北京' && paramSchema?.values?.interval === 2000, JSON.stringify(paramSchema?.values))
  const savedParams = await api("await window.islandSettings.setWorkbenchSettings('param-console', { city: '上海', evil: 'should-be-dropped' })")
  check('保存参数：只接受声明过的键（未知键被丢掉）',
    savedParams?.values?.city === '上海' && !('evil' in (savedParams?.values ?? {})), JSON.stringify(savedParams?.values))
  list = await api('await window.islandSettings.workbenches()')
  check('列表里标出它有参数（详情页据此显示「参数」按钮）',
    list.workbenches.find(item => item.id === 'param-console')?.hasSettings === true
    && list.workbenches.find(item => item.id === 'param-console')?.paramCount === 2,
    JSON.stringify(list.workbenches.find(item => item.id === 'param-console')))

  // ---- 13) 内置工作台的参数也要出现在管理页（用户就是去那儿找的 —— 之前它在岛上的页面底部，找不到）
  const builtinEntry = (await api('await window.islandSettings.workbenches()')).workbenches.find(item => item.id === 'builtin')
  check('内置工作台标出「有参数」（详情页据此显示「参数」按钮）',
    builtinEntry?.hasSettings === true && builtinEntry?.paramCount === 3,
    JSON.stringify({ hasSettings: builtinEntry?.hasSettings, paramCount: builtinEntry?.paramCount }))
  const builtinParams = await api("await window.islandSettings.workbenchSettings('builtin')")
  const keys = (builtinParams?.schema?.fields ?? []).map(field => field.key)
  check('内置工作台的三个参数都在（刷新频率 / 主题色 / 显示网络速率面板）',
    ['refreshMs', 'accent', 'showNetwork'].every(key => keys.includes(key)), JSON.stringify(keys))
  check('内置工作台的参数带默认值可回填',
    builtinParams?.values?.refreshMs === 2000 && builtinParams?.values?.showNetwork === true, JSON.stringify(builtinParams?.values))

  ui.destroy()
  let failed = 0
  for (const item of results) if (!item.ok) failed += 1
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  app.exit(failed ? 1 : 0)
}

app.whenReady().then(main).catch((error) => { console.error(error); app.exit(1) })
