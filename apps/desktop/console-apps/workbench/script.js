// 内置工作台。
//
// 迁移说明（对照旧版）：
//   - 只用 `window.workbench`（通用能力面），不再用白名单式 `window.activityIsland.api()`；
//   - 「DeepSeek 用量」以前调 `api('deepseek.setToken')` / `api('deepseek.usage')`，宿主根本没有这两个东西，
//     所以整块永远是"未配置/获取失败"。现在用 `http` + `storage` 自己实现，不再依赖宿主开专用接口；
//   - 页面偏好（刷新频率、主题色、是否显示网络）从宿主的 `workbench/settings.json` 搬到自己的 `storage`；
//   - 「快捷启动」用 `workbench.shortcuts`，**所有失败都会显示出来**（旧版把错误吞掉，点了没反应却像成功）；
//   - `resize` 是真的宿主尺寸通道（旧版是 `window.resizeTo`，空操作），但本页不自动用它（见下）。
//
// 这个文件同时是"工作台能做什么"的参考实现：能力面怎么用、失败怎么报、能力不足怎么降级。

const api = window.workbench
const $ = (selector) => document.querySelector(selector)
const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, Number(value) || 0))
const safeNumber = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback)

const setText = (selector, text) => { const node = $(selector); if (node) node.textContent = text }
const setHtml = (selector, html) => { const node = $(selector); if (node) node.innerHTML = html }

/** 统一的失败提示：写在页脚，用户看得见（旧版大量 `.catch(() => {})` 把错误吞了）。 */
const noticeEl = () => $('#updated-at')
let noticeTimer = null
const notify = (message) => {
  setText('#updated-at', message)
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => { noticeTimer = null }, 6000)
}

const state = {
  timer: null,
  refreshMs: 2000,
  capabilities: [],
  shortcuts: [],
  deepseek: { apiKey: '', endpoint: 'https://api.deepseek.com/user/balance' },
}

const DEFAULTS = { refreshMs: 2000, accent: '#3B82F6', showNetwork: true }
const DEEPSEEK_REFRESH_MS = 5 * 60 * 1000

const formatTime = (value) => new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
const formatBytes = (bytes) => {
  const value = safeNumber(bytes)
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`
  if (value >= 1024 ** 2) return `${Math.round(value / 1024 ** 2)} MB`
  return `${Math.round(value / 1024)} KB`
}
const formatUptime = (seconds) => {
  const total = Math.max(0, Math.floor(safeNumber(seconds)))
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (days > 0) return `${days}天 ${hours}小时`
  if (hours > 0) return `${hours}小时 ${minutes}分`
  return `${minutes}分钟`
}
const setAccent = (color) => {
  if (!/^#[0-9a-f]{6}$/i.test(String(color ?? ''))) return
  document.documentElement.style.setProperty('--accent', color)
}

// ===== 能力降级 =====
// 页面先问宿主"我被授予了什么"，把不能做的事直接隐藏 —— 而不是等用户点了才报错。
const can = (capability) => state.capabilities.includes(capability)
const applyCapabilities = () => {
  const networkPanel = $('#network-panel')
  if (networkPanel && !can('system')) networkPanel.classList.add('is-hidden')
  if (!can('system')) {
    for (const id of ['#cpu', '#memory', '#uptime', '#platform']) setText(id, '—')
  }
  const dsSection = $('#deepseek-section')
  if (dsSection) dsSection.classList.toggle('is-hidden', !(can('http') && can('storage')))
  const shortcutSection = $('#shortcut-section')
  if (shortcutSection) shortcutSection.classList.toggle('is-hidden', !can('shortcuts'))
}

// ===== 系统指标 =====
const updateNetwork = async () => {
  if (!$('#download') || !can('system')) return
  const network = await api.system.network()
  if (network && network.ok) {
    setHtml('#download', `${Number(network.downloadMbps || 0).toFixed(1)}<small>MB/s</small>`)
    setHtml('#upload', `${Number(network.uploadMbps || 0).toFixed(1)}<small>MB/s</small>`)
    setText('#latency', network.latencyMs == null ? '-- ms' : `${network.latencyMs} ms`)
    return
  }
  setHtml('#download', '--<small>MB/s</small>')
  setHtml('#upload', '--<small>MB/s</small>')
  setText('#latency', '-- ms')
}

const update = async () => {
  if (!can('system')) return
  const status = await api.system.status()
  if (!status || !status.ok) {
    notify(`读取系统信息失败：${status?.error ?? '未知原因'}`)
    return
  }
  setText('#clock', formatTime(status.time))
  setText('#cpu', `${clamp(status.cpuPercent).toFixed(0)}%`)
  setText('#memory', `${clamp(status.memoryPercent).toFixed(0)}%`)
  const used = safeNumber(status.memoryUsed)
  const total = safeNumber(status.memoryTotal)
  setText('#memory-detail', total ? `${formatBytes(used)} / ${formatBytes(total)}` : '正在读取内存')
  setText('#uptime', formatUptime(status.uptime))
  setText('#platform', String(status.platform || 'desktop').replace('win32', 'Windows'))
  await updateNetwork()
  if (!noticeTimer) setText('#updated-at', `最后同步 ${formatTime(status.time)}`)
}

const schedule = () => {
  if (state.timer) clearInterval(state.timer)
  state.timer = setInterval(() => { void update() }, state.refreshMs)
}

// 尺寸由宿主管（workbench.json 的 size，默认 1040×700）。
//
// 这里**故意不做"按内容自适应高度"**：根元素是 height:100%，所以 getBoundingClientRect()
// 量到的就是宿主给的盒子本身 —— 请求"盒子 + 2px"会让宿主把盒子做大 2px，下一次再量又大 2px，
// 形成回环。实测能在一秒内刷出 163 次布局、尺寸从 720×480 一路爬到上限，
// 表现就是"第一次打开先慢慢变宽、再突然变高"。
// 要改尺寸请**明确调用一次** api.resize()（例如用户点了一个"紧凑/展开"开关），
// 不要在 resize 事件或启动流程里自动调用。

// ===== 快捷启动 =====
const guessIcon = (name, path) => {
  const n = String(name ?? '').trim().toLowerCase()
  if (/visual studio|code|vscode/i.test(n)) return '⌨'
  if (/chrome|edge|browser|firefox/i.test(n)) return '🌐'
  if (/wechat|微信|qq|tim/i.test(n)) return '💬'
  if (/explorer|文件|folder|目录/i.test(n)) return '📁'
  if (/calc|计算/i.test(n)) return '🔢'
  if (/notepad|记事本/i.test(n)) return '📝'
  if (/^https?:\/\//i.test(String(path ?? ''))) return '🔗'
  if (/\.(exe|lnk|bat|cmd)$/i.test(String(path ?? ''))) return '⚙'
  return '▦'
}

const renderShortcuts = () => {
  const grid = $('#shortcut-grid')
  if (!grid) return
  grid.innerHTML = ''
  for (const shortcut of state.shortcuts) {
    const el = document.createElement('div')
    el.className = 'sc-item'
    el.title = shortcut.path
    const del = document.createElement('button')
    del.className = 'sc-del'
    del.type = 'button'
    del.textContent = '×'
    del.addEventListener('click', (event) => { event.stopPropagation(); void removeShortcut(shortcut.id) })
    const icon = document.createElement('div')
    icon.className = 'sc-icon'
    icon.textContent = guessIcon(shortcut.name, shortcut.path)
    const name = document.createElement('div')
    name.className = 'sc-name'
    name.textContent = shortcut.name
    el.append(del, icon, name)
    el.addEventListener('click', async () => {
      const result = await api.open(shortcut.path)
      // 关键：失败要说话。旧版 `.catch(() => …)` 对返回值完全不看，所以"点了没反应"也像成功。
      if (!result || result.ok === false) notify(`无法打开「${shortcut.name}」：${result?.error ?? '未知原因'}`)
    })
    el.addEventListener('contextmenu', (event) => { event.preventDefault(); openShortcutModal(shortcut) })
    grid.appendChild(el)
  }
  const add = document.createElement('div')
  add.className = 'sc-add'
  add.innerHTML = '<span class="plus">+</span><span>添加</span>'
  add.addEventListener('click', () => openShortcutModal(null))
  grid.appendChild(add)
}

const loadShortcuts = async () => {
  if (!can('shortcuts')) return
  const result = await api.shortcuts.list()
  if (!result || result.ok === false) { notify(`读取快捷启动失败：${result?.error ?? '未知原因'}`); return }
  state.shortcuts = Array.isArray(result.shortcuts) ? result.shortcuts : []
  renderShortcuts()
}

let editingId = null
const openShortcutModal = (shortcut) => {
  const modal = $('#sc-modal')
  if (!modal) return
  editingId = shortcut ? shortcut.id : null
  setText('#sc-modal-title', shortcut ? '编辑快捷启动' : '添加快捷启动')
  const nameInput = $('#sc-name-input')
  const pathInput = $('#sc-path-input')
  if (nameInput) nameInput.value = shortcut ? shortcut.name : ''
  if (pathInput) pathInput.value = shortcut ? shortcut.path : ''
  modal.classList.add('open')
  setTimeout(() => nameInput?.focus(), 30)
}
const closeShortcutModal = () => {
  $('#sc-modal')?.classList.remove('open')
  editingId = null
}
const saveShortcut = async () => {
  const name = ($('#sc-name-input')?.value || '').trim()
  const path = ($('#sc-path-input')?.value || '').trim()
  if (!name || !path) { notify('名称和路径都要填'); return }
  const result = editingId ? await api.shortcuts.update(editingId, { name, path }) : await api.shortcuts.add(name, path)
  if (!result || result.ok === false) { notify(`保存快捷启动失败：${result?.error ?? '未知原因'}`); return }
  closeShortcutModal()
  await loadShortcuts()
}
const removeShortcut = async (id) => {
  const result = await api.shortcuts.remove(id)
  if (!result || result.ok === false) { notify(`删除快捷启动失败：${result?.error ?? '未知原因'}`); return }
  await loadShortcuts()
}

// ===== 参数（宿主渲染的表单，页面只负责应用）=====
//
// 这三个参数**不在页面上画控件**：它们声明在 workbench.json 的 settings.fields 里，
// 用户在「控制台管理 → 工作台 → 内置工作台 → 参数」里改。页面只做两件事：
// 读出来应用、并监听 onChange（用户在管理页改完立刻生效）。
// 之前这里自己画了一张「参数配置」卡片 —— 结果用户找不到该去哪儿改（实测反馈），
// 而且和"参数界面归宿主"的约定自相矛盾。
const applyPrefs = (values) => {
  const prefs = { ...DEFAULTS, ...(values ?? {}) }
  const refresh = [1000, 2000, 5000].includes(Number(prefs.refreshMs)) ? Number(prefs.refreshMs) : DEFAULTS.refreshMs
  if (refresh !== state.refreshMs) { state.refreshMs = refresh; schedule() }
  setAccent(prefs.accent)
  const panel = $('#network-panel')
  // 能力不足时无论如何都不显示网络面板
  if (panel) panel.classList.toggle('is-hidden', prefs.showNetwork === false || !can('system'))
}
const loadPrefs = async () => {
  // 参数通道本身不需要能力（它是"我自己的配置"）；能力不足时 applyPrefs 会自己降级。
  const values = await api.settings.all().catch(() => ({}))
  applyPrefs(values)
  api.settings.onChange(values => applyPrefs(values))
}

// ===== DeepSeek 用量（页面自己用 http + storage 实现）=====
//
// 接口：GET https://api.deepseek.com/user/balance，Authorization: Bearer <token>
//   → { is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }
// 令牌只存在工作台自己的 storage 里（`%APPDATA%` 下的 JSON，**明文**），并且**不回填到输入框**。
const formatMoney = (value) => (Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '--')

const updateDeepSeek = async () => {
  if (!(can('http') && can('storage'))) return
  if (!state.deepseek.apiKey) {
    setText('#ds-status', '未配置令牌')
    $('#ds-status')?.classList.remove('is-ok')
    for (const id of ['#ds-balance', '#ds-bonus', '#ds-topped']) setText(id, '--')
    setText('#ds-checked', '--:--')
    return
  }
  const result = await api.http(state.deepseek.endpoint, { headers: { Authorization: `Bearer ${state.deepseek.apiKey}` } })
  if (!result || result.ok === false) {
    // 403/401 与真正的网络错误分开说，用户才知道该改令牌还是该查网络。
    const unauthorized = result?.status === 401 || result?.status === 403
    setText('#ds-status', unauthorized ? '令牌无效' : `获取失败：${result?.error ?? result?.status ?? '未知原因'}`)
    $('#ds-status')?.classList.remove('is-ok')
    for (const id of ['#ds-balance', '#ds-bonus', '#ds-topped']) setText(id, '--')
    setText('#ds-checked', '--:--')
    return
  }
  let parsed = null
  try { parsed = JSON.parse(result.body) } catch { /* 下面统一处理 */ }
  const info = Array.isArray(parsed?.balance_infos) ? parsed.balance_infos[0] : null
  if (!info) {
    setText('#ds-status', '接口返回里没有余额信息')
    $('#ds-status')?.classList.remove('is-ok')
    return
  }
  setText('#ds-balance', formatMoney(info.total_balance))
  setText('#ds-bonus', formatMoney(info.granted_balance))
  setText('#ds-topped', formatMoney(info.topped_up_balance))
  setText('#ds-checked', formatTime(Date.now()))
  setText('#ds-status', parsed?.is_available === false ? '余额不足' : '正常')
  $('#ds-status')?.classList.toggle('is-ok', parsed?.is_available !== false)
}

let deepseekTimer = null
const scheduleDeepSeek = () => {
  if (deepseekTimer) clearInterval(deepseekTimer)
  deepseekTimer = setInterval(() => { void updateDeepSeek() }, DEEPSEEK_REFRESH_MS)
}

const loadDeepSeek = async () => {
  if (!can('storage')) return
  const result = await api.storage.get('deepseek')
  const saved = result && result.ok !== false && result.value ? result.value : {}
  state.deepseek.apiKey = typeof saved.apiKey === 'string' ? saved.apiKey : ''
  if (typeof saved.endpoint === 'string' && /^https?:\/\//i.test(saved.endpoint)) state.deepseek.endpoint = saved.endpoint
  const tokenInput = $('#ds-token-input')
  // 令牌**不回填**：只告诉用户"已配置"。
  if (tokenInput) tokenInput.value = ''
  setText('#ds-token-status', state.deepseek.apiKey ? '已配置' : '未配置')
  $('#ds-token-status')?.classList.toggle('is-ok', !!state.deepseek.apiKey)
}

const saveDeepSeekToken = async () => {
  const input = $('#ds-token-input')
  const token = (input?.value || '').trim()
  if (!token) { notify('请先粘贴令牌'); return }
  const result = await api.storage.set('deepseek', { ...state.deepseek, apiKey: token })
  if (!result || result.ok === false) { notify(`保存令牌失败：${result?.error ?? '未知原因'}`); return }
  state.deepseek.apiKey = token
  if (input) input.value = ''
  setText('#ds-token-status', '已配置')
  $('#ds-token-status')?.classList.add('is-ok')
  await updateDeepSeek()
}

// ===== 初始化 =====
const boot = async () => {
  const caps = await api.capabilities()
  state.capabilities = caps && caps.ok !== false && Array.isArray(caps.capabilities) ? caps.capabilities : []
  applyCapabilities()

  $('#exit-workbench')?.addEventListener('click', () => api.exit())
  $('#ds-token-save')?.addEventListener('click', () => { void saveDeepSeekToken() })
  $('#ds-token-input')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); void saveDeepSeekToken() }
  })
  $('#sc-save')?.addEventListener('click', () => { void saveShortcut() })
  $('#sc-cancel')?.addEventListener('click', closeShortcutModal)
  const modal = $('#sc-modal')
  modal?.addEventListener('click', (event) => { if (event.target === modal) closeShortcutModal() })
  $('#sc-path-input')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); void saveShortcut() }
  })

  await loadPrefs()
  await loadShortcuts()
  await loadDeepSeek()
  void update()
  if (!state.timer) schedule()
  void updateDeepSeek()
  scheduleDeepSeek()
}

void boot()
