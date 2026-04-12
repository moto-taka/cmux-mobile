// cmux mobile web client — terminal mirror via xterm.js + cmux capture-pane

(function () {
  'use strict';

  // ─── State ───

  let currentWorkspaceId = null;
  let currentSurfaceId = null;
  let workspaces = [];
  let sidebarOpen = false;
  let infoPanelOpen = false;
  let ws = null;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 50;

  let clientId = null;
  let isApplyingRemoteChange = false;
  let term = null; // xterm.js Terminal instance
  let terminalAttached = false;

  // Pinch-zoom state
  let pinchStartDistance = 0;
  let pinchStartFontSize = 14;

  // Extra keys sticky state
  let ctrlActive = false;
  let altActive = false;

  // ─── DOM refs ───

  const $ = (sel) => document.querySelector(sel);
  const overlay = $('#overlay');
  const sidebar = $('#sidebar');
  const sidebarClose = $('#sidebar-close');
  const workspaceList = $('#workspace-list');
  const menuBtn = $('#menu-btn');
  const workspaceName = $('#workspace-name');
  const infoBtn = $('#info-btn');
  const refreshBtn = $('#refresh-btn');
  const infoPanel = $('#info-panel');
  const infoClose = $('#info-close');
  const infoContent = $('#info-content');
  const surfaceTabs = $('#surface-tabs');
  const terminalContainer = $('#terminal-container');
  const loadingScreen = $('#loading-screen');
  const errorScreen = $('#error-screen');
  const retryBtn = $('#retry-btn');
  const connStatus = $('#conn-status');
  const toastContainer = $('#toast-container');
  const extraKeysBar = $('#extra-keys-bar');

  // ─── Terminal (xterm.js) ───

  function initTerminal() {
    if (term) return term;

    if (typeof Terminal === 'undefined') {
      console.error('[cmux] xterm.js not loaded');
      return null;
    }

    const savedFontSize = localStorage.getItem('cmux-font-size');
    const initialFontSize = savedFontSize ? parseInt(savedFontSize, 10) : 14;

    term = new Terminal({
      theme: {
        background: '#1e1e2e',
        foreground: '#cdd6f4',
        cursor: '#f5e0dc',
        cursorAccent: '#1e1e2e',
        selectionBackground: '#585b70',
        black: '#45475a',
        red: '#f38ba8',
        green: '#a6e3a1',
        yellow: '#f9e2af',
        blue: '#89b4fa',
        magenta: '#f5c2e7',
        cyan: '#94e2d5',
        white: '#bac2de',
        brightBlack: '#585b70',
        brightRed: '#f38ba8',
        brightGreen: '#a6e3a1',
        brightYellow: '#f9e2af',
        brightBlue: '#89b4fa',
        brightMagenta: '#f5c2e7',
        brightCyan: '#94e2d5',
        brightWhite: '#a6adc8',
      },
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: initialFontSize,
      cursorBlink: true,
      scrollback: 5000,
      convertEol: true,
    });

    term.open(terminalContainer);

    // Send user input to cmux via server
    term.onData((data) => {
      if (currentSurfaceId) {
        send({ type: 'terminal_input', data: { surfaceId: currentSurfaceId, data } });
      }
    });

    // Resize handling
    const resizeObserver = new ResizeObserver(() => {
      if (term) term.fit && term.fit();
    });
    resizeObserver.observe(terminalContainer);

    // ── Pinch-zoom font resize ──

    terminalContainer.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 2) return;
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      pinchStartDistance = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
      pinchStartFontSize = term.options.fontSize;
    }, { passive: true });

    terminalContainer.addEventListener('touchmove', (e) => {
      if (e.touches.length !== 2) return;
      e.preventDefault();
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const distance = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
      const scale = distance / pinchStartDistance;
      const newSize = Math.round(pinchStartFontSize * scale);
      const clamped = Math.max(8, Math.min(32, newSize));
      term.options.fontSize = clamped;
      if (term.fit) term.fit();
    }, { passive: false });

    terminalContainer.addEventListener('touchend', (e) => {
      if (e.touches.length >= 2) return; // still pinching
      // Persist on pinch end
      localStorage.setItem('cmux-font-size', String(term.options.fontSize));
    }, { passive: true });

    return term;
  }

  function showLoading() {
    loadingScreen.classList.remove('hidden');
    errorScreen.style.display = 'none';
    terminalContainer.style.display = 'none';
  }

  function showError() {
    loadingScreen.classList.add('hidden');
    errorScreen.style.display = 'flex';
    terminalContainer.style.display = 'none';
    connStatus.className = 'conn-status';
    connStatus.title = 'Disconnected';
  }

  function showTerminal() {
    loadingScreen.classList.add('hidden');
    errorScreen.style.display = 'none';
    terminalContainer.style.display = 'block';
    if (!term) {
      initTerminal();
    }
    if (term) {
      // Resize to fit container
      setTimeout(() => {
        if (term && term.fit) term.fit();
      }, 100);
    }
  }

  function setConnStatus(state) {
    connStatus.className = 'conn-status ' + state;
    connStatus.title = state === 'connected' ? 'Connected' : state === 'connecting' ? 'Connecting...' : 'Disconnected';
  }

  // ─── Toast Notifications ───

  function showToast(message, type) {
    const toast = document.createElement('div');
    toast.className = 'toast' + (type ? ' ' + type : '');
    toast.textContent = message;
    toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('toast-out');
      toast.addEventListener('animationend', () => toast.remove());
    }, 2500);
  }

  // ─── WebSocket ───

  function getToken() {
    const params = new URLSearchParams(location.search);
    return params.get('token');
  }

  function connectWS() {
    setConnStatus('connecting');
    showLoading();
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const token = getToken();
    const wsUrl = token
      ? `${protocol}//${location.host}/ws?token=${encodeURIComponent(token)}`
      : `${protocol}//${location.host}/ws`;
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('[cmux] WebSocket connected');
      setConnStatus('connected');
      reconnectAttempts = 0;
      showToast('Connected', 'success');
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleMessage(msg);
      } catch (e) {
        console.error('[cmux] Failed to parse message:', e);
      }
    };

    ws.onclose = () => {
      console.log('[cmux] WebSocket closed, reconnecting...');
      setConnStatus('');
      showToast('Disconnected — reconnecting...', 'error');
      detachTerminal();
      if (workspaces.length === 0) showError();
      scheduleReconnect();
    };

    ws.onerror = (err) => {
      console.error('[cmux] WebSocket error:', err);
    };
  }

  function getReconnectDelay() {
    const base = 3000;
    const delay = Math.min(base * Math.pow(1.5, reconnectAttempts), 30000);
    reconnectAttempts++;
    return delay;
  }

  function scheduleReconnect() {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.log('[cmux] Max reconnect attempts reached');
      showError();
      return;
    }
    if (reconnectTimer) return;
    const delay = getReconnectDelay();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectWS();
    }, delay);
  }

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectAttempts = 0;
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  // ─── Terminal attach/detach ───

  function attachTerminal(workspaceId, surfaceId) {
    if (terminalAttached) {
      send({ type: 'terminal_detach', data: {} });
    }
    terminalAttached = true;
    send({
      type: 'terminal_attach',
      data: { workspaceId, surfaceId },
    });
    showTerminal();
  }

  function detachTerminal() {
    if (terminalAttached) {
      terminalAttached = false;
      send({ type: 'terminal_detach', data: {} });
    }
  }

  // ─── Message Handling ───

  function handleMessage(msg) {
    switch (msg.type) {
      case 'connected':
        clientId = msg.data.clientId || null;
        console.log('[cmux] Connected to server, clientId:', clientId);
        break;
      case 'workspaces':
        workspaces = msg.data || [];
        renderSidebar();

        // URL hash からの復元を試行
        const hashState = readHash();
        if (hashState.workspaceId) {
          const exists = workspaces.find(w => w.id === hashState.workspaceId);
          if (exists) {
            selectWorkspace(hashState.workspaceId);
            if (hashState.surfaceId) selectSurface(hashState.surfaceId);
            break;
          }
        }

        // フォールバック: 最初のworkspaceを自動選択
        if (!currentWorkspaceId && workspaces.length > 0) {
          selectWorkspace(workspaces[0].id);
        } else if (currentWorkspaceId) {
          renderSurfaceTabs();
          attachTerminalForCurrentSurface();
          showTerminal();
        }
        break;
      case 'workspace_update':
        applyWorkspaceUpdate(msg.data);
        renderSidebar();
        renderSurfaceTabs();
        if (currentWorkspaceId === msg.data.id) {
          updateInfoPanel();
        }
        break;
      case 'error':
        console.error('[cmux] Server error:', msg.data);
        showToast(String(msg.data), 'error');
        break;
      case 'terminal_attached':
        console.log('[cmux] Terminal stream attached');
        if (term) term.clear();
        break;
      case 'terminal_output':
        handleTerminalOutput(msg.data);
        break;
      case 'active_view_change': {
        const change = msg.data;
        // 自分の変更のエコーバックは無視
        if (change.clientId === clientId) break;

        // ミラーモード: 他クライアントの選択状態を適用
        isApplyingRemoteChange = true;
        try {
          if (change.workspaceId && change.workspaceId !== currentWorkspaceId) {
            currentWorkspaceId = change.workspaceId;
            const wsObj = getWorkspace(currentWorkspaceId);
            if (wsObj) {
              workspaceName.textContent = wsObj.name;
            }
            renderSidebar();
          }
          if (change.surfaceId && change.surfaceId !== currentSurfaceId) {
            currentSurfaceId = change.surfaceId;
          }
          renderSurfaceTabs();
          attachTerminalForCurrentSurface();
          updateInfoPanel();
          updateHash();
        } finally {
          isApplyingRemoteChange = false;
        }
        break;
      }
    }
  }

  function handleTerminalOutput(data) {
    if (!term) {
      initTerminal();
    }
    if (!term || !data.content) return;

    // Write the captured terminal content
    // Use cursor home + content + clear to end for clean redraw
    const content = data.content;
    if (content) {
      // Clear and rewrite — capture-pane gives full screen content
      term.write('\x1b[H'); // Cursor home
      term.write(content);
      term.write('\x1b[J'); // Clear from cursor to end of screen
    }
  }

  function applyWorkspaceUpdate(updated) {
    const idx = workspaces.findIndex((w) => w.id === updated.id);
    if (idx >= 0) {
      workspaces[idx] = updated;
    } else {
      workspaces.push(updated);
    }
  }

  // ─── Workspace Selection ───

  function selectWorkspace(workspaceId) {
    if (currentWorkspaceId === workspaceId) {
      closeSidebar();
      return;
    }

    // Detach from previous terminal
    detachTerminal();

    currentWorkspaceId = workspaceId;
    currentSurfaceId = null;

    const wsObj = getWorkspace(workspaceId);
    if (wsObj) {
      workspaceName.textContent = wsObj.name;
      const active = wsObj.surfaces.find((s) => s.active) || wsObj.surfaces[0];
      if (active) {
        currentSurfaceId = active.id;
      }
    }

    renderSurfaceTabs();
    attachTerminalForCurrentSurface();
    updateInfoPanel();
    updateHash();
    closeSidebar();

    send({ type: 'select_workspace', data: { workspaceId } });
    if (currentSurfaceId) {
      send({ type: 'select_surface', data: { workspaceId, surfaceId: currentSurfaceId } });
    }
    if (clientId && !isApplyingRemoteChange) {
      send({ type: 'view_changed', data: { clientId, workspaceId, surfaceId: currentSurfaceId } });
    }
    showToast(wsObj ? wsObj.name : workspaceId);
  }

  function selectSurface(surfaceId) {
    if (currentSurfaceId === surfaceId) return;

    detachTerminal();
    currentSurfaceId = surfaceId;
    renderSurfaceTabs();
    attachTerminalForCurrentSurface();
    updateHash();

    if (currentWorkspaceId) {
      send({ type: 'select_surface', data: { workspaceId: currentWorkspaceId, surfaceId } });
    }
    if (clientId && !isApplyingRemoteChange) {
      send({ type: 'view_changed', data: { clientId, workspaceId: currentWorkspaceId, surfaceId } });
    }
  }

  function attachTerminalForCurrentSurface() {
    if (currentWorkspaceId) {
      attachTerminal(currentWorkspaceId, currentSurfaceId);
    }
  }

  // ─── URL Hash Management ───

  function updateHash() {
    const parts = [];
    if (currentWorkspaceId) parts.push('ws=' + currentWorkspaceId);
    if (currentSurfaceId) parts.push('surface=' + currentSurfaceId);
    location.hash = parts.length > 0 ? parts.join('&') : '';
  }

  function readHash() {
    const hash = location.hash.slice(1);
    const params = new URLSearchParams(hash);
    return {
      workspaceId: params.get('ws'),
      surfaceId: params.get('surface'),
    };
  }

  // ─── Rendering ───

  function getWorkspace(id) {
    return workspaces.find((w) => w.id === id);
  }

  function getStatusClass(status) {
    if (!status) return 'unknown';
    const s = status.toLowerCase();
    if (s === 'building' || s === 'running') return 'building';
    if (s === 'idle') return 'idle';
    if (s === 'error' || s === 'failed') return 'error';
    return 'unknown';
  }

  function renderSidebar() {
    workspaceList.textContent = '';
    workspaces.forEach((wsObj) => {
      const li = document.createElement('li');
      li.className = 'ws-item' + (wsObj.id === currentWorkspaceId ? ' active' : '');

      const statusClass = getStatusClass(wsObj.status);

      const header = document.createElement('div');
      header.className = 'ws-item-header';

      const dot = document.createElement('span');
      dot.className = 'ws-status-dot ' + statusClass;

      const name = document.createElement('span');
      name.className = 'ws-name';
      name.textContent = wsObj.name.length > 28 ? wsObj.name.slice(0, 26) + '...' : wsObj.name;
      name.title = wsObj.name;

      header.appendChild(dot);
      header.appendChild(name);
      li.appendChild(header);

      if (wsObj.git_branch) {
        const branch = document.createElement('span');
        branch.className = 'ws-branch';
        branch.textContent = wsObj.git_branch;
        li.appendChild(branch);
      } else if (wsObj.cwd) {
        const cwd = document.createElement('span');
        cwd.className = 'ws-branch';
        const parts = wsObj.cwd.split('/');
        cwd.textContent = parts[parts.length - 1] || wsObj.cwd;
        li.appendChild(cwd);
      }

      if (wsObj.status) {
        const statusText = document.createElement('span');
        statusText.className = 'ws-status-text ' + statusClass;
        statusText.textContent = wsObj.status;
        li.appendChild(statusText);
      }

      if (wsObj.latest_log) {
        const logEl = document.createElement('span');
        logEl.className = 'ws-latest-log';
        logEl.textContent = wsObj.latest_log;
        logEl.title = wsObj.latest_log;
        li.appendChild(logEl);
      }

      li.addEventListener('click', () => selectWorkspace(wsObj.id));
      workspaceList.appendChild(li);
    });
  }

  function renderSurfaceTabs() {
    const wsObj = getWorkspace(currentWorkspaceId);
    if (!wsObj || wsObj.surfaces.length <= 1) {
      surfaceTabs.classList.remove('visible');
      surfaceTabs.textContent = '';
      return;
    }

    surfaceTabs.classList.add('visible');
    surfaceTabs.textContent = '';

    wsObj.surfaces.forEach((surf) => {
      const tab = document.createElement('button');
      tab.className = 'surface-tab' + (surf.id === currentSurfaceId ? ' active' : '');
      tab.textContent = surf.title || surf.name;
      tab.setAttribute('aria-label', surf.title || surf.name);
      tab.addEventListener('click', () => selectSurface(surf.id));
      surfaceTabs.appendChild(tab);
    });
  }

  function updateInfoPanel() {
    const wsObj = getWorkspace(currentWorkspaceId);
    if (!wsObj) {
      infoContent.textContent = '';
      const p = document.createElement('p');
      p.className = 'info-empty';
      p.textContent = 'Select a workspace to view details.';
      infoContent.appendChild(p);
      return;
    }

    infoContent.textContent = '';

    const statusClass = getStatusClass(wsObj.status);

    infoContent.appendChild(createInfoRow('Name', wsObj.name));
    infoContent.appendChild(createInfoRow('cwd', wsObj.cwd));
    infoContent.appendChild(createInfoRow('branch', wsObj.git_branch || '-'));

    const statusRow = createInfoRow('status', wsObj.status || 'unknown');
    const val = statusRow.querySelector('.info-value');
    val.className = 'info-value ws-status-text ' + statusClass;
    infoContent.appendChild(statusRow);

    if (wsObj.surfaces && wsObj.surfaces.length > 0) {
      infoContent.appendChild(createInfoRow('surfaces', String(wsObj.surfaces.length)));
    }

    if (typeof wsObj.progress === 'number' && wsObj.progress > 0) {
      const progressRow = document.createElement('div');
      progressRow.className = 'info-row';
      const progressLabel = document.createElement('span');
      progressLabel.className = 'info-label';
      progressLabel.textContent = 'progress';
      const progressVal = document.createElement('span');
      progressVal.className = 'info-value';
      progressVal.textContent = wsObj.progress + '%';
      progressRow.appendChild(progressLabel);
      progressRow.appendChild(progressVal);
      infoContent.appendChild(progressRow);

      const bar = document.createElement('div');
      bar.className = 'info-progress-bar';
      const fill = document.createElement('div');
      fill.className = 'info-progress-fill';
      fill.style.width = Math.min(wsObj.progress, 100) + '%';
      bar.appendChild(fill);
      infoContent.appendChild(bar);
    }

    if (wsObj.latest_log) {
      infoContent.appendChild(createDivider());
      const title = document.createElement('div');
      title.className = 'info-log-title';
      title.textContent = 'Recent log';
      infoContent.appendChild(title);
      const logLine = document.createElement('div');
      logLine.className = 'info-log-line';
      logLine.textContent = wsObj.latest_log;
      infoContent.appendChild(logLine);
    }
  }

  function createInfoRow(label, value) {
    const row = document.createElement('div');
    row.className = 'info-row';
    const labelEl = document.createElement('span');
    labelEl.className = 'info-label';
    labelEl.textContent = label;
    const valEl = document.createElement('span');
    valEl.className = 'info-value';
    valEl.textContent = value;
    row.appendChild(labelEl);
    row.appendChild(valEl);
    return row;
  }

  function createDivider() {
    const hr = document.createElement('hr');
    hr.className = 'info-divider';
    return hr;
  }

  // ─── Sidebar Toggle ───

  function openSidebar() {
    sidebarOpen = true;
    sidebar.classList.add('open');
    overlay.classList.add('active');
    overlay.setAttribute('aria-hidden', 'false');
  }

  function closeSidebar() {
    sidebarOpen = false;
    sidebar.classList.remove('open');
    overlay.classList.remove('active');
    overlay.setAttribute('aria-hidden', 'true');
  }

  // ─── Info Panel Toggle ───

  function openInfoPanel() {
    infoPanelOpen = true;
    infoPanel.classList.add('open');
    updateInfoPanel();
  }

  function closeInfoPanel() {
    infoPanelOpen = false;
    infoPanel.classList.remove('open');
  }

  function toggleInfoPanel() {
    if (infoPanelOpen) {
      closeInfoPanel();
    } else {
      openInfoPanel();
    }
  }

  // ─── Extra Keys Bar ───

  const EXTRA_KEY_SEQUENCES = {
    'esc':         '\x1b',
    'tab':         '\t',
    'arrow-up':    '\x1b[A',
    'arrow-down':  '\x1b[B',
    'arrow-right': '\x1b[C',
    'arrow-left':  '\x1b[D',
    'slash':       '/',
    'minus':       '-',
    'tilde':       '~',
    'pipe':        '|',
    'amp':         '&',
  };

  function sendExtraKey(seq) {
    if (!currentSurfaceId) return;
    send({ type: 'terminal_input', data: { surfaceId: currentSurfaceId, data: seq } });
  }

  function applyModifiersAndSend(rawSeq) {
    let seq = rawSeq;

    if (ctrlActive) {
      // For single printable chars (a-z, symbols): compute Ctrl+char
      if (seq.length === 1 && seq >= 'a' && seq <= 'z') {
        seq = String.fromCharCode(seq.charCodeAt(0) - 96); // Ctrl+A = \x01 ... Ctrl+Z = \x1a
      } else if (seq.length === 1 && seq >= 'A' && seq <= 'Z') {
        seq = String.fromCharCode(seq.charCodeAt(0) - 64);
      } else if (seq === '/') {
        seq = '\x1f'; // Ctrl+/
      }
      // Arrows/escape sequences: ignore Ctrl modifier (no standard mapping)
    }

    if (altActive) {
      seq = '\x1b' + seq;
    }

    sendExtraKey(seq);

    // Consume sticky modifiers after one use
    if (ctrlActive) {
      ctrlActive = false;
      const ctrlBtn = extraKeysBar.querySelector('[data-key="ctrl"]');
      if (ctrlBtn) ctrlBtn.classList.remove('active');
    }
    if (altActive) {
      altActive = false;
      const altBtn = extraKeysBar.querySelector('[data-key="alt"]');
      if (altBtn) altBtn.classList.remove('active');
    }
  }

  function onExtraKeyClick(e) {
    const btn = e.currentTarget;
    const key = btn.dataset.key;

    if (key === 'ctrl') {
      ctrlActive = !ctrlActive;
      btn.classList.toggle('active', ctrlActive);
      return;
    }

    if (key === 'alt') {
      altActive = !altActive;
      btn.classList.toggle('active', altActive);
      return;
    }

    const seq = EXTRA_KEY_SEQUENCES[key];
    if (seq) {
      applyModifiersAndSend(seq);
    }
  }

  // Bind click handlers to all extra key buttons
  if (extraKeysBar) {
    const ekBtns = extraKeysBar.querySelectorAll('.ek-btn');
    ekBtns.forEach((btn) => {
      btn.addEventListener('click', onExtraKeyClick);
    });
  }

  // ─── Touch: Swipe gestures ───

  let touchStartX = 0;
  let touchStartY = 0;
  let touchStartTime = 0;

  function onTouchStart(e) {
    const touch = e.touches[0];
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;
    touchStartTime = Date.now();
  }

  function onTouchEnd(e) {
    const touch = e.changedTouches[0];
    const dx = touch.clientX - touchStartX;
    const rawDy = touch.clientY - touchStartY;
    const ady = Math.abs(rawDy);
    const dt = Date.now() - touchStartTime;

    if (infoPanelOpen && rawDy > 50 && ady > Math.abs(dx)) {
      closeInfoPanel();
      return;
    }

    if (ady > Math.abs(dx) || dt > 500) return;

    if (sidebarOpen && dx < -50) {
      closeSidebar();
    }
  }

  // ─── Visibility change: reconnect on focus ───

  function onVisibilityChange() {
    if (document.visibilityState === 'visible' && (!ws || ws.readyState !== WebSocket.OPEN)) {
      clearReconnectTimer();
      connectWS();
    }
  }

  // ─── Refresh workspaces ───

  let refreshing = false;

  function refreshWorkspaces() {
    if (refreshing) return;
    refreshing = true;
    refreshBtn.classList.add('spinning');
    send({ type: 'refresh', data: {} });
    setTimeout(() => {
      refreshing = false;
      refreshBtn.classList.remove('spinning');
    }, 2000);
  }

  // ─── Event Bindings ───

  menuBtn.addEventListener('click', openSidebar);
  sidebarClose.addEventListener('click', closeSidebar);
  overlay.addEventListener('click', closeSidebar);
  refreshBtn.addEventListener('click', refreshWorkspaces);

  infoBtn.addEventListener('click', toggleInfoPanel);
  infoClose.addEventListener('click', closeInfoPanel);

  document.addEventListener('touchstart', onTouchStart, { passive: true });
  document.addEventListener('touchend', onTouchEnd, { passive: true });

  document.addEventListener('visibilitychange', onVisibilityChange);

  window.addEventListener('hashchange', () => {
    const { workspaceId, surfaceId } = readHash();
    if (workspaceId && workspaceId !== currentWorkspaceId) {
      selectWorkspace(workspaceId);
    }
    if (surfaceId && surfaceId !== currentSurfaceId) {
      selectSurface(surfaceId);
    }
  });

  retryBtn.addEventListener('click', () => {
    clearReconnectTimer();
    connectWS();
  });

  // ─── Init ───

  connectWS();
})();
