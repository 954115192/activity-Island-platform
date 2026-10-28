(() => {
  'use strict';
  const api = window.islandTransfer;
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const size = bytes => { if (!bytes) return '0 B'; const i = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024))); return (bytes / 1024 ** i).toFixed(i ? 1 : 0) + ' ' + ['B','KB','MB','GB'][i]; };
  const icon = mobile => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">${mobile ? '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 18h4"/>' : '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>'}</svg>`;
  const fileIcon = '<svg class="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/></svg>';
  const states = { waiting:'等待对方接受', transferring:'传输中', verifying:'正在校验文件', completed:'已完成', rejected:'已拒绝', cancelled:'已取消', failed:'传输失败' };
  const terminal = new Set(['completed','rejected','cancelled','failed']);
  let snapshot;
  let busy = false;
  let lastDraft = '';
  function notice(text) { $('notice').textContent = text; $('notice').hidden = !text; }
  async function call(method, value) {
    try {
      const result = await api.call(method, value);
      if (!result.ok) { notice(result.error || '操作失败，请重试'); return false; }
      notice('');
      if (result.snapshot) render(result.snapshot);
      return true;
    } catch { notice('暂时无法连接传输服务，请重新打开文件传输'); return false; }
  }
  function fileRows(files, max = 5) {
    return files.slice(0, max).map(file => `<div class="file-row">${fileIcon}<span class="file-name" title="${esc(file.fileName)}">${esc(file.fileName)}</span><span class="file-size">${size(file.size)}</span></div>`).join('') + (files.length > max ? `<p class="muted">另有 ${files.length - max} 个文件</p>` : '');
  }
  function render(value) {
    if (!value) return;
    snapshot = value;
    const activeSend = value.sessions.some(s => s.direction === 'outgoing' && !terminal.has(s.state));
    $('status').textContent = { starting:'启动中', running:'可接收', error:'不可用', stopped:'已停止' }[value.status];
    $('status').className = 'status' + (value.status === 'error' ? ' error' : '');
    if (value.error) notice(value.error);
    const signature = JSON.stringify(value.draft);
    if (lastDraft !== signature || !$('draft').children.length) {
      lastDraft = signature;
      $('draft').innerHTML = value.draft.length ? fileRows(value.draft) : `<div class="empty-draft">${fileIcon}<div><p>将文件拖到灵动岛</p><p class="muted">或选择文件，点击下方设备发送</p></div><button data-action="choose">选择文件</button></div>`;
    }
    $('draft-summary').textContent = value.draft.length ? `${value.draft.length} 个文件 · ${size(value.draft.reduce((n,f) => n + f.size, 0))}` : '';
    $('clear').hidden = !value.draft.length;
    $('devices').innerHTML = value.devices.length ? value.devices.map(device => `<button class="device" data-device="${esc(device.id)}" ${!value.draft.length || activeSend || busy || value.status !== 'running' ? 'disabled' : ''} title="${esc(device.host)} · ${esc(device.fingerprint)}">${icon(device.deviceType === 'mobile')}<div><strong>${esc(device.alias)}</strong><small>${esc(device.deviceModel || device.host)}${device.protocol === 'http' ? ' · 未加密' : ''}</small></div></button>`).join('') : '<div class="empty">正在寻找附近设备<br><span class="muted">另一台设备打开灵动岛或 LocalSend，并连接同一局域网</span></div>';
    const offers = value.sessions.filter(s => s.direction === 'incoming' && s.state === 'waiting');
    $('incoming').hidden = !offers.length;
    $('draft-section').hidden = offers.length > 0;
    $('incoming').innerHTML = offers.map(s => `<div class="offer"><h2>${esc(s.peer)} 想发送文件</h2><p class="muted">附近设备 · 名称由对方提供</p><p>${s.files.length} 个文件 · ${size(s.total)}</p>${fileRows(s.files, 3)}<div class="actions"><button data-action="reject" data-id="${esc(s.id)}">拒绝</button><button class="primary" data-action="accept" data-id="${esc(s.id)}">接受文件</button></div></div>`).join('');
    const tasks = value.sessions.filter(s => !offers.includes(s)).slice(0, 8);
    $('tasks-section').hidden = !tasks.length;
    $('tasks').innerHTML = tasks.map(s => {
      const running = !terminal.has(s.state);
      const fraction = s.total ? Math.min(100, s.bytes / s.total * 100) : (s.state === 'completed' ? 100 : 0);
      return `<div class="task"><div class="task-head"><strong>${s.direction === 'incoming' ? '来自' : '发送给'} ${esc(s.peer)}</strong><span class="muted">${esc(states[s.state] || s.state)}</span>${running ? `<button class="text-button" data-action="cancel" data-id="${esc(s.id)}">取消</button>` : ''}</div><div class="task-detail"><span title="${esc(s.files.map(f => f.fileName).join('、'))}">${s.files.length} 个文件 · ${size(s.total)}</span><span>${running && s.state === 'transferring' ? `${fraction.toFixed(0)}%` : ''}</span></div>${s.state === 'transferring' ? `<progress max="100" value="${fraction}" aria-label="文件传输进度"></progress>` : ''}${s.error ? `<div class="error-text">${esc(s.error)}</div>` : ''}${s.state === 'completed' && s.direction === 'incoming' ? '<button class="text-button" data-action="folder">打开文件夹</button>' : ''}${s.state === 'failed' && s.direction === 'outgoing' ? '<button class="text-button" data-action="choose">重新选择文件重试</button>' : ''}</div>`;
    }).join('');
    $('identity').textContent = `${value.alias} · ${value.addresses[0] || '无可用局域网地址'}:${value.port}`;
    $('identity').title = value.addresses.map(a => `${a}:${value.port}`).join('\n');
    $('directory').textContent = value.saveDirectory;
    $('directory').title = value.saveDirectory;
    $('refresh').textContent = value.status === 'error' ? '重试启动' : '刷新';
  }
  document.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    const device = button.dataset.device;
    if (device) {
      busy = true; render(snapshot);
      await call('send', { id:device, pin:$('pin').value.trim() });
      busy = false; render(snapshot); return;
    }
    if (button.dataset.action) {
      button.disabled = true;
      await call(button.dataset.action, button.dataset.id);
      button.disabled = false;
    }
  });
  $('close').onclick = () => call('close');
  $('clear').onclick = () => call('clear');
  $('refresh').onclick = () => call(snapshot?.status === 'error' ? 'retry' : 'refresh');
  $('folder').onclick = () => call('folder');
  $('directory-change').onclick = () => call('directory');
  $('connect-toggle').onclick = () => { $('connect-form').hidden = !$('connect-form').hidden; if (!$('connect-form').hidden) $('address').focus(); };
  $('connect-form').onsubmit = async event => { event.preventDefault(); const button = event.submitter || $('connect-form').querySelector('button'); button.disabled = true; if (await call('connect', $('address').value.trim())) $('connect-form').hidden = true; button.disabled = false; };
  $('rename').onclick = () => { $('rename-form').hidden = !$('rename-form').hidden; $('alias').value = snapshot?.alias || ''; if (!$('rename-form').hidden) $('alias').focus(); };
  $('rename-form').onsubmit = async event => { event.preventDefault(); if (await call('configure', $('alias').value.trim())) $('rename-form').hidden = true; };
  document.addEventListener('keydown', event => { if (event.key === 'Escape') call('close'); });
  if (api) {
    api.onChange(render);
    api.onError(notice);
    api.snapshot().then(result => { if (result.snapshot) render(result.snapshot); else notice(result.error || '传输服务未就绪'); }).catch(() => notice('传输服务未就绪'));
  } else notice('请从灵动岛打开文件传输');
})();
