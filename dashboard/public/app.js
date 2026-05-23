const state = {
  plugins: [],
  commands: [],
  logs: []
};

const viewTitles = {
  overview: 'Overview',
  plugins: 'Plugins',
  settings: 'Settings',
  commands: 'Commands',
  logs: 'Logs'
};

const $ = (selector) => document.querySelector(selector);

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('active');
  setTimeout(() => element.classList.remove('active'), 2600);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    ...options
  });

  if (response.status === 401) {
    window.location.href = '/';
    return null;
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request failed: ${response.status}`);
  }
  return data;
}

function formatDuration(ms) {
  if (!ms) return '-';
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

function pluginBadge(plugin) {
  if (plugin.status === 'failed') return '<span class="badge error">failed</span>';
  if (plugin.loaded) return '<span class="badge ok">loaded</span>';
  if (!plugin.enabled) return '<span class="badge warn">disabled</span>';
  return `<span class="badge">${plugin.status || 'installed'}</span>`;
}

function renderPlugins() {
  const overview = $('#overviewPlugins');
  const list = $('#pluginList');
  const select = $('#pluginConfigSelect');

  overview.innerHTML = '';
  list.innerHTML = '';
  select.innerHTML = '';

  for (const plugin of state.plugins) {
    const compact = document.createElement('div');
    compact.className = 'plugin-row';
    compact.innerHTML = `
      <div>
        <div class="plugin-title"><strong>${plugin.id}</strong>${pluginBadge(plugin)}</div>
        <div class="plugin-meta">${plugin.description || plugin.version || ''}</div>
      </div>
    `;
    overview.appendChild(compact);

    const row = document.createElement('div');
    row.className = 'plugin-row';
    row.innerHTML = `
      <div>
        <div class="plugin-title"><strong>${plugin.name || plugin.id}</strong><span class="badge">${plugin.id}</span>${pluginBadge(plugin)}</div>
        <div class="plugin-meta">${plugin.description || ''}</div>
        ${plugin.lastError ? `<div class="plugin-meta level-error">${plugin.lastError}</div>` : ''}
      </div>
      <div class="plugin-actions">
        <button class="button" data-action="${plugin.enabled ? 'disable' : 'enable'}" data-id="${plugin.id}">${plugin.enabled ? 'Disable' : 'Enable'}</button>
        <button class="button" data-action="reload" data-id="${plugin.id}">Reload</button>
        <button class="button" data-config="${plugin.id}">Config</button>
        <button class="button danger" data-action="uninstall" data-id="${plugin.id}">Uninstall</button>
      </div>
    `;
    list.appendChild(row);

    const option = document.createElement('option');
    option.value = plugin.id;
    option.textContent = plugin.id;
    select.appendChild(option);
  }
}

function renderCommands() {
  const list = $('#commandList');
  list.innerHTML = '';

  for (const command of state.commands) {
    const row = document.createElement('div');
    row.className = 'plugin-row';
    row.innerHTML = `
      <div>
        <div class="plugin-title"><strong>${command.name}</strong><span class="badge">${command.pluginId}</span></div>
        <div class="plugin-meta">${command.description || ''}</div>
      </div>
      <div class="plugin-meta">${command.slash ? '/' : ''}${command.prefix ? ' prefix' : ''}</div>
    `;
    list.appendChild(row);
  }
}

function appendLog(entry) {
  state.logs.push(entry);
  if (state.logs.length > 250) state.logs.shift();

  const stream = $('#logStream');
  const line = document.createElement('div');
  line.className = 'log-line';
  line.innerHTML = `
    <small>${entry.timestamp}</small>
    <strong class="level-${entry.level}">${entry.level}</strong>
    <span>${entry.meta?.scope ? `[${entry.meta.scope}] ` : ''}${entry.message}</span>
  `;
  stream.appendChild(line);
  stream.scrollTop = stream.scrollHeight;
}

function renderLogs(entries) {
  $('#logStream').innerHTML = '';
  state.logs = [];
  for (const entry of entries) appendLog(entry);
}

async function loadStatus() {
  const { user } = await api('/api/me');
  $('#userLabel').textContent = `${user.globalName || user.username} (${user.id})`;

  const { ready, guilds, uptimeMs, pingMs } = await api('/api/status');
  $('#botReady').textContent = ready ? 'Ready' : 'Offline';
  $('#connectionState').textContent = ready ? 'Connected' : 'Dashboard only';
  $('#guildCount').textContent = guilds;
  $('#ping').textContent = pingMs >= 0 ? `${pingMs}ms` : '-';
  $('#uptime').textContent = formatDuration(uptimeMs);
}

async function loadPlugins() {
  const { plugins } = await api('/api/plugins');
  state.plugins = plugins;
  renderPlugins();
}

async function loadCommands() {
  const { commands } = await api('/api/commands');
  state.commands = commands;
  renderCommands();
}

async function loadCoreSettings() {
  const { config } = await api('/api/settings/core');
  $('#coreSettingsEditor').value = JSON.stringify(config, null, 2);
}

async function loadPluginConfig(pluginId = $('#pluginConfigSelect').value) {
  if (!pluginId) return;
  const { config } = await api(`/api/plugins/${encodeURIComponent(pluginId)}/config`);
  $('#pluginConfigEditor').value = JSON.stringify(config, null, 2);

  const { component } = await api(`/api/plugins/${encodeURIComponent(pluginId)}/dashboard`);
  const container = $('#pluginComponent');
  container.innerHTML = '';
  if (component?.html) {
    const frame = document.createElement('iframe');
    frame.sandbox = 'allow-scripts';
    frame.srcdoc = component.html;
    container.appendChild(frame);
  }
}

async function refreshAll() {
  await Promise.all([
    loadStatus(),
    loadPlugins(),
    loadCommands(),
    loadCoreSettings()
  ]);
}

function bindTabs() {
  document.querySelectorAll('.tab').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((item) => item.classList.remove('active'));
      document.querySelectorAll('.view').forEach((item) => item.classList.remove('active'));
      button.classList.add('active');
      $(`#${button.dataset.view}`).classList.add('active');
      $('#viewTitle').textContent = viewTitles[button.dataset.view];
    });
  });
}

function bindActions() {
  $('#refreshButton').addEventListener('click', () => refreshAll().then(() => toast('Refreshed')).catch((error) => toast(error.message)));

  $('#logoutButton').addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST', body: '{}' });
    window.location.href = '/';
  });

  $('#installForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const source = $('#pluginSource').value.trim();
    await api('/api/plugins/install', {
      method: 'POST',
      body: JSON.stringify({ source })
    });
    $('#pluginSource').value = '';
    await loadPlugins();
    toast('Plugin installed');
  });

  $('#pluginList').addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button) return;

    if (button.dataset.config) {
      $('#pluginConfigSelect').value = button.dataset.config;
      await loadPluginConfig(button.dataset.config);
      return;
    }

    const action = button.dataset.action;
    const id = button.dataset.id;
    if (!action || !id) return;
    if (action === 'uninstall' && !confirm(`Uninstall ${id}?`)) return;

    await api(`/api/plugins/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
      body: JSON.stringify({})
    });
    await loadPlugins();
    toast(`Plugin ${action} complete`);
  });

  $('#loadPluginConfig').addEventListener('click', () => loadPluginConfig().catch((error) => toast(error.message)));

  $('#savePluginConfig').addEventListener('click', async () => {
    const pluginId = $('#pluginConfigSelect').value;
    const config = JSON.parse($('#pluginConfigEditor').value);
    await api(`/api/plugins/${encodeURIComponent(pluginId)}/config`, {
      method: 'PUT',
      body: JSON.stringify(config)
    });
    toast('Plugin config saved');
  });

  $('#saveCoreSettings').addEventListener('click', async () => {
    const config = JSON.parse($('#coreSettingsEditor').value);
    await api('/api/settings/core', {
      method: 'PUT',
      body: JSON.stringify(config)
    });
    toast('Core settings saved');
  });

  $('#commandTestForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const command = $('#commandInput').value.trim();
    const result = await api('/api/commands/test', {
      method: 'POST',
      body: JSON.stringify({ command })
    });
    $('#commandOutput').textContent = result.output.join('\n') || '(no output)';
  });

  $('#clearLogs').addEventListener('click', () => renderLogs([]));
}

async function connectLogs() {
  const { token } = await api('/api/logs/token', { method: 'POST', body: '{}' });
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${window.location.host}/ws/logs?token=${encodeURIComponent(token)}`);

  socket.addEventListener('message', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === 'snapshot') renderLogs(payload.entries);
    if (payload.type === 'entry') appendLog(payload.entry);
  });

  socket.addEventListener('close', () => {
    setTimeout(() => connectLogs().catch(() => {}), 2000);
  });
}

window.addEventListener('DOMContentLoaded', async () => {
  bindTabs();
  bindActions();
  try {
    await refreshAll();
    await connectLogs();
    if (state.plugins[0]) await loadPluginConfig(state.plugins[0].id);
  } catch (error) {
    toast(error.message);
  }
});
