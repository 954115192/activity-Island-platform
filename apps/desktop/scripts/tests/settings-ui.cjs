// 控制台管理（settings）的插件页验收：新版列表 / 抽屉 / 工具 / 状态切换 / 更新检查。
// 隐藏窗口 + 真实 preload + 桩 IPC，断言计算样式与交互结果。
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'

// 用临时 profile：绝不能和你正在跑的那个实例抢同一个 userData（会 ERR_FAILED 加载失败）。
const PROFILE = path.join(os.tmpdir(), 'island-settings-ui', 'profile')
fs.rmSync(path.dirname(PROFILE), { recursive: true, force: true })
fs.mkdirSync(PROFILE, { recursive: true })
app.setPath('userData', PROFILE)

const errors = []
const results = []
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail })
let uninstalled = []
let orderChanges = []
let modeChanges = []
let toolRuns = []
let externalUrls = []
let launchChanges = []
let updatePrefChanges = []
let currentMode = 'resident'
let currentUpdate = { ok: true, currentVersion: '0.2.1', latestVersion: '0.2.1', hasUpdate: false, checkedAt: Date.now(), checkUpdatesOnLaunch: true }
let checkCount = 0
let removed = false

const stub = (channel, handler) => ipcMain.handle(channel, handler)
stub('settings:get', () => ({ idleMode: 'collapsed', islandTop: 5, miniScale: 1, launchAtLogin: false, pluginOrder: [], pluginModes: {}, checkUpdatesOnLaunch: true, appVersion: '0.2.1' }))
stub('settings:set-plugin-order', (_event, order) => { orderChanges.push(order); return { idleMode: 'collapsed', islandTop: 5, miniScale: 1, launchAtLogin: false, pluginOrder: order, pluginModes: {}, checkUpdatesOnLaunch: true } })
stub('settings:set-launch-at-login', (_event, enabled) => { launchChanges.push(enabled); return { ok: true, enabled } })
stub('settings:open-external', (_event, url) => { externalUrls.push(url); return { ok: true } })
stub('host:plugins:list', () => [
  ...(removed ? [] : [
    {
      id: 'smtc-media', name: '媒体控制', version: '0.3.0', priority: 50, mode: currentMode,
      enabled: currentMode !== 'off', resident: currentMode === 'resident', supportsResident: true,
      icon: '媒', description: '正在播放时上岛', sourceDir: 'C:\\dev\\island-plugin\\smtc-media',
      settings: { fields: [{ key: 'city', label: '城市', type: 'text', default: '北京' }] },
      tools: [{
        id: 'now', title: '当前播放', description: '正在播放的歌', icon: 'music',
        view: { type: 'stats', items: [{ label: '音量', value: '62%' }, { label: '进度', value: '2:14' }] },
        actions: [{ id: 'diag', label: '复制诊断', icon: 'copy' }, { id: 'reset', label: '清空记录', icon: 'trash', tone: 'danger' }],
      }],
      guide: {
        summary: '把媒体控制显示在岛上。',
        requires: ['系统里正在播放媒体'],
        steps: [
          { title: '确认参数', text: '当前城市 {{city}}。', actions: [{ kind: 'settings', label: '打开参数' }] },
          { title: '发送测试', code: 'curl http://127.0.0.1:{{city}}/' },
          ...Array.from({ length: 8 }, (_, index) => ({ title: `补充步骤 ${index + 1}`, text: '这是一段用来撑高说明内容、验证标题栏固定不滚动的文字。'.repeat(2) })),
        ],
        troubleshooting: [{ problem: '没有反应', text: '看日志。', actions: [{ kind: 'logs', label: '查看日志' }] }],
        links: [{ label: '打开系统设置', url: 'ms-settings:notifications' }],
      },
    },
    { id: 'balance', name: '余额哨兵', version: '1.0.0', priority: 40, mode: 'resident', enabled: true, resident: true, supportsResident: true, icon: '余', description: '余额低于阈值时提醒' },
  ]),
])
stub('host:plugins:issues', () => ([{ id: 'broken', reason: '找不到 dist/index.html', directory: 'C:\\dev\\broken' }]))
stub('host:plugins:mode:set', (_event, id, mode) => { currentMode = mode; modeChanges.push(`${id}:${mode}`); return { ok: true, mode, enabled: mode !== 'off' } })
stub('host:plugins:settings', () => ({ ok: true, values: { city: '上海' }, schema: { fields: [{ key: 'city', label: '城市', type: 'text', default: '北京' }] } }))
stub('host:plugins:settings:set', () => ({ ok: true }))
stub('host:plugins:reload', () => ({ ok: false, error: '开发目录里找不到 plugin.json' }))
stub('host:plugins:uninstall', (_event, id) => { uninstalled.push(id); removed = true; return { ok: true } })
stub('host:plugins:logs', () => ({ lines: ['[info] 已启动', '[warn] 演示日志'] }))
stub('host:plugins:logs:clear', () => ({ ok: true }))
stub('host:plugins:tool:run', (_event, id, toolId, actionId) => { toolRuns.push(`${id}:${toolId}:${actionId}`); return { ok: true } })
stub('host:plugins:reveal', () => ({ ok: true }))
stub('settings:plugin-panel', () => ({ ok: true }))
stub('app:update-status', () => currentUpdate)
stub('app:check-updates', () => {
  checkCount += 1
  currentUpdate = { ...currentUpdate, latestVersion: '0.2.2', hasUpdate: true, releaseUrl: 'https://github.com/954115192/Activity-island/releases/tag/v0.2.2', checkedAt: Date.now() }
  return currentUpdate
})
stub('settings:set-check-updates', (_event, enabled) => { updatePrefChanges.push(enabled); return { ok: true, enabled } })
stub('host:workbenches:list', () => ({ workbenches: [], trustNotice: '' }))

async function main() {
  const win = new BrowserWindow({
    width: 920, height: 660, show: false,
    webPreferences: { preload: path.join(__dirname, '..', '..', 'dist-electron', 'preload', 'settings-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  })
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) errors.push(String(message).slice(0, 200)) })
  await win.loadFile(path.join(__dirname, '..', '..', 'console-apps', 'settings', 'index.html'))
  await new Promise((resolve) => setTimeout(resolve, 700))
  const js = (code) => win.webContents.executeJavaScript(code)
  const wait = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms))

  check('页面无异常', errors.length === 0, errors.join(' | '))

  // 开机启动：默认关闭，点亮后立刻写宿主登录项
  check('开机启动默认关闭', await js("document.querySelector('#launch-at-login').checked === false"))
  await js("document.querySelector('#launch-at-login').click()")
  await wait()
  check('开机启动开关可切换并落到宿主', launchChanges[0] === true && await js("document.querySelector('#launch-at-login').checked && document.querySelector('#launch-at-login-status').textContent.includes('已开启')"), JSON.stringify(launchChanges))

  // 插件页：岛预览 + 运行中/已关闭 + 错误行
  await js("document.querySelector('[data-tab=\"plugins\"]').click()")
  await wait(500)
  check('插件页列出插件', await js("document.querySelector('#plugin-list').textContent.includes('媒体控制') && document.querySelector('#plugin-list').textContent.includes('余额哨兵')"))
  check('岛预览显示常驻插件', await js("document.querySelector('#plugin-island').textContent.includes('媒体控制') && document.querySelector('#plugin-island').textContent.includes('余额哨兵')"))
  check('启动失败单独提示', await js("document.querySelector('#plugin-warn') && !document.querySelector('#plugin-warn').hidden && document.querySelector('#plugin-list').textContent.includes('找不到 dist/index.html')"))
  check('运行中计数包含错误插件', await js("document.querySelector('#plugin-count-running').textContent === '3'"), await js("document.querySelector('#plugin-count-running').textContent"))
  await js("document.querySelector('[data-plugin-tab=\"off\"]').click()")
  await wait(200)
  check('已关闭分页为空态', await js("document.querySelector('#plugin-search-empty').textContent.includes('没有已关闭')"))
  await js("document.querySelector('[data-plugin-tab=\"running\"]').click()")

  // 拖拽芯片排序（拖到目标右半边 = 插到后面）
  await js(`(() => {
    const chips = [...document.querySelectorAll('.chip')]
    const source = chips.find(chip => chip.dataset.chip === 'smtc-media')
    const target = chips.find(chip => chip.dataset.chip === 'balance')
    const sourceRect = source.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    const startX = sourceRect.left + sourceRect.width / 2
    const startY = sourceRect.top + sourceRect.height / 2
    const endX = targetRect.right - 2
    const endY = targetRect.top + targetRect.height / 2
    source.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: startX, clientY: startY }))
    document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, clientX: startX + 12, clientY: startY }))
    document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, clientX: endX, clientY: endY }))
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: endX, clientY: endY }))
  })()`)
  await wait(400)
  check('拖拽芯片能调整顺序', orderChanges[0]?.join(',') === 'balance,smtc-media', orderChanges.map(order => order.join(',')).join(' | '))
  check('拖拽后预览顺序同步', await js("[...document.querySelectorAll('.chip')].map(chip => chip.dataset.chip).join(',') === 'balance,smtc-media'"))

  // 搜索
  await js("(() => { const input = document.querySelector('#plugin-search'); input.value = '余额'; input.dispatchEvent(new Event('input')); })()")
  await wait(200)
  check('搜索只保留命中插件', await js("document.querySelectorAll('.plugin-row[data-plugin-id]').length === 1 && document.querySelector('#plugin-list').textContent.includes('余额哨兵')"))
  await js("(() => { document.querySelector('#search-clear').click() })()")
  await wait(200)

  // 上岛方式：常驻 → 仅提醒
  await js("document.querySelector('[data-mode-id=\"smtc-media\"]').click()")
  await wait(150)
  check('上岛方式弹出三档', await js("document.querySelectorAll('.mode-popover [data-set-mode]').length === 3"))
  await js("document.querySelector('.mode-popover [data-set-mode=\"alert\"]').click()")
  await wait(400)
  check('可改为仅提醒', modeChanges[0] === 'smtc-media:alert' && await js("document.querySelector('[data-mode-id=\"smtc-media\"]').dataset.mode === 'alert'"))
  check('仅提醒后离开岛预览', await js("!document.querySelector('#plugin-island').textContent.includes('媒体控制') && document.querySelector('#plugin-island').textContent.includes('余额哨兵')"))
  await js("document.querySelector('[data-mode-id=\"smtc-media\"]').click()")
  await wait(150)
  await js("document.querySelector('.mode-popover [data-set-mode=\"resident\"]').click()")
  await wait(400)

  // 详情抽屉：工具 / 参数 / 日志 / 说明
  await js("openDrawer('smtc-media', 'tools')")
  await wait(300)
  check('详情抽屉打开工具页', await js("document.querySelector('.plugin-drawer #drawer-body').textContent.includes('当前播放') && document.querySelector('.plugin-drawer [data-tool-action=\"diag\"]')"))
  await js("document.querySelector('.plugin-drawer [data-tool-action=\"diag\"]').click()")
  await wait(300)
  check('工具动作发给插件', toolRuns[0] === 'smtc-media:now:diag', toolRuns.join(','))
  check('工具动作有状态反馈', await js("document.querySelector('.plugin-drawer [data-tool-action=\"diag\"] .st').textContent === '已发送'"))
  await js("document.querySelector('.plugin-drawer [data-tool-action=\"reset\"]').click()")
  await wait(150)
  const dangerState = await js("(() => { const b = document.querySelector('.plugin-drawer [data-tool-action=\"reset\"]'); return { exists: !!b, text: b?.textContent ?? null } })()")
  check('危险工具需要二次确认', dangerState.exists && String(dangerState.text).includes('再点一次') && !toolRuns.includes('smtc-media:now:reset'))

  await js("document.querySelector('.plugin-drawer [data-drawer-tab=\"params\"]').click()")
  await wait(350)
  check('参数在抽屉里显示', await js("document.querySelector('#drawer-body input[data-key=\"city\"]')?.value === '上海'"))
  check('参数页显示保存按钮', await js("!document.querySelector('.plugin-drawer [data-drawer-save]').hidden"))
  await js("document.querySelector('.plugin-drawer [data-drawer-save]').click()")
  await wait(200)
  check('参数保存有反馈', await js("document.querySelector('#toast-wrap').textContent.includes('参数已保存')"))

  await js("document.querySelector('.plugin-drawer [data-drawer-tab=\"logs\"]').click()")
  await wait(350)
  check('日志在抽屉里显示', await js("document.querySelector('.plugin-drawer .drawer-log')?.textContent.includes('演示日志')"))
  await js("document.querySelector('.plugin-drawer [data-drawer-tab=\"guide\"]').click()")
  await wait(350)
  check('说明在抽屉里显示并插值参数', await js("document.querySelector('#drawer-body').textContent.includes('当前城市 上海') && document.querySelector('.guide-code pre')?.textContent.includes('http://127.0.0.1:上海/')"))
  await js("document.querySelector('.plugin-drawer [data-drawer-close]').click()")
  await wait(200)
  check('抽屉可以关闭', await js("!document.querySelector('.plugin-drawer')"))

  // 更多菜单：重载失败提示
  await js("document.querySelector('[data-more=\"smtc-media\"]').click()")
  await wait(150)
  await js("document.querySelector('.more-popover [data-more-action=\"reload\"]').click()")
  await wait(300)
  check('重载失败用 toast 提示', await js("document.querySelector('#toast-wrap').textContent.includes('重载失败')"))

  // 添加插件弹窗
  await js("document.querySelector('#plugin-add').click()")
  await wait(200)
  check('添加插件提供三种入口', await js("!!document.querySelector('#add-install-dir') && !!document.querySelector('#add-import-package') && !!document.querySelector('#add-skill')"))
  const modal = await js(`(() => {
    const mask = document.querySelector('#plugin-modal')
    const close = document.querySelector('#close')
    const box = mask.getBoundingClientRect()
    const closeBox = close.getBoundingClientRect()
    const topmost = document.elementFromPoint(closeBox.left + closeBox.width / 2, closeBox.top + closeBox.height / 2)
    return { maskTop: box.top, closeTop: closeBox.top, closeHit: close.contains(topmost) || topmost === close }
  })()`)
  check('弹窗遮罩不覆盖窗口顶栏', modal.maskTop >= 42 && modal.closeTop < modal.maskTop, JSON.stringify(modal))
  check('弹窗打开时窗口关闭键仍可点击', modal.closeHit, JSON.stringify(modal))
  await js("document.querySelector('#plugin-modal-close').click()")

  // 关于：更新检查
  await js("document.querySelector('[data-tab=\"about\"]').click()")
  await wait(400)
  check('关于显示版本和已是最新', await js("document.querySelector('#about-version').textContent.includes('0.2.1') && document.querySelector('#about-update-status').textContent.includes('已是最新')"))
  await js("document.querySelector('#about-auto-check').click()")
  await wait(200)
  check('可以关闭启动时检查', updatePrefChanges[0] === false)
  await js("document.querySelector('#about-check-update').click()")
  await wait(500)
  check('检查更新能发现新版本', checkCount === 1 && await js("document.querySelector('#about-update-status').textContent.includes('有新版本 v0.2.2') && document.querySelector('#about-check-update').textContent === '查看更新'"))
  await js("document.querySelector('#about-check-update').click()")
  await wait(200)
  check('发现新版本后打开 Release', externalUrls.some((url) => url.includes('/releases/tag/v0.2.2')), externalUrls.join(','))

  // 卸载：两步确认
  await js("document.querySelector('[data-tab=\"plugins\"]').click()")
  await wait(300)
  await js("document.querySelector('[data-more=\"smtc-media\"]').click()")
  await wait(150)
  await js("document.querySelector('.more-popover [data-more-action=\"uninstall\"]').click()")
  await wait(150)
  check('卸载第一次点击只变成确认态', await js("document.querySelector('.more-popover [data-more-action=\"uninstall\"]').textContent.includes('确认卸载')") && uninstalled.length === 0)
  await js("document.querySelector('.more-popover [data-more-action=\"uninstall\"]').click()")
  await wait(400)
  check('第二次点击才真的卸载', uninstalled.length === 1, uninstalled.join(','))
  check('卸载后有反馈', await js("document.querySelector('#toast-wrap').textContent.includes('已卸载')"))

  // 顶栏固定：下面的插件容器变高时，整页不能被撑出滚动条，把标题和关闭键卷走。
  await js(`(() => {
    const list = document.querySelector('#plugin-list')
    const row = list.querySelector('.plugin-row')
    if (row) for (let i = 0; i < 40; i += 1) list.append(row.cloneNode(true))
    return true
  })()`)
  await wait(200)
  const layout = await js(`(() => {
    const main = document.querySelector('main')
    const bar = document.querySelector('.window-bar')
    main.scrollTop = main.scrollHeight
    const box = bar.getBoundingClientRect()
    return {
      barTop: box.top,
      barBottom: box.bottom,
      mainScrolls: main.scrollHeight > main.clientHeight,
      bodyScrolls: document.documentElement.scrollHeight > window.innerHeight + 1,
      documentScrollTop: document.scrollingElement.scrollTop,
    }
  })()`)
  check('内容变高后顶栏仍在最顶部（不会被滚走）', layout.barTop === 0, `barTop=${layout.barTop}`)
  check('滚动只发生在内容区，整页不滚动', layout.mainScrolls && !layout.bodyScrolls && layout.documentScrollTop === 0, JSON.stringify(layout))
  check('顶栏高度不变（始终 42px）', Math.round(layout.barBottom) === 42, `barBottom=${layout.barBottom}`)

  console.log('=== 控制台管理·插件页验收 ===')
  let failed = 0
  for (const item of results) { if (!item.ok) failed += 1; console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.detail ? `   [${item.detail}]` : ''}`) }
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  win.destroy()
  app.exit(failed ? 1 : 0)
}

app.whenReady().then(main).catch((error) => { console.error(error); app.exit(1) })
