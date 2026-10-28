(() => {
  'use strict'

  const bridge = window.confirmDialog
  const params = new URLSearchParams(location.search)
  const windowsAvailable = params.get('windowsAvailable') === '1'

  const both = document.getElementById('both')
  const bothSub = document.getElementById('both-sub')
  const note = document.getElementById('note')

  if (windowsAvailable) {
    note.textContent = 'Windows 通知中心将清空全部通知，操作不可撤销。'
  } else {
    note.textContent = '当前没有 Windows 通知访问权限，无法清空系统通知中心。'
    both.disabled = true
    bothSub.textContent = '需要先允许应用访问通知'
  }

  function choose(action) {
    if (action === 'both' && !windowsAvailable) return
    if (bridge) bridge.choose(action)
  }

  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]')
    if (!button || button.disabled) return
    choose(button.getAttribute('data-action'))
  })

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      choose('cancel')
    } else if (event.key === 'Enter') {
      event.preventDefault()
      // 回车走应用内清空：影响面最小
      choose('app-only')
    }
  })

  setTimeout(() => {
    const first = document.querySelector('button.choice.primary')
    if (first) first.focus()
  }, 30)
})()
