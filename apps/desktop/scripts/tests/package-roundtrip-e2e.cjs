// 插件包"打包 → 分发 → 别人装上就能用"的端到端验收。
//
// 回答的是这个问题：**我做好的插件能不能打包给别人，别人装了是不是直接能用？**
// 所以这里不看"安装返回 ok"了事，而是真的走一遍分发链路：
//   1) 装一个真插件（含 background 脚本 + 自有 assets/ + 各种运行时垃圾）；
//   2) 用宿主自己的「导出插件包」打成 .islandplugin（不依赖插件目录里有没有 pack.ps1）；
//   3) 检查包内容：运行需要的文件都在，运行时垃圾/依赖目录没被打进去；
//   4) **把源码目录整个删掉**（模拟"换了一台机器"），只拿包安装；
//   5) 断言装完真的能跑：插件加载、后台脚本起来、页面收到事件、日志有记录。
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'
const { app, BrowserWindow, ipcMain, dialog, webContents } = require('electron')

const REPO = path.join(__dirname, '..', '..')
const SANDBOX = path.join(os.tmpdir(), 'island-package-e2e')
const PROFILE = path.join(SANDBOX, 'profile')
const USER_PLUGINS = path.join(PROFILE, 'plugins')
const DEV_ROOT = path.join(SANDBOX, 'dev')
const PLUGIN_ID = 'pack-probe'
const DEV_PLUGIN = path.join(DEV_ROOT, PLUGIN_ID)
const PACKAGE_OUT = path.join(SANDBOX, `${PLUGIN_ID}-0.1.0.islandplugin`)
const STORAGE = path.join(PROFILE, 'plugin-data', `${PLUGIN_ID}.json`)
const LOG = path.join(PROFILE, 'island-plugins', 'logs', `${PLUGIN_ID}.log`)

fs.rmSync(SANDBOX, { recursive: true, force: true })
fs.mkdirSync(USER_PLUGINS, { recursive: true })
fs.mkdirSync(path.join(DEV_PLUGIN, 'dist'), { recursive: true })
fs.mkdirSync(path.join(DEV_PLUGIN, 'resources'), { recursive: true })
fs.mkdirSync(path.join(DEV_PLUGIN, 'assets'), { recursive: true })
fs.mkdirSync(path.join(DEV_PLUGIN, 'node_modules', 'junk'), { recursive: true })
fs.mkdirSync(PROFILE, { recursive: true })
app.setPath('userData', PROFILE)

fs.writeFileSync(path.join(DEV_PLUGIN, 'plugin.json'), JSON.stringify({
  id: PLUGIN_ID, name: '打包探针', version: '0.1.0', runtime: 'web-app', priority: 50,
  entry: 'dist/index.html', resident: true,
  small: { enabled: true, width: 150, height: 40 }, medium: { width: 420, height: 200 }, large: { width: 640, height: 340 },
  background: { entry: 'resources/emit.js' },
  settings: { fields: [{ key: 'city', label: '城市', type: 'text', default: '北京' }] },
}, null, 2))
fs.writeFileSync(path.join(DEV_PLUGIN, 'dist', 'index.html'),
  '<!doctype html><html><head><meta charset="utf-8"><title>pack</title><link rel="stylesheet" href="style.css"></head><body><div id="root">pack</div><script src="app.js"></script></body></html>')
fs.writeFileSync(path.join(DEV_PLUGIN, 'dist', 'style.css'), '#root{color:#9fe8c8}')
fs.writeFileSync(path.join(DEV_PLUGIN, 'dist', 'app.js'), `
  const island = window.dynamicIsland
  const seen = []
  island.events.on('state', (payload) => {
    seen.push(payload)
    island.storage.set('received', { count: seen.length, title: payload && payload.title })
  })
  island.ui.onModeChange((mode) => island.storage.set('mode', mode))
  island.log.info('pack-probe booted')
`)
// 自有资源目录：必须被打进包里（用 allowlist 打包会把这种文件悄悄丢掉）
fs.writeFileSync(path.join(DEV_PLUGIN, 'assets', 'data.json'), JSON.stringify({ hello: 'island' }))
fs.writeFileSync(path.join(DEV_PLUGIN, 'resources', 'emit.js'), `
  let n = 0
  const timer = setInterval(() => {
    n += 1
    process.stdout.write(JSON.stringify({ type: 'state', title: 'pack-' + n }) + '\\n')
  }, 200)
  process.on('SIGTERM', () => { clearInterval(timer); process.exit(0) })
`)
// 运行时垃圾：不该进包
fs.writeFileSync(path.join(DEV_PLUGIN, 'state.json'), '{"runtime":"junk"}')
fs.writeFileSync(path.join(DEV_PLUGIN, 'debug.log'), 'noise')
fs.writeFileSync(path.join(DEV_PLUGIN, 'node_modules', 'junk', 'index.js'), 'module.exports = 1')

for (const method of ['show', 'showInactive', 'focus']) BrowserWindow.prototype[method] = function () {}

const results = []
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: String(detail ?? '') })
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 用 PowerShell + .NET 读 zip 条目名（不引第三方依赖）。 */
function zipEntries(file) {
  const { execFileSync } = require('node:child_process')
  const script = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::OpenRead('${file.replace(/'/g, "''")}').Entries | ForEach-Object { $_.FullName }`
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' })
    .split(/\r?\n/).map(line => line.trim()).filter(Boolean)
}

async function main() {
  const { PluginManager } = require(path.join(REPO, 'dist-electron', 'plugins', 'plugin-manager.js'))
  const manager = new PluginManager([USER_PLUGINS], USER_PLUGINS)
  manager.discover()
  // 先按"作者本机"的方式装上源码目录
  manager.installDirectory(DEV_PLUGIN)

  require(path.join(REPO, 'dist-electron', 'main.js'))
  await app.whenReady()
  await wait(3000)

  const pluginView = () => webContents.getAllWebContents().find(item => item.getURL().includes(PLUGIN_ID))

  // 打开控制台管理窗口，用真实的 islandSettings.exportPluginPackage 走一遍（保存对话框打桩成固定路径）
  ipcMain.emit('host:open-settings')
  let win = null
  for (let tick = 0; tick < 50 && !win; tick += 1) {
    win = BrowserWindow.getAllWindows().find(item => !item.isDestroyed() && item.webContents.getURL().includes('settings'))
    if (!win) await wait(200)
  }
  check('控制台管理窗口已创建', !!win)
  if (!win) { app.exit(1); return }
  check('打包探针已安装并加载', !!pluginView())

  // ---- 1) 导出插件包（宿主自己打包，插件目录里没有 pack.ps1）
  check('插件目录里确实没有 pack.ps1（所以以前没法分发）', !fs.existsSync(path.join(DEV_PLUGIN, 'pack.ps1')))
  let savedTo = null
  dialog.showSaveDialog = async (parentOrOptions, maybeOptions) => {
    const options = maybeOptions ?? parentOrOptions
    // 记下宿主建议的默认文件名，验证它确实带上了 id 与版本
    savedTo = options?.defaultPath ?? null
    return { canceled: false, filePath: PACKAGE_OUT }
  }
  const exported = await win.webContents.executeJavaScript(`window.islandSettings.exportPluginPackage('${PLUGIN_ID}')`)
  check('导出插件包成功', exported?.ok === true && fs.existsSync(PACKAGE_OUT), JSON.stringify(exported))
  check('默认文件名是 <id>-<version>.islandplugin', String(savedTo ?? '').endsWith(`${PLUGIN_ID}-0.1.0.islandplugin`), String(savedTo))

  // ---- 2) 包内容检查
  const entries = zipEntries(PACKAGE_OUT)
  const has = (name) => entries.some(entry => entry.replace(/\\/g, '/').replace(/^\.\//, '') === name)
  check('包里有 plugin.json', has('plugin.json'), entries.join(','))
  check('包里有入口页面', has('dist/index.html'), entries.join(','))
  check('包里有 app.js 与 style.css', has('dist/app.js') && has('dist/style.css'), entries.join(','))
  check('后台脚本被打进包（否则到别人机器上就是"检测不到数据"）', has('resources/emit.js'), entries.join(','))
  check('插件自有资源目录被打进包', has('assets/data.json'), entries.join(','))
  check('运行时垃圾没进包（state.json / *.log）', !has('state.json') && !entries.some(e => e.endsWith('.log')), entries.join(','))
  check('依赖目录没进包（node_modules）', !entries.some(entry => entry.replace(/\\/g, '/').startsWith('node_modules/')), entries.join(','))

  // ---- 3) 模拟换机器：删掉源码目录，只留包
  const installedDir = path.join(USER_PLUGINS, PLUGIN_ID)
  fs.rmSync(DEV_PLUGIN, { recursive: true, force: true })
  await win.webContents.executeJavaScript(`window.islandSettings.uninstall('${PLUGIN_ID}')`)
  await wait(1200)
  check('已卸载源码安装（模拟换了一台机器）', !fs.existsSync(installedDir))

  // ---- 4) 用包安装
  const installed = await win.webContents.executeJavaScript(`window.islandSettings.installPluginPackage(${JSON.stringify(PACKAGE_OUT)})`)
  check('导入插件包成功', installed?.ok === true, JSON.stringify(installed))
  check('包安装后没有再登记源码目录（是独立安装）', (() => {
    const sources = path.join(USER_PLUGINS, 'sources.json')
    if (!fs.existsSync(sources)) return true
    return !(PLUGIN_ID in JSON.parse(fs.readFileSync(sources, 'utf8')))
  })())
  check('安装目录里文件齐全', ['plugin.json', 'dist/index.html', 'resources/emit.js', 'assets/data.json'].every(rel => fs.existsSync(path.join(installedDir, rel))))
  check('运行时垃圾没有被装进去', !fs.existsSync(path.join(installedDir, 'state.json')))

  // ---- 5) 真正跑起来：后台脚本 + 页面事件
  await wait(4000)
  const storage = fs.existsSync(STORAGE) ? JSON.parse(fs.readFileSync(STORAGE, 'utf8')) : {}
  check('包安装的插件页面加载了', !!pluginView())
  check('后台脚本在跑（页面收到自己脚本的事件）', Number(storage.received?.count ?? 0) >= 2, JSON.stringify(storage.received))
  check('事件内容正确（不是空 payload）', String(storage.received?.title ?? '').startsWith('pack-'), JSON.stringify(storage.received))
  check('插件参数 schema 也跟着包一起过来了（装完就能在控制台配）', (() => {
    const manifest = JSON.parse(fs.readFileSync(path.join(installedDir, 'plugin.json'), 'utf8'))
    return Array.isArray(manifest.settings?.fields) && manifest.settings.fields[0]?.key === 'city'
  })())
  const log = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : ''
  check('日志里能看到"从插件包安装"', log.includes('已从插件包安装'), log.slice(-200))

  let failed = 0
  for (const item of results) { if (!item.ok) failed += 1; console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.detail ? `   [${item.detail}]` : ''}`) }
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  app.exit(failed ? 1 : 0)
}

app.whenReady().then(main).catch((error) => { console.error(error); app.exit(1) })
