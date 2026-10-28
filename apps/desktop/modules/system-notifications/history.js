(() => {
  'use strict'

  const bridge = window.notificationHistory
  const state = { filter: 'all', search: '', items: [], status: null }

  const el = {
    list: document.getElementById('list'),
    count: document.getElementById('count'),
    meta: document.getElementById('meta'),
    search: document.getElementById('search'),
    clear: document.getElementById('clear'),
    filters: document.getElementById('filters'),
  }

  const esc = (value) => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

  const initial = (app) => {
    const text = String(app || '').trim()
    return text ? text.slice(0, 1).toUpperCase() : '·'
  }

  const fmtTime = (ts) => {
    const date = new Date(Number(ts) || 0)
    if (!Number.isFinite(date.getTime())) return ''
    const pad = (n) => String(n).padStart(2, '0')
    return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  const sourceLabel = (source) => {
    if (source === 'windows') return 'Windows 通知'
    if (source === 'local-trigger') return '本地接口'
    return source || '未知来源'
  }

  function matches(item) {
    if (state.filter === 'windows' || state.filter === 'local-trigger') {
      if (item.source !== state.filter) return false
    } else if (state.filter === 'warn' || state.filter === 'critical') {
      if (item.level !== state.filter) return false
    }
    if (state.search) {
      const haystack = `${item.title} ${item.content} ${item.app}`.toLowerCase()
      if (!haystack.includes(state.search.toLowerCase())) return false
    }
    return true
  }

  function render() {
    const items = state.items.filter(matches)
    el.count.textContent = `${items.length} 条`
    const status = state.status
    if (status) {
      const total = status.totalRecords ?? items.length
      el.meta.innerHTML =
        `共 ${total} 条记录 · Windows 通知：${esc(accessText(status.windows && status.windows.access))}` +
        ` · 本地接口：${status.endpoint ? esc(status.endpoint) : '未启用'}` +
        (status.token ? ` · 令牌 <code>${esc(status.token.slice(0, 6) + '…' + status.token.slice(-4))}</code>` : '')
    }

    if (items.length === 0) {
      el.list.innerHTML = '<div class="empty">还没有通知记录。<br>Windows 通知或本地脚本推送后会出现在这里。</div>'
      return
    }

    el.list.innerHTML = items.map((item) => {
      const levelClass = item.level === 'warn' ? ' warn' : item.level === 'critical' ? ' critical' : ''
      return '<article class="row' + (item.dismissedAt ? ' is-dismissed' : '') + '">' +
        `<div class="badge${levelClass}">${esc(initial(item.app))}</div>` +
        '<div class="body">' +
          '<div class="top">' +
            `<span class="title">${esc(item.title)}</span>` +
            `<span class="time">${esc(fmtTime(item.ts))}</span>` +
          '</div>' +
          (item.content ? `<div class="sub">${esc(item.content)}</div>` : '') +
          '<div class="tags">' +
            `<span class="tag">${esc(item.app)}</span>` +
            `<span class="tag">${esc(sourceLabel(item.source))}</span>` +
            (item.level !== 'info' ? `<span class="tag">${item.level === 'critical' ? '严重' : '警告'}</span>` : '') +
            (item.repeat > 0 ? `<span class="tag">重复 ${item.repeat + 1} 次</span>` : '') +
            (item.dismissedAt ? '<span class="tag">已撤回</span>' : '') +
          '</div>' +
        '</div>' +
      '</article>'
    }).join('')
  }

  function accessText(access) {
    if (access === 'allowed') return '监听中'
    if (access === 'denied') return '未授权'
    if (access === 'unspecified') return '待授权'
    if (access === 'unavailable') return '不可用'
    return '连接中'
  }

  async function refresh() {
    if (!bridge) return
    try {
      const result = await bridge.snapshot()
      if (result) {
        state.status = result.status
        state.items = result.items || []
      }
      render()
    } catch { /* 忽略 */ }
  }

  el.filters.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-filter]')
    if (!button) return
    state.filter = button.getAttribute('data-filter')
    for (const item of el.filters.querySelectorAll('button')) item.classList.toggle('active', item === button)
    render()
  })

  el.search.addEventListener('input', () => {
    state.search = el.search.value.trim()
    render()
  })

  el.clear.addEventListener('click', async () => {
    if (!bridge) return
    const result = await bridge.clearWithConfirm()
    if (!result || result.action === 'cancel') return
    state.items = []
    await refresh()
  })

  setInterval(refresh, 5000)
  void refresh()
})()
