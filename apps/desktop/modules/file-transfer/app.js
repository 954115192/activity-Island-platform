(() => {
  'use strict';
  const api = window.islandTransfer;
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const size = bytes => { if (!bytes) return '0 B'; const i = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024))); return (bytes / 1024 ** i).toFixed(i ? 1 : 0) + ' ' + ['B','KB','MB','GB'][i]; };
  const paths = {
    text:'<path d="M4 5h16M12 5v15M8 20h8"/>',
    copy:'<rect x="8" y="8" width="13" height="13" rx="3"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    send:'<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    receive:'<path d="M12 3v12m-5-5 5 5 5-5M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"/>',
    transfer:'<path d="M4 7h16m-5-5 5 5-5 5M20 17H4m5-5-5 5 5 5"/>',
    settings:'<path d="m9 3-1 3-3 1-2 3 2 2-1 3 2 3h3l2 3h3l1-3 3-1 2-3-2-2 1-3-2-3h-3l-2-3Z"/><circle cx="12" cy="12" r="3"/>',
    history:'<path d="M3 11a9 9 0 1 1 2.6 7M3 4v7h7M12 7v5l3 2"/>',
    close:'<path d="m6 6 12 12M6 18 18 6"/>',
    arrow:'<path d="M4 12h16m-6-6 6 6-6 6"/>',
    refresh:'<path d="M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5m-4 8a8 8 0 0 0 14 3l3-3m0 5v-5h-5"/>',
    connect:'<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4m-3-11h6m-3-3v6"/>',
    file:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
    folder:'<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
    desktop:'<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
    mobile:'<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 18h4"/>',
    check:'<path d="m5 12 4 4L19 6"/>',
    search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>'
  };
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.file}</svg>`;
  document.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); });
  const states = { waiting:'等待对方接受', transferring:'传输中', verifying:'正在校验文件', completed:'传输完成', rejected:'对方已拒绝', cancelled:'已取消', failed:'传输失败' };
  const terminal = new Set(['completed','rejected','cancelled','failed']);
  let snapshot, page = 'send', mode = 'files', focusSession, busy = false, sendingText;
  const encoder = new TextEncoder();
  const isText = file => file.kind === 'text';
  const hasText = session => session.files.some(isText);
  const allText = session => session.files.every(isText);
  const fullText = session => session.files.filter(isText).every(f => typeof f.text === 'string' || typeof f.preview === 'string' && encoder.encode(f.preview).length === f.size);
  const isLink = session => {
    if (!allText(session) || session.files.length !== 1 || !fullText(session)) return false;
    try { return ['https:', 'http:'].includes(new URL((session.files[0].text ?? session.files[0].preview).trim()).protocol); } catch { return false; }
  };
  const textBytes = () => encoder.encode($('message').value).length;
  let knownSessions = new Set();
  let lastScene;
  const htmlCache = new Map();
  function html(id, value) {
    if (htmlCache.get(id) === value) return;
    const element = $(id);
    const scrolls = [...element.querySelectorAll('.file-list,.transfer-files')].map(list => list.scrollTop);
    element.innerHTML = value;
    element.querySelectorAll('.file-list,.transfer-files').forEach((list, index) => { list.scrollTop = scrolls[index] || 0; });
    htmlCache.set(id, value);
  }
  function notice(text) { $('notice').textContent = text; $('notice').hidden = !text; }
  function go(next, id) {
    page = next;
    if (id) focusSession = id;
    if (snapshot) render(snapshot);
    $('content').scrollTop = 0;
  }
  async function call(method, value) {
    try {
      const result = await api.call(method, value);
      if (!result.ok) { notice(result.error || '操作失败，请重试'); return false; }
      notice('');
      if (result.snapshot) render(result.snapshot);
      return true;
    } catch { notice('暂时无法连接传输服务，请重新打开文件传输'); return false; }
  }
  function fileRows(files, editable = false) {
    return files.map(file => `<div class="file-row"><span class="file-badge">${icon('file')}</span><div class="file-info"><span class="file-name" title="${esc(file.fileName)}">${esc(file.fileName)}</span><span class="file-size">${size(file.size)}</span></div>${editable ? `<button class="icon-button" data-action="remove" data-id="${esc(file.id)}" aria-label="移除 ${esc(file.fileName)}" title="移除文件">${icon('close')}</button>` : ''}</div>`).join('');
  }
  function textCards(files) {
    return files.map(file => isText(file) ? `<article class="text-preview"><div class="text-preview-label">${icon('text')}文本${file.text === undefined && file.preview !== undefined && encoder.encode(file.preview).length < file.size ? ' · 部分预览' : ''}</div><pre>${esc(file.text ?? file.preview ?? '本次文本内容未保存，请让对方重新发送')}</pre></article>` : fileRows([file])).join('');
  }
  function detail(session, offer) {
    const running = !terminal.has(session.state);
    const text = allText(session);
    const fraction = session.total ? Math.min(100, session.bytes / session.total * 100) : (session.state === 'completed' ? 100 : 0);
    const state = session.state === 'rejected' && session.direction === 'incoming' ? '已拒绝接收' : states[session.state];
    const readyCopy = text && fullText(session);
    return `<div class="transfer-detail" data-state="${esc(session.state)}"><div class="peer-heading"><span class="peer-symbol">${icon(text ? 'text' : session.direction === 'incoming' ? 'receive' : 'send')}</span><div><h2>${esc(session.peer)}</h2><p class="muted">${offer ? text ? '与你分享一段文本' : '想向你发送文件' : session.direction === 'incoming' ? text ? '分享给你的文本' : '发送给你的文件' : text ? '你分享的文本' : '你发送的文件'}</p></div></div><div class="transfer-summary"><span>${text ? '文本与链接' : `${session.files.length} 个文件`}</span><span>${size(session.total)}</span></div><div class="transfer-files">${textCards(session.files)}</div><div class="transfer-bottom">${offer ? `<p>${text ? '直接在岛上阅读，接受后可复制。' : `接受后保存到：${esc(snapshot.saveDirectory)}`}</p><div class="actions"><button data-action="reject" data-id="${esc(session.id)}">拒绝</button><button class="primary" data-action="${readyCopy ? 'accept-copy' : 'accept'}" data-id="${esc(session.id)}">${readyCopy ? '接受并复制' : '接受'}</button>${readyCopy && isLink(session) ? `<button data-action="accept-open" data-id="${esc(session.id)}">打开链接</button>` : ''}</div>` : `<div class="result-label ${esc(session.state)}">${esc(state)}</div>${running ? `<p>${session.state === 'waiting' ? '等待对方轻点接受，可收起灵动岛等待。' : `${size(session.bytes)} / ${size(session.total)} · ${fraction.toFixed(0)}%`}</p>${session.state !== 'waiting' ? `<progress max="100" value="${fraction}" aria-label="传输进度"></progress>` : ''}` : ''}${session.error ? `<div class="error-text">${esc(session.error)}</div>` : ''}<div class="actions">${running ? `<button data-action="cancel" data-id="${esc(session.id)}">取消传输</button>` : `<button data-nav="${session.direction === 'outgoing' ? 'send' : 'receive'}">${session.direction === 'outgoing' ? '继续分享' : '返回'}</button>${session.state === 'completed' && text && readyCopy ? `<button class="primary" data-action="copy-text" data-id="${esc(session.id)}">${icon('copy')}复制文本</button>${isLink(session) ? `<button data-action="open-text" data-id="${esc(session.id)}">打开链接</button>` : ''}` : session.state === 'completed' && session.direction === 'incoming' && !text ? '<button class="primary" data-action="folder">打开文件夹</button>' : ''}`}</div>`}</div></div>`;
  }
  function renderMode() {
    $('text-section').hidden = mode !== 'text';
    $('draft-section').hidden = mode !== 'files';
    document.querySelectorAll('[data-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === mode)));
    const bytes = textBytes();
    $('text-count').textContent = `${size(bytes)} / 64 KB`;
    $('text-count').classList.toggle('error-text', bytes > 65536);
  }
  function render(value) {
    if (!value) return;
    const previous = snapshot;
    snapshot = value;
    const offers = value.sessions.filter(s => s.direction === 'incoming' && s.state === 'waiting');
    const active = value.sessions.filter(s => !terminal.has(s.state));
    const activeSend = active.some(s => s.direction === 'outgoing');
    const newOffer = offers.find(s => !knownSessions.has(s.id));
    const newTask = active.find(s => !knownSessions.has(s.id)) || (previous && value.sessions.find(s => !knownSessions.has(s.id)));
    if (newOffer || newTask) { focusSession = (newOffer || newTask).id; page = 'transfer'; }
    else if (previous && JSON.stringify(previous.draft) !== JSON.stringify(value.draft) && value.draft.length && !offers.length) { page = 'send'; mode = 'files'; }
    if (sendingText && value.sessions.some(s => s.direction === 'outgoing' && hasText(s) && !knownSessions.has(s.id))) {
      if ($('message').value === sendingText) $('message').value = '';
      sendingText = undefined;
    }
    knownSessions = new Set(value.sessions.map(s => s.id));
    const focused = value.sessions.find(s => s.id === focusSession);
    if (page === 'transfer' && !focused) page = 'send';
    const incoming = focused?.direction === 'incoming' && focused.state === 'waiting';
    const scene = page === 'transfer' ? allText(focused) ? 'text' : 'task' : 'home';
    if (scene !== lastScene) {
      lastScene = scene;
      api?.call('layout', scene).catch(() => {});
    }
    const title = { send:'隔空分享', receive:'随时接收', settings:'设置', history:'传输记录', transfer:incoming ? '接收请求' : focused?.direction === 'incoming' ? '接收文件' : '发送文件' }[page];
    $('page-title').textContent = page === 'transfer' && focused && allText(focused) ? incoming ? '收到一段文本' : '文本分享' : title;
    $('page-subtitle').textContent = { send:'轻轻一放，分享给身边的设备', receive:'让内容自然来到你的岛上', settings:'按你的习惯来', history:'最近的分享都在这里', transfer:'' }[page];
    $('page-subtitle').hidden = page === 'transfer';
    renderMode();
    for (const name of ['send','receive','settings','history','transfer']) $(name + '-page').hidden = name !== page;
    document.querySelectorAll('[data-page]').forEach(button => { if (button.dataset.page === page || page === 'transfer' && button.dataset.page === (focused?.direction === 'incoming' ? 'receive' : 'send')) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
    $('history').setAttribute('aria-pressed', String(page === 'history'));
    $('receive-dot').hidden = !active.some(s => s.direction === 'incoming');
    const statusText = { starting:'启动中', running:'可接收文件', error:'服务不可用', stopped:'已停止' }[value.status];
    for (const id of ['status','footer-status']) { $(id).textContent = statusText; $(id).className = 'status' + (value.status === 'error' ? ' error' : ''); }
    if (value.error) notice(value.error);
    const banner = offers[0] || active[0];
    $('active-banner').hidden = page === 'transfer' || !banner;
    if (banner) { $('active-banner').dataset.id = banner.id; html('active-banner', `<span>${esc(banner.peer)} · ${banner.direction === 'incoming' && banner.state === 'waiting' ? '等待你接受' : esc(states[banner.state])}</span>${icon('arrow')}`); }
    $('clear').hidden = !value.draft.length;
    $('draft-heading').textContent = value.draft.length ? '已选择' : '选择文件';
    html('draft', value.draft.length ? `<div class="selected-files"><div class="selection-summary"><strong>${value.draft.length} 个文件</strong><span class="muted">· ${size(value.draft.reduce((n,f) => n + f.size, 0))}</span><button class="text-button" data-action="choose">添加文件</button><button class="icon-button" data-action="clear" aria-label="清空文件">${icon('close')}</button></div><div class="file-list">${fileRows(value.draft, true)}</div></div>` : `<div class="empty-draft">${icon('file')}<div><h2>将文件拖到灵动岛</h2><p class="muted">与附近的设备分享文件</p><button data-action="choose">${icon('file')}选择文件</button><button data-mode="text">${icon('text')}发送文本</button></div></div>`);
    $('device-count').textContent = value.devices.length || '';
    const ready = mode === 'text' ? $('message').value.trim() && textBytes() <= 65536 : value.draft.length;
    $('send-hint').textContent = activeSend ? '正在分享，可点顶部查看进度' : ready ? '轻点设备，即刻分享' : mode === 'text' ? '输入文本后，选择想分享的设备' : '先放入文件，再轻点设备';
    html('devices', value.devices.length ? value.devices.map((device, index) => `<button class="device" style="--i:${Math.min(index, 8)}" data-device="${esc(device.id)}" ${!ready || activeSend || busy || value.status !== 'running' ? 'disabled' : ''} title="${esc(device.host)} · ${esc(device.fingerprint)}">${icon(device.deviceType === 'mobile' ? 'mobile' : 'desktop')}<div><strong>${esc(device.alias)}</strong><small>${esc(device.deviceModel || device.host)}${device.protocol === 'http' ? ' · 未加密' : ''}</small></div></button>`).join('') : `<div class="empty">${icon('search')}未发现附近设备<p>在另一台设备上打开灵动岛或 LocalSend<br>并连接同一局域网</p></div>`);
    $('incoming').hidden = !incoming;
    $('current-task').hidden = !!incoming;
    if (focused) html(incoming ? 'incoming' : 'current-task', detail(focused, incoming));
    html('tasks', value.sessions.length ? value.sessions.map(s => `<div class="task"><div class="task-head">${icon(s.direction === 'incoming' ? 'receive' : 'send')}<strong>${s.direction === 'incoming' ? '来自' : '发送给'} ${esc(s.peer)}</strong><span class="task-state ${esc(s.state)}">${esc(states[s.state])}</span></div><div class="task-detail"><span>${allText(s) ? '文本' : `${s.files.length} 个文件`} · ${size(s.total)}</span><span>${esc(new Date(s.createdAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}))}</span></div><button class="text-button" data-session="${esc(s.id)}">查看详情</button></div>`).join('') : `<div class="empty">${icon('history')}还没有传输记录<p>发送或接收的文件会显示在这里</p></div>`);
    $('identity').textContent = value.alias;
    $('settings-alias').textContent = value.alias;
    $('footer-alias').textContent = value.alias;
    $('footer-alias').title = value.alias;
    $('directory').textContent = value.saveDirectory;
    $('network').textContent = value.addresses.map(a => `${a}:${value.port}`).join('\n') || '无可用局域网地址';
    $('refresh').title = value.status === 'error' ? '重试启动' : '刷新设备';
    $('refresh').setAttribute('aria-label', $('refresh').title);
  }
  document.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.dataset.mode) { mode = button.dataset.mode; render(snapshot); if (mode === 'text') $('message').focus(); return; }
    if (button.dataset.page || button.dataset.nav) { go(button.dataset.page || button.dataset.nav); return; }
    if (button.dataset.session) { go('transfer', button.dataset.session); return; }
    if (button.dataset.device) {
      busy = true; render(snapshot);
      if (mode === 'text') {
        sendingText = $('message').value;
        const sent = await call('send-text', { id:button.dataset.device, text:sendingText, pin:$('pin').value.trim() });
        if (sent && $('message').value === sendingText) $('message').value = '';
        sendingText = undefined;
      } else await call('send', { id:button.dataset.device, pin:$('pin').value.trim() });
      busy = false; render(snapshot); return;
    }
    if (button.dataset.action) {
      const action = button.dataset.action, id = button.dataset.id;
      button.disabled = true;
      let ok;
      if (action === 'accept-copy' || action === 'accept-open') { ok = await call('accept', id); if (ok) ok = await call(action === 'accept-copy' ? 'copy-text' : 'open-text', id); }
      else ok = await call(action, id);
      if (ok && ['copy-text','accept-copy'].includes(action)) { $('copy-feedback').textContent = '已复制到剪贴板'; clearTimeout(copyTimer); copyTimer = setTimeout(() => { $('copy-feedback').textContent = ''; }, 2200); }
      button.disabled = false;
    }
  });
  let copyTimer;
  $('message').oninput = () => { if (snapshot) render(snapshot); };
  $('text-clear').onclick = () => { $('message').value = ''; if (snapshot) render(snapshot); $('message').focus(); };
  $('active-banner').onclick = () => go('transfer', $('active-banner').dataset.id);
  $('history').onclick = () => go('history');
  $('close').onclick = () => call('close');
  $('clear').onclick = () => call('clear');
  $('refresh').onclick = async () => { const b = $('refresh'); b.disabled = true; await call(snapshot?.status === 'error' ? 'retry' : 'refresh'); b.disabled = false; };
  $('directory-change').onclick = () => call('directory');
  $('connect-toggle').onclick = () => { $('connect-form').hidden = !$('connect-form').hidden; if (!$('connect-form').hidden) $('address').focus(); };
  $('connect-form').onsubmit = async event => { event.preventDefault(); const button = event.submitter || $('connect-form').querySelector('button'); button.disabled = true; if (await call('connect', $('address').value.trim())) $('connect-form').hidden = true; button.disabled = false; };
  $('rename').onclick = () => { $('rename-form').hidden = !$('rename-form').hidden; $('alias').value = snapshot?.alias || ''; if (!$('rename-form').hidden) $('alias').focus(); };
  $('rename-form').onsubmit = async event => { event.preventDefault(); const button = event.submitter || $('rename-form').querySelector('button'); button.disabled = true; if (await call('configure', $('alias').value.trim())) $('rename-form').hidden = true; button.disabled = false; };
  document.addEventListener('keydown', event => { if (event.key === 'Escape') call('close'); });
  if (api) {
    api.onChange(render);
    api.onError(notice);
    api.snapshot().then(result => { if (result.snapshot) render(result.snapshot); else notice(result.error || '传输服务未就绪'); }).catch(() => notice('传输服务未就绪'));
  } else notice('请从灵动岛打开文件传输');
})();
