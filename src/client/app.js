// cmux mobile web client

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
  const ttydFrame = $('#ttyd-frame');
  const loadingScreen = $('#loading-screen');
  const errorScreen = $('#error-screen');
  const retryBtn = $('#retry-btn');
  const connStatus = $('#conn-status');
  const toastContainer = $('#toast-container');

  function showLoading() {
    loadingScreen.classList.remove('hidden');
    errorScreen.style.display = 'none';
    ttydFrame.style.display = 'none';
  }

  function showError() {
    loadingScreen.classList.add('hidden');
    errorScreen.style.display = 'flex';
    ttydFrame.style.display = 'none';
    connStatus.className = 'conn-status';
    connStatus.title = 'Disconnected';
  }

  function showTerminal() {
    loadingScreen.classList.add('hidden');
    errorScreen.style.display = 'none';
    ttydFrame.style.display = 'block';
  }

  function setConnStatus(state) {
    connStatus.className = 'conn-status ' + state;
    connStatus.title = state === 'connected' ? 'Connected' : state === 'connecting' ? 'Connecting...' : 'Disconnected';
  }

  // ─── Toast Notifications ───

  function showToast(message, type) {
    // type: 'info' (default), 'error', 'success'
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
      if (workspaces.length === 0) showError();
      scheduleReconnect();
    };

    ws.onerror = (err) => {
      console.error('[cmux] WebSocket error:', err);
    };
  }

  function getReconnectDelay() {
    // Exponential backoff: 3s, 6s, 12s, ... max 30s
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
            showTerminal();
            break;
          }
        }

        // フォールバック: 最初のworkspaceを自動選択
        if (!currentWorkspaceId && workspaces.length > 0) {
          selectWorkspace(workspaces[0].id);
          showTerminal();
        } else if (currentWorkspaceId) {
          renderSurfaceTabs();
          updateTtydFrame();
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
          updateTtydFrame();
          updateInfoPanel();
          updateHash();
        } finally {
          isApplyingRemoteChange = false;
        }
        break;
      }
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
    updateTtydFrame();
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
    currentSurfaceId = surfaceId;
    renderSurfaceTabs();
    updateTtydFrame();
    updateHash();

    if (currentWorkspaceId) {
      send({ type: 'select_surface', data: { workspaceId: currentWorkspaceId, surfaceId } });
    }
    if (clientId && !isApplyingRemoteChange) {
      send({ type: 'view_changed', data: { clientId, workspaceId: currentWorkspaceId, surfaceId } });
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
      // Truncate long names, show tooltip with full name
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
        // Show directory basename as fallback when no git branch
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

  function updateTtydFrame() {
    if (!currentWorkspaceId) return;
    const wsObj = getWorkspace(currentWorkspaceId);
    if (!wsObj) return;

    if (wsObj.ttydPort) {
      const url = 'http://' + location.hostname + ':' + wsObj.ttydPort + '/';
      if (ttydFrame.src !== url) {
        showLoading();
        // Verify ttyd is reachable before loading the iframe
        fetch(url, { mode: 'no-cors', cache: 'no-store' })
          .then(() => {
            ttydFrame.src = url;
            showTerminal();
          })
          .catch(() => {
            // ttyd not reachable — show error after a brief delay for transient issues
            setTimeout(() => {
              // Only show error if this workspace is still selected
              const current = getWorkspace(currentWorkspaceId);
              if (current && current.ttydPort === wsObj.ttydPort) {
                showError();
              }
            }, 2000);
          });
      }
    }
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

    // Status row with colored text
    const statusRow = createInfoRow('status', wsObj.status || 'unknown');
    const val = statusRow.querySelector('.info-value');
    val.className = 'info-value ws-status-text ' + statusClass;
    infoContent.appendChild(statusRow);

    // Surfaces count
    if (wsObj.surfaces && wsObj.surfaces.length > 0) {
      infoContent.appendChild(createInfoRow('surfaces', String(wsObj.surfaces.length)));
    }

    // Progress bar
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

    // Latest log
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

    // Swipe down on info panel to close (vertical swipe)
    if (infoPanelOpen && rawDy > 50 && ady > Math.abs(dx)) {
      closeInfoPanel();
      return;
    }

    // Ignore slow swipes and non-horizontal movements for sidebar
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
    // Stop spinner after 2s regardless (server response comes via WS update)
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
