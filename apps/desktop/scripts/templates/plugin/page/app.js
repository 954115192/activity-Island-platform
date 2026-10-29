(() => {
  'use strict'

  const island = window.dynamicIsland
  if (!island) return
  let settings = {}
  let stopTimer = () => {}
  const views = ['small', 'medium', 'large']

  function renderMode(mode) {
    for (const name of views) document.getElementById(name).classList.toggle('active', name === mode)
  }

  function renderContent() {
    const greeting = String(settings.greeting || '你好')
    const clock = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', ...(settings.showSeconds ? { second: '2-digit' } : {}), hour12: false })
    document.querySelectorAll('.greeting').forEach(element => { element.textContent = greeting })
    document.querySelectorAll('.clock').forEach(element => { element.textContent = clock })
    const accent = String(settings.accent || '')
    if (/^#[0-9a-f]{6}$/i.test(accent)) document.documentElement.style.setProperty('--example-accent', accent)
    else document.documentElement.style.removeProperty('--example-accent')
  }

  function applySettings(values) {
    settings = values || {}
    renderContent()
    stopTimer()
    const seconds = Math.max(1, Math.min(60, Number(settings.interval) || 1))
    stopTimer = island.every(seconds * 1000, renderContent)
  }

  island.ui.onModeChange(renderMode)
  island.settings.onChange(applySettings)
  document.getElementById('small').addEventListener('click', () => island.ui.expand())
  document.getElementById('app').addEventListener('click', event => {
    const action = event.target.closest('[data-action]')?.dataset.action
    if (action === 'collapse') island.ui.collapse()
    if (action === 'expand') island.ui.expand()
    if (action === 'alert') island.alert({ key: 'example', level: 'info', ttl: 4000 })
  })
  renderMode(island.ui.getMode())
  renderContent()
  Promise.resolve(island.ready).then(async () => {
    applySettings(await island.settings.all())
    island.log.info('__ID__ 已接入契约')
  }).catch(error => island.log.warn('初始化失败：' + String(error)))
})()
