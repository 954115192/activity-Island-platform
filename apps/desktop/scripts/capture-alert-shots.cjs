// 一次性截图：真机触发 alert，把小岛区域裁出来合成到深色底上，看清三档描边光晕。
// 用法：npx electron scripts/capture-alert-shots.cjs
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'
const { app, BrowserWindow, webContents, nativeImage, desktopCapturer, screen } = require('electron')

const REPO = path.join(__dirname, '..')
const OUT = path.join(os.tmpdir(), 'island-alert-shots')
const SANDBOX = path.join(os.tmpdir(), 'island-alert-shots-sandbox')
const PROFILE = path.join(SANDBOX, 'profile')
const USER_PLUGINS = path.join(PROFILE, 'plugins')

fs.rmSync(SANDBOX, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })
fs.mkdirSync(USER_PLUGINS, { recursive: true })
fs.mkdirSync(PROFILE, { recursive: true })
app.setPath('userData', PROFILE)
fs.writeFileSync(path.join(PROFILE, 'settings.json'), JSON.stringify({ idleMode: 'float', islandTop: 5, miniScale: 1, pluginOrder: [] }))

// 探针插件：平时小岛显示余额；收到 fire 事件就发一条提醒。
const PLUGIN = 'alert-probe'
const dir = path.join(SANDBOX, 'dev', PLUGIN)
fs.mkdirSync(path.join(dir, 'dist'), { recursive: true })
fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
  id: PLUGIN, name: '余额哨兵', version: '0.1.0', runtime: 'web-app', priority: 50,
  entry: 'dist/index.html', resident: true,
  small: { enabled: true, width: 168, height: 40 }, medium: { width: 420, height: 200 }, large: { width: 640, height: 340 },
}, null, 2))
fs.writeFileSync(path.join(dir, 'dist', 'index.html'), `<!doctype html><html><head><meta charset="utf-8">
<style>
  html,body,#app{width:100%;height:100%;margin:0;overflow:hidden;background:transparent}
  #app{display:flex;align-items:center;gap:8px;padding:0 14px;color:var(--island-ink,#F4F4F5);
       font:500 13px/1 "Segoe UI Variable","Segoe UI",system-ui,sans-serif}
  .dot{width:7px;height:7px;border-radius:50%;flex:0 0 7px}
  .lbl{color:var(--island-ink-dim,#A1A1AA)}
  .val{font-weight:600;font-variant-numeric:tabular-nums}
</style></head><body><div id="app"></div>
<script>
  const app = document.getElementById('app')
  const render = (state) => {
    const color = state.level === 'critical' ? '#EF4444' : state.level === 'warn' ? '#F59E0B' : '#22C55E'
    app.innerHTML = '<span class="dot" style="background:' + color + '"></span>'
      + '<span class="lbl">' + state.label + '</span><span class="val">' + state.value + '</span>'
  }
  render({ label: '余额', value: '¥2.56' })
  window.dynamicIsland.events.on('fire', (payload) => {
    if (payload && payload.dismiss) {
      // 主动收起当前的提醒（等同 ui:close），用来截"无提醒"的对照图。
      if (window.dynamicIsland.ui && window.dynamicIsland.ui.close) window.dynamicIsland.ui.close()
      render({ label: '余额', value: '¥2.56' })
      return
    }
    render({ label: payload.label, value: payload.value, level: payload.level })
    // 固定 key：同 key 覆盖会立即顶替当前这条，而不是排到队尾（队列要等 ttl 过期才轮播）。
    window.dynamicIsland.alert({ key: 'probe:alert', level: payload.level, ttl: 30000 })
  })
</script></body></html>`)

// 这张图要靠全屏捕获，所以宿主窗口必须真实显示 —— 不能像其它 e2e 那样 mock 掉 show()。

const wait = (ms) => new Promise(r => setTimeout(r, ms))

/** 把带 alpha 的截图合成到深色底上（模拟桌面），否则透明区域看不出光晕。 */
function overDark(img, rgb = [15, 17, 21]) {
  const { width, height } = img.getSize()
  const bmp = img.toBitmap()
  const out = Buffer.alloc(bmp.length)
  for (let i = 0; i < bmp.length; i += 4) {
    const a = bmp[i + 3] / 255
    out[i] = Math.round(bmp[i] * a + rgb[2] * (1 - a))
    out[i + 1] = Math.round(bmp[i + 1] * a + rgb[1] * (1 - a))
    out[i + 2] = Math.round(bmp[i + 2] * a + rgb[0] * (1 - a))
    out[i + 3] = 255
  }
  return nativeImage.createFromBitmap(out, { width, height })
}

async function main() {
  const { PluginManager } = require(path.join(REPO, 'dist-electron', 'plugins', 'plugin-manager.js'))
  const manager = new PluginManager([USER_PLUGINS], USER_PLUGINS)
  manager.discover()
  manager.installDirectory(dir)

  require(path.join(REPO, 'dist-electron', 'main.js'))
  await app.whenReady()
  await wait(3600)

  const host = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('dist/index.html'))
  if (!host) { console.log('找不到宿主窗口'); app.exit(1); return }
  const js = (code) => host.webContents.executeJavaScript(code)

  const fire = async (payload) => {
    const target = webContents.getAllWebContents().find(wc => wc.getURL().includes(PLUGIN))
    if (!target) return false
    target.send('host:event', { name: 'fire', payload })
    return true
  }

  // 插件内容在独立的 WebContentsView 原生层里，host 的 capturePage() 截不到它，
  // 所以整屏捕获一次，再按窗口坐标裁出小岛。
  const display = screen.getPrimaryDisplay()
  const scale = display.scaleFactor
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) },
  })
  const fullScreen = sources[0]?.thumbnail
  if (!fullScreen) { console.log('拿不到屏幕捕获源'); app.exit(1); return }
  console.log(`屏幕 ${fullScreen.getSize().width}×${fullScreen.getSize().height}, scaleFactor=${scale}`)

  const winBounds = host.getBounds()
  const shots = [
    { name: '00-normal', payload: { dismiss: true }, note: '常态（无提醒）' },
    { name: '01-info', payload: { level: 'info', label: '已同步', value: '¥2.56' }, note: 'info 档' },
    { name: '02-warn', payload: { level: 'warn', label: '余额偏低', value: '¥1.20' }, note: 'warn 档' },
    { name: '03-critical', payload: { level: 'critical', label: '令牌失效', value: '需要重填' }, note: 'critical 档' },
  ]

  for (const shot of shots) {
    await fire(shot.payload)
    await wait(1100)

    const rect = await js(`(() => {
      const el = document.querySelector('#host-root .island-shell')
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height, alert: el.dataset.alert ?? '' }
    })()`)

    const pad = 56
    const cropRect = {
      x: Math.round((winBounds.x + rect.x - pad) * scale),
      y: Math.round((winBounds.y + rect.y - pad) * scale),
      width: Math.round((rect.width + pad * 2) * scale),
      height: Math.round((rect.height + pad * 2) * scale),
    }
    const size = fullScreen.getSize()
    const safe = {
      x: Math.max(0, cropRect.x), y: Math.max(0, cropRect.y),
      width: Math.min(cropRect.width, size.width - Math.max(0, cropRect.x)),
      height: Math.min(cropRect.height, size.height - Math.max(0, cropRect.y)),
    }
    const cropped = fullScreen.crop(safe)
    const file = path.join(OUT, `${shot.name}.png`)
    fs.writeFileSync(file, overDark(cropped).toPNG())
    console.log(`${shot.note}: ${file}  [data-alert="${rect.alert}" 岛 ${Math.round(rect.width)}×${Math.round(rect.height)}]`)
  }
  app.exit(0)
}

app.whenReady().then(main).catch((e) => { console.error(e); app.exit(1) })
