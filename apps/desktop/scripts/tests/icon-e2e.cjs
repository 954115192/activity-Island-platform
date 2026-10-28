// 图标验收：assets 里的图标能用（托盘 / 任务栏），真实宿主能带着它启动。
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'
const electron = require('electron')
const { app, BrowserWindow, nativeImage } = electron

const REPO = path.join(__dirname, '..', '..')
const SANDBOX = path.join(os.tmpdir(), 'island-icon-e2e')
const PROFILE = path.join(SANDBOX, 'profile')
fs.rmSync(SANDBOX, { recursive: true, force: true })
fs.mkdirSync(path.join(PROFILE, 'plugins'), { recursive: true })
fs.mkdirSync(PROFILE, { recursive: true })
app.setPath('userData', PROFILE)

// 记录宿主到底读了哪些图标文件（Tray 实例拿不到图，但"它请求了哪张图"能看见）
const loadedIcons = []
const realCreateFromPath = nativeImage.createFromPath
try {
  nativeImage.createFromPath = (file) => { loadedIcons.push(String(file)); return realCreateFromPath.call(nativeImage, file) }
} catch { /* 改不了就算了 */ }

const results = []
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: String(detail ?? '') })
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

for (const method of ['show', 'showInactive', 'focus']) BrowserWindow.prototype[method] = function () {}

async function main() {
  const ico = nativeImage.createFromPath(path.join(REPO, 'assets', 'icon.ico'))
  const tray = nativeImage.createFromPath(path.join(REPO, 'assets', 'tray.png'))
  check('icon.ico 能加载', !ico.isEmpty(), JSON.stringify(ico.getSize()))
  check('tray.png 是 32×32', tray.getSize().width === 32 && tray.getSize().height === 32, JSON.stringify(tray.getSize()))
  check('托盘图不是空图（空图会被 Windows 隐藏）', tray.toPNG().length > 200, `${tray.toPNG().length} bytes`)
  const icoBytes = fs.readFileSync(path.join(REPO, 'assets', 'icon.ico'))
  const count = icoBytes.readUInt16LE(4)
  const sizes = Array.from({ length: count }, (_, index) => icoBytes[6 + index * 16] || 256)
  check('ico 是多尺寸的（任务栏各档 DPI 都不糊）', count >= 5 && sizes.includes(16) && sizes.includes(256), sizes.join(','))

  require(path.join(REPO, 'dist-electron', 'main.js'))
  await app.whenReady()
  await wait(2500)
  check('宿主托盘读的就是新图标', loadedIcons.some(file => file.endsWith('tray.png')), loadedIcons.join(' | ') || '（没记录到）')
  check('窗口也带上了图标', loadedIcons.some(file => file.endsWith('icon.ico')), loadedIcons.length ? '' : '（没记录到）')

  console.log('=== 图标验收 ===')
  let failed = 0
  for (const item of results) { if (!item.ok) failed += 1; console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.detail ? `   [${item.detail}]` : ''}`) }
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  app.exit(failed ? 1 : 0)
}

app.whenReady().then(main).catch((error) => { console.error(error); app.exit(1) })
