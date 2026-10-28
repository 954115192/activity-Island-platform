// 安装版（打包产物）能不能真正加载自己的界面 —— 针对 asar 的验收。
//
// 为什么单独测这个：源码运行时界面从普通目录加载，但**安装版是从 app.asar 里加载**。
// 如果 `loadFile` 读不了 asar 内的路径，装完打开控制台就是一片空白 ——
// 这是"装出来能不能用"最容易漏掉、又最致命的一环，不能靠假设。
//
// 同时验证 assets 走 resources/assets（asar 外面）时图标能读到。
// 需要先 `npm run dist` 产出 release/win-unpacked；没有产物时跳过并给出说明。
const path = require('node:path')
const fs = require('node:fs')

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'
const { app, BrowserWindow, nativeImage } = require('electron')

const REPO = path.join(__dirname, '..', '..')
const UNPACKED = path.join(REPO, 'release', 'win-unpacked')
const ASAR = path.join(UNPACKED, 'resources', 'app.asar')
const ASSETS = path.join(UNPACKED, 'resources', 'assets')

// 必须用独立 profile：和用户正在运行的实例抢同一个 userData 时，
// loadFile 会以 ERR_FAILED (-2) 失败（本会话里第二次踩到这个坑）。
const PROFILE = path.join(require('node:os').tmpdir(), 'island-asar-e2e', 'profile')
fs.rmSync(path.dirname(PROFILE), { recursive: true, force: true })
fs.mkdirSync(PROFILE, { recursive: true })
app.setPath('userData', PROFILE)

for (const method of ['show', 'showInactive', 'focus']) BrowserWindow.prototype[method] = function () {}

const results = []
// 立即输出：这个测试会真的开窗口，万一某个页面把渲染进程搞崩，
// 缓到最后再打印就什么线索都没有了（实测踩过：整个进程静默退出、零输出）。
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail: String(detail ?? '') })
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `   [${detail}]` : ''}\n`)
}

// asar 内路径解析：Electron 里用 `app.asar/xxx` 这种形式访问
const inAsar = (relative) => path.join(ASAR, relative)

/**
 * 复用一个窗口依次加载各个页面。
 * 不要每页建一个窗口再 destroy：连续 create→load→destroy 会让渲染进程崩掉，
 * 表现为下一页 ERR_FAILED (-2)，看起来像"打包坏了"，其实是测试自己的问题（实测踩过）。
 */
let sharedWindow = null
async function loadAndProbe(file, probe) {
  if (!sharedWindow || sharedWindow.isDestroyed()) {
    sharedWindow = new BrowserWindow({ show: false, width: 900, height: 640, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false } })
  }
  try {
    await sharedWindow.loadFile(file)
    const value = await sharedWindow.webContents.executeJavaScript(probe)
    return { ok: true, value, url: sharedWindow.webContents.getURL() }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

async function main() {
  check('打包产物存在（先跑 npm run dist）', fs.existsSync(ASAR), ASAR)
  if (!fs.existsSync(ASAR)) {
    console.log('=== 安装版界面加载验收 ===')
    console.log('SKIP  没有 release/win-unpacked，先运行 npm run dist')
    app.exit(0)
    return
  }

  // 1) 三个控制台页面都要能从 asar 里加载出来（不是空白页）
  const pages = [
    ['控制台管理页面', 'console-apps/settings/index.html', "document.querySelectorAll('nav [data-tab]').length >= 3 && !!document.querySelector('#plugin-list') && !!document.querySelector('#plugin-add')"],
    ['工作台页面', 'console-apps/workbench/index.html', "!!document.body && document.body.children.length > 0"],
    ['小岛渲染层', 'dist/index.html', "!!document.querySelector('#host-root .island-shell')"],
  ]
  for (const [label, relative, probe] of pages) {
    const file = inAsar(relative)
    check(`asar 里有 ${relative}`, fs.existsSync(file), file)
    const result = await loadAndProbe(file, `(() => { try { return ${probe} } catch (e) { return 'ERR:' + e.message } })()`)
    check(`${label} 能从 asar 加载并渲染`, result.ok && result.value === true, result.ok ? `probe=${result.value}` : result.error)
  }

  // 2) preload 脚本也要能从 asar 里加载（加载失败会静默变成"没有 API"）
  const preloads = ['dist-electron/preload/host-preload.js', 'dist-electron/preload/plugin-preload.js', 'dist-electron/preload/settings-preload.js', 'dist-electron/preload/workbench-preload.js']
  for (const relative of preloads) {
    check(`asar 里有 ${relative}`, fs.existsSync(inAsar(relative)), relative)
  }

  // 3) 图标走的是 resources/assets（asar 外面）—— 打包后必须是非空图
  for (const name of ['icon.ico', 'tray.png', 'tray@2x.png', 'icon.png']) {
    const file = path.join(ASSETS, name)
    const exists = fs.existsSync(file)
    let size = { width: 0, height: 0 }
    if (exists) { const image = nativeImage.createFromPath(file); size = image.isEmpty() ? { width: 0, height: 0 } : image.getSize() }
    check(`打包后能读到 ${name}（非空图）`, exists && size.width > 0, exists ? JSON.stringify(size) : '文件不存在')
  }

  // 4) 安装版本体与卸载器都在
  check('主程序 exe 存在', fs.existsSync(path.join(UNPACKED, 'Activity Island.exe')))
  const setup = fs.readdirSync(path.join(REPO, 'release')).find(name => name.endsWith('-setup.exe'))
  check('安装包 exe 存在', !!setup, setup ?? '没找到 *-setup.exe')

  process.stdout.write('=== 安装版界面加载验收（asar）===\n')
  let failed = 0
  for (const item of results) if (!item.ok) failed += 1
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  app.exit(failed ? 1 : 0)
}

app.whenReady().then(main).catch((error) => { console.error(error); app.exit(1) })
