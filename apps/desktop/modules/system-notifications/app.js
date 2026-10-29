(() => {
  'use strict'

  const island = window.dynamicIsland
  const api = island.notifications || null

  const ICON = {
    pause: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="6.5" y="4" width="3.5" height="16" rx="1.2"/><rect x="14" y="4" width="3.5" height="16" rx="1.2"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4.5v15l12-7.5z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6.5 7l.8 12.1A2 2 0 0 0 9.3 21h5.4a2 2 0 0 0 2-1.9L17.5 7"/><path d="M10.5 11v6M13.5 11v6"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
    collapse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  }

  const state = {
    mode: 'small',
    current: null,
    items: [],
    revision: 0,
    refreshSerial: 0,
    status: null,
    settings: {},
    toast: '',
    codeCopy: null,
    alertIds: new Set(),
  }

  const el = {
    small: document.getElementById('small'),
    badge: document.getElementById('s-badge'),
    title: document.getElementById('s-title'),
    sub: document.getElementById('s-sub'),
    count: document.getElementById('s-count'),
    medium: document.getElementById('medium'),
  }

  /* ---------------- 工具 ---------------- */
  const esc = (value) => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

  const initial = (app) => {
    const text = String(app || '').trim()
    return text ? text.slice(0, 1).toUpperCase() : '·'
  }

  const relTime = (ts) => {
    const value = Number(ts) || 0
    if (!value) return ''
    const diff = Date.now() - value
    if (diff < 60_000) return '刚刚'
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
    const date = new Date(value)
    return `${date.getMonth() + 1}月${date.getDate()}日`
  }

  const normalize = (raw) => {
    if (!raw || typeof raw !== 'object') return null
    const id = raw.id == null ? '' : String(raw.id)
    if (!id) return null
    const title = String(raw.title || '').trim()
    const app = String(raw.app || '').trim() || '系统'
    return {
      id,
      app,
      title: title || app,
      content: String(raw.content || ''),
      ts: Number(raw.ts) || Date.now(),
      level: raw.level === 'warn' || raw.level === 'critical' ? raw.level : 'info',
      source: String(raw.source || ''),
      repeat: Number(raw.repeat) || 0,
      dismissedAt: raw.dismissedAt,
    }
  }

  const isPaused = () => state.settings.alertEnabled === false
  const windowsAccess = () => (state.status && state.status.windows && state.status.windows.access) || 'unknown'
  const localState = () => (state.status && state.status.localTrigger && state.status.localTrigger.state) || 'stopped'

  /* ---------------- 渲染 ---------------- */
  function renderSmall() {
    const item = state.current
    const extra = Math.max(0, state.alertIds.size - 1)
    el.count.className = 's-count' + (item && item.level === 'warn' ? ' warn' : item && item.level === 'critical' ? ' critical' : '')
    el.count.hidden = !item || !extra
    el.count.textContent = extra ? (extra > 99 ? '+99+' : `+${extra}`) : ''
    el.count.title = extra ? `还有 ${extra} 条通知，点击查看` : ''
    if (!item) {
      el.badge.className = 's-badge'
      el.badge.textContent = '·'
      el.title.textContent = '系统通知'
      el.sub.textContent = ''
      return
    }
    el.badge.className = 's-badge' + (item.level === 'warn' ? ' warn' : item.level === 'critical' ? ' critical' : '')
    el.badge.textContent = initial(item.app)
    el.title.textContent = item.title
    // 正文优先；没提取到正文时退而显示来源应用名（title 已是应用名时不再重复）
    el.sub.textContent = item.content || (item.title === item.app ? '' : item.app)
  }

  function accessProblem() {
    const access = windowsAccess()
    if (access === 'denied' || access === 'unspecified') {
      return '尚未获得通知访问权限。打开 <b>系统设置 → 隐私和安全性 → 通知</b>，开启「允许应用访问你的通知」；授权后几秒内自动生效。'
    }
    if (access === 'unavailable') return '当前系统不支持读取通知中心。'
    if (state.status && state.status.windows && state.status.windows.state === 'error') {
      return `Windows 通知监听不可用${state.status.windows.detail ? '：' + esc(state.status.windows.detail) : ''}。`
    }
    return ''
  }

  function renderMedium() {
    const item = state.current
    const problem = accessProblem()
    const paused = isPaused()
    const windowState = windowsAccess()
    const chipClass = paused ? 'warn' : windowState === 'allowed' ? 'ok' : 'warn'
    const chipText = paused ? '已暂停提醒' : windowState === 'allowed' ? '监听中' : windowState === 'denied' || windowState === 'unspecified' ? '待授权' : '连接中'
    const endpoint = (state.status && state.status.endpoint) || ''
    const total = (state.status && state.status.totalRecords) || 0
    const token = (state.status && state.status.token) || ''
    const masked = token ? token.slice(0, 6) + '…' + token.slice(-4) : '未生成'
    const code = item ? window.findVerificationCode(item.title, item.content) : null
    const copyStatus = code && state.codeCopy && state.codeCopy.id === item.id && state.codeCopy.code === code ? state.codeCopy.status : ''
    const index = item ? state.items.findIndex(entry => entry.id === item.id) : -1

    const head =
      '<div class="m-head">' +
        '<span class="m-title">系统通知</span>' +
        `<span class="chip ${chipClass}">${esc(chipText)}</span>` +
        '<span class="spacer"></span>' +
        `<button class="icon-btn" data-act="toggle-pause" title="${paused ? '继续提醒' : '暂停提醒'}">${paused ? ICON.play : ICON.pause}</button>` +
        `<button class="icon-btn" data-act="copy-token" title="复制本地接口令牌">${ICON.copy}</button>` +
        `<button class="icon-btn" data-act="clear" title="清空历史">${ICON.trash}</button>` +
        `<button class="icon-btn" data-act="collapse" title="收起">${ICON.collapse}</button>` +
      '</div>'

    const card = item
      ? '<div class="card">' +
          '<div class="card-top">' +
            `<span class="card-app">${esc(item.app)}</span>` +
            `<span class="card-time">${esc(relTime(item.ts))}</span>` +
            (state.items.length > 1 && index >= 0 ? `<span class="notification-nav"><button class="nav-btn" data-act="newer" title="上一条（较新）" aria-label="上一条（较新）" ${index === 0 ? 'disabled' : ''}>‹</button><span>${index + 1} / ${state.items.length}</span><button class="nav-btn" data-act="older" title="下一条（较早）" aria-label="下一条（较早）" ${index === state.items.length - 1 ? 'disabled' : ''}>›</button></span>` : '') +
          '</div>' +
          `<div class="card-title">${esc(item.title)}</div>` +
          (item.content ? `<div class="card-body">${esc(item.content)}</div>` : '') +
          (code ? `<div class="verification"><button class="verification-copy" data-act="copy-code">${ICON.copy} 复制验证码</button><div class="verification-result" aria-live="polite"><span class="verification-value${copyStatus === 'success' ? ' copied' : ''}">${esc(code)}</span>${copyStatus ? `<span class="verification-status${copyStatus === 'error' ? ' error' : ''}">${copyStatus === 'success' ? '复制成功' : '复制失败，请重试'}</span>` : ''}</div></div>` : '') +
          (item.repeat > 0 ? `<div class="card-repeat">重复推送已合并，共 ${item.repeat + 1} 次</div>` : '') +
        '</div>'
      : '<div class="empty">还没有捕获到新通知。<br>Windows 通知或本地脚本推送后会出现在这里。</div>'

    const foot =
      '<div class="m-foot">' +
        `<span>${total} 条记录</span>` +
        (endpoint ? ` · <span class="endpoint">${esc(endpoint)}</span>` : ' · 本地接口未启用') +
        ` · 令牌 ${esc(masked)}` +
        (state.toast ? ` · ${esc(state.toast)}` : '') +
      '</div>'

    el.medium.innerHTML = head + (problem ? `<div class="tip">${ICON.alert}<div>${problem}</div></div>` : '') + card + '<div class="spacer-fill"></div>' + foot
  }

  function applyMode() {
    el.small.classList.toggle('is-active', state.mode === 'small')
    el.medium.classList.toggle('is-active', state.mode === 'medium')
    if (state.mode === 'medium') renderMedium()
    else renderSmall()
  }

  /* ---------------- 提醒宽度自适应 ----------------
   * 与插件版一致：离屏量宽盒按这条通知的内容量自然 CSS 宽，再按 metrics 的
   * zoom/scale 换算成逻辑 px 报给 island.alert，提醒条随内容长短伸缩。
   */
  const WIDTH_MAX = 880

  function measureSmallWidth(item) {
    if (!item || !document.body) return 0
    let box = document.getElementById('s-measure')
    if (!box) {
      box = document.createElement('div')
      box.id = 's-measure'
      box.className = 's-measure'
      box.setAttribute('aria-hidden', 'true')
      document.body.appendChild(box)
    }

    const badge = document.createElement('span')
    badge.className = 's-badge' + (item.level === 'warn' ? ' warn' : item.level === 'critical' ? ' critical' : '')
    badge.textContent = initial(item.app)
    const title = document.createElement('span')
    title.className = 's-title'
    title.textContent = item.title || item.app
    const sub = document.createElement('span')
    sub.className = 's-sub'
    sub.textContent = item.content || (item.title === item.app ? '' : item.app)
    const count = document.createElement('span')
    count.className = 's-count' + (item.level === 'warn' ? ' warn' : item.level === 'critical' ? ' critical' : '')
    const extra = Math.max(0, state.alertIds.size - 1)
    count.textContent = extra ? (extra > 99 ? '+99+' : `+${extra}`) : ''
    box.replaceChildren(badge, title, sub, count)

    const cssWidth = Math.ceil(box.getBoundingClientRect().width)
    if (!cssWidth) return 0

    let scale = 1
    let zoom = 1
    try {
      const m = island.metrics ? island.metrics() : null
      if (m && Number(m.scale) > 0) scale = Number(m.scale)
      if (m && Number(m.zoom) > 0) zoom = Number(m.zoom)
    } catch { /* 1:1 兜底 */ }

    return Math.min(WIDTH_MAX, Math.ceil(cssWidth * zoom / scale) + 2)
  }

  /* ---------------- 数据刷新 ---------------- */
  async function refresh() {
    if (!api) return
    const serial = ++state.refreshSerial
    const revision = state.revision
    try {
      const snapshot = await api.snapshot()
      if (!snapshot || serial !== state.refreshSerial) return
      if (revision !== state.revision) { void refresh(); return }
      state.status = snapshot.status
      const items = (snapshot.items || []).map(normalize).filter(Boolean)
      const selected = state.mode === 'medium' && state.current && items.find(item => item.id === state.current.id)
      state.items = items
      state.current = selected || items[0] || null
      applyMode()
    } catch { /* 忽略 */ }
  }

  function onItem(payload) {
    const item = normalize(payload)
    if (!item) return
    state.revision++
    const existing = state.items.findIndex(entry => entry.id === item.id)
    if (existing >= 0) state.items[existing] = item
    else {
      state.items.unshift(item)
      if (state.status) state.status.totalRecords = (state.status.totalRecords || 0) + 1
    }
    if (state.mode !== 'medium' || !state.current) state.current = state.items[0]
    else if (state.current.id === item.id) state.current = item
    // Keep a notification being read available even during a burst.
    if (state.items.length > 30) {
      const selected = state.current
      state.items = state.items.slice(0, 30)
      if (selected && !state.items.some(entry => entry.id === selected.id)) state.items[29] = selected
    }
    applyMode()
  }

  function onStatus() {
    void refresh()
  }

  /**
   * 提醒交给视图发起：主进程只推"该提醒了"，宽度由这里测量后报给宿主。
   * 这样宽度自适应与插件版完全一致，宿主侧不需要估算。
   */
  function onAlert(payload) {
    if (!payload) return
    if (payload.id) state.alertIds.add(String(payload.id))
    if (state.mode === 'small') renderSmall()
    const level = payload.level === 'warn' || payload.level === 'critical' ? payload.level : 'info'
    const seconds = Number(payload.ttlSeconds)
    const ttl = Math.max(1000, Math.round((Number.isFinite(seconds) && seconds > 0 ? seconds : 8) * 1000))
    const width = measureSmallWidth(state.items[0] || state.current)
    try {
      const options = { key: 'system-notification', level, ttl }
      if (width > 0) options.width = width
      island.alert(options)
    } catch (error) {
      try { island.log.warn('alert 调用失败: ' + error) } catch { /* 忽略 */ }
    }
  }

  function onRemoved(payload) {
    if (!payload) return
    state.revision++
    if (payload.clear) {
      state.alertIds.clear()
      state.current = null
      state.items = []
      if (state.status) state.status.totalRecords = 0
      applyMode()
      return
    }
    const ids = Array.isArray(payload.ids) ? payload.ids.map(String) : []
    for (const id of ids) state.alertIds.delete(id)
    if (state.current && ids.includes(state.current.id)) {
      state.current = null
    }
    void refresh()
  }

  /* ---------------- 交互 ---------------- */
  async function onAction(event) {
    const button = event.target && event.target.closest ? event.target.closest('[data-act]') : null
    if (!button) return
    event.stopPropagation()
    const act = button.getAttribute('data-act')

    if (act === 'toggle-pause') {
      const next = !isPaused()
      state.settings = Object.assign({}, state.settings, { alertEnabled: next })
      try { await api.setSetting('alertEnabled', next) } catch { /* 忽略 */ }
      renderMedium()
    } else if (act === 'clear') {
      try {
        const result = await api.clearWithConfirm()
        if (result && result.action !== 'cancel') {
          if (result.error) state.toast = result.error
          else state.toast = result.clearedWindows ? '已清空（含系统通知中心）' : '已清空'
        }
        if (result && result.action !== 'cancel') {
          state.revision++
          state.alertIds.clear()
          state.current = null
          state.items = []
          if (state.status) state.status.totalRecords = 0
        }
      } catch { /* 忽略 */ }
      applyMode()
      void refresh()
    } else if (act === 'newer' || act === 'older') {
      const index = state.current ? state.items.findIndex(item => item.id === state.current.id) : -1
      const next = index + (act === 'newer' ? -1 : 1)
      if (index >= 0 && next >= 0 && next < state.items.length) {
        state.current = state.items[next]
        renderMedium()
      }
    } else if (act === 'copy-code') {
      const item = state.current
      const code = item && window.findVerificationCode(item.title, item.content)
      if (!code) return
      let status = 'error'
      try {
        const result = await api.copyVerificationCode(code)
        if (result && result.ok) status = 'success'
      } catch { /* 显示复制失败 */ }
      if (state.current && state.current.id === item.id && window.findVerificationCode(state.current.title, state.current.content) === code) {
        state.codeCopy = { id: item.id, code, status }
        renderMedium()
      }
    } else if (act === 'copy-token') {
      try { await api.copyToken() } catch { /* 忽略 */ }
      state.toast = '已复制'
      renderMedium()
    } else if (act === 'collapse') {
      setTimeout(() => { try { island.ui.collapse() } catch { /* 忽略 */ } }, 0)
    }
  }

  function bind() {
    island.ui.onModeChange((mode) => {
      state.mode = mode
      if (mode === 'medium') state.alertIds.clear()
      if (mode === 'small' && state.items.length) state.current = state.items[0]
      applyMode()
    })

    island.events.on('notif:item', onItem)
    island.events.on('notif:status', onStatus)
    island.events.on('notif:removed', onRemoved)
    island.events.on('notif:alert', onAlert)

    island.onIntent((intent) => {
      if (intent && intent.kind === 'alert' && intent.key === 'system-notification' &&
          ['expired', 'dismissed', 'preempted', 'denied'].includes(intent.result)) {
        state.alertIds.clear()
        if (state.mode === 'small') renderSmall()
      }
    })

    api.onSettingsChange((values) => {
      state.settings = values || {}
      renderMedium()
    })

    document.getElementById('app').addEventListener('click', onAction)
    el.small.addEventListener('click', () => {
      setTimeout(() => { try { island.ui.expand() } catch { /* 忽略 */ } }, 0)
    })
  }

  async function boot() {
    try { await island.ready } catch { /* 忽略 */ }
    try { state.settings = api ? (await api.settingsAll()) || {} : {} } catch { state.settings = {} }
    bind()
    applyMode()
    await refresh()
  }

  // 调试/截图钩子：仅用于开发期验证视觉效果（宿主无此调用）。
  window.__notifDebug = {
    inject(item) { state.current = normalize(item) || state.current; applyMode() },
    render: applyMode,
    measure: () => measureSmallWidth(state.current),
  }

  if (typeof document !== 'undefined') boot()
})()
