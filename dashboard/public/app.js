const state = {
  plugins: [],
  commands: [],
  githubResults: [],
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

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  }[char]));
}

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

function isGithubBacked(plugin) {
  return plugin.sourceType === 'github' || Boolean(plugin.githubUrl);
}

function pluginBadge(plugin) {
  if (plugin.status === 'failed') return '<span class="badge error">failed</span>';
  if (plugin.updateAvailable) return '<span class="badge warn">update</span>';
  if (plugin.loaded) return '<span class="badge ok">loaded</span>';
  if (!plugin.enabled) return '<span class="badge warn">disabled</span>';
  return `<span class="badge">${escapeHtml(plugin.status || 'installed')}</span>`;
}

function renderPlugins() {
  const overview = $('#overviewPlugins');
  const list = $('#pluginList');
  const select = $('#pluginConfigSelect');

  overview.innerHTML = '';
  list.innerHTML = '';
  select.innerHTML = '';

  for (const plugin of state.plugins) {
    const versionText = plugin.latestVersion && plugin.latestVersion !== plugin.version
      ? `${escapeHtml(plugin.version || '?')} -> ${escapeHtml(plugin.latestVersion)}`
      : escapeHtml(plugin.version || '?');
    const sourceLink = plugin.githubUrl
      ? `<a href="${escapeHtml(plugin.githubUrl)}" target="_blank" rel="noreferrer">${escapeHtml(plugin.sourceRepository || plugin.githubUrl)}</a>`
      : escapeHtml(plugin.source || 'local');
    const authorText = plugin.author ? `Author: ${escapeHtml(plugin.author)}` : 'Author: unknown';
    const updateText = plugin.latestCheckedAt
      ? `Update: ${plugin.updateAvailable ? 'available' : 'current'} (${escapeHtml(plugin.updateReason || 'checked')})`
      : 'Update: not checked';

    const compact = document.createElement('div');
    compact.className = 'plugin-row';
    compact.innerHTML = `
      <div>
        <div class="plugin-title"><strong>${escapeHtml(plugin.id)}</strong>${pluginBadge(plugin)}</div>
        <div class="plugin-meta">v${versionText} - ${escapeHtml(plugin.description || '')}</div>
      </div>
    `;
    overview.appendChild(compact);

    const row = document.createElement('div');
    row.className = 'plugin-row';
    row.innerHTML = `
      <div>
        <div class="plugin-title"><strong>${escapeHtml(plugin.name || plugin.id)}</strong><span class="badge">${escapeHtml(plugin.id)}</span>${pluginBadge(plugin)}</div>
        <div class="plugin-meta">v${versionText} - ${escapeHtml(plugin.description || '')}</div>
        <div class="plugin-meta">${authorText}</div>
        <div class="plugin-meta">Source: ${sourceLink}</div>
        <div class="plugin-meta">${updateText}</div>
        ${plugin.lastError ? `<div class="plugin-meta level-error">${escapeHtml(plugin.lastError)}</div>` : ''}
      </div>
      <div class="plugin-actions">
        <button class="button" data-action="${plugin.enabled ? 'disable' : 'enable'}" data-id="${escapeHtml(plugin.id)}">${plugin.enabled ? 'Disable' : 'Enable'}</button>
        <button class="button" data-action="reload" data-id="${escapeHtml(plugin.id)}">Reload</button>
        <button class="button" data-action="check-update" data-id="${escapeHtml(plugin.id)}" ${isGithubBacked(plugin) ? '' : 'disabled'}>Check</button>
        <button class="button ${plugin.updateAvailable ? 'primary' : ''}" data-action="update" data-id="${escapeHtml(plugin.id)}" ${isGithubBacked(plugin) ? '' : 'disabled'}>Update</button>
        <button class="button" data-config="${escapeHtml(plugin.id)}">Config</button>
        <button class="button danger" data-action="uninstall" data-id="${escapeHtml(plugin.id)}">Uninstall</button>
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
        <div class="plugin-title"><strong>${escapeHtml(command.name)}</strong><span class="badge">${escapeHtml(command.pluginId)}</span></div>
        <div class="plugin-meta">${escapeHtml(command.description || '')}</div>
      </div>
      <div class="plugin-meta">${command.slash ? '/' : ''}${command.prefix ? ' prefix' : ''}</div>
    `;
    list.appendChild(row);
  }
}

function renderGithubResults() {
  const list = $('#githubResults');
  const select = $('#githubResultSelect');
  list.innerHTML = '';
  select.innerHTML = '';

  if (!state.githubResults.length) {
    const empty = document.createElement('div');
    empty.className = 'plugin-meta';
    empty.textContent = 'No plugin repositories found yet.';
    list.appendChild(empty);

    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No repositories found';
    select.appendChild(option);
    return;
  }

  for (const repository of state.githubResults) {
    const packageLines = (repository.pluginPackages && repository.pluginPackages.length > 1)
      ? `<div class="plugin-meta">Packages: ${repository.pluginPackages.map((pkg) => `${escapeHtml(pkg.pluginId)} (${escapeHtml(pkg.packagePath)})`).join(', ')}</div>`
      : '';

    const option = document.createElement('option');
    option.value = repository.cloneUrl;
    option.disabled = repository.installed === true || repository.packageReadable === false;
    option.textContent = `${repository.pluginName || repository.fullName} ${repository.pluginVersion ? `v${repository.pluginVersion}` : ''}`;
    select.appendChild(option);

    const row = document.createElement('div');
    row.className = 'plugin-row';
    const topics = (repository.topics || []).slice(0, 6)
      .map((topic) => `<span class="badge">${escapeHtml(topic)}</span>`)
      .join('');
    row.innerHTML = `
      <div>
        <div class="plugin-title">
          <a class="repo-link" href="${escapeHtml(repository.htmlUrl)}" target="_blank" rel="noreferrer">${escapeHtml(repository.pluginName || repository.fullName)}</a>
          ${repository.pluginVersion ? `<span class="badge">v${escapeHtml(repository.pluginVersion)}</span>` : ''}
          ${repository.installed ? '<span class="badge ok">installed</span>' : ''}
          ${repository.packageReadable === false ? '<span class="badge error">invalid</span>' : ''}
        </div>
        <div class="plugin-meta">${escapeHtml(repository.pluginDescription || repository.description || 'No description')}</div>
        <div class="plugin-meta">Author: ${escapeHtml(repository.author || repository.owner || 'unknown')}</div>
        <div class="plugin-meta">${escapeHtml(repository.fullName)} - ${escapeHtml(repository.language || 'Unknown')} - ${repository.stars} stars - ${repository.forks} forks</div>
        ${repository.packageError ? `<div class="plugin-meta level-error">${escapeHtml(repository.packageError)}</div>` : ''}
        ${packageLines}
        <div class="plugin-title">${topics}</div>
      </div>
      <div class="plugin-actions">
        ${(repository.pluginPackages && repository.pluginPackages.length > 1)
          ? repository.pluginPackages.map((pkg) => `<button class="button primary" data-install-github="${escapeHtml(repository.cloneUrl)}" data-package-path="${escapeHtml(pkg.packagePath)}" ${pkg.installed || repository.packageReadable === false ? 'disabled' : ''}>Install ${escapeHtml(pkg.pluginId)}</button>`).join('')
          : `<button class="button primary" data-install-github="${escapeHtml(repository.cloneUrl)}" data-package-path="${escapeHtml(repository.packagePath || 'package.json')}" ${repository.installed || repository.packageReadable === false ? 'disabled' : ''}>Install</button>`}
      </div>
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
    <small>${escapeHtml(entry.timestamp)}</small>
    <strong class="level-${escapeHtml(entry.level)}">${escapeHtml(entry.level)}</strong>
    <span>${entry.meta?.scope ? `[${escapeHtml(entry.meta.scope)}] ` : ''}${escapeHtml(entry.message)}</span>
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

async function searchGithubPlugins() {
  const params = new URLSearchParams({
    topic: $('#githubTopic').value.trim() || 'nekosunebot-package',
    query: $('#githubSearch').value.trim(),
    sort: $('#githubSort').value,
    limit: '12'
  });
  const { repositories } = await api(`/api/plugins/discover/github?${params.toString()}`);
  state.githubResults = repositories;
  renderGithubResults();
}

async function installGithubSource(source) {
  if (!source) throw new Error('Select a GitHub plugin first.');
  await api('/api/plugins/install', {
    method: 'POST',
    body: JSON.stringify({ source })
  });
  await Promise.all([loadPlugins(), searchGithubPlugins()]);
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

  $('#githubSearchForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    await searchGithubPlugins();
    toast('GitHub search complete');
  });

  $('#githubResults').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-install-github]');
    if (!button) return;

    await installGithubSource(button.dataset.installGithub, button.dataset.packagePath || 'package.json');
    toast('GitHub plugin installed');
  });

  $('#installSelectedGithubPlugin').addEventListener('click', async () => {
    const selectedRepo = state.githubResults.find((r) => r.cloneUrl === $('#githubResultSelect').value);
    const selectedPackagePath = selectedRepo?.packagePath || selectedRepo?.pluginPackages?.[0]?.packagePath || 'package.json';
    await installGithubSource($('#githubResultSelect').value, selectedPackagePath);
    toast('Selected GitHub plugin installed');
  });

  $('#checkPluginUpdates').addEventListener('click', async () => {
    await api('/api/plugins/check-updates', {
      method: 'POST',
      body: '{}'
    });
    await loadPlugins();
    toast('Plugin update check complete');
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
    if (action === 'update' && !confirm(`Update ${id} from GitHub?`)) return;

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
    await searchGithubPlugins();
    await connectLogs();
    if (state.plugins[0]) await loadPluginConfig(state.plugins[0].id);
  } catch (error) {
    toast(error.message);
  }
});
