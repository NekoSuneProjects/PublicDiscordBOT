const path = require('node:path');
const fs = require('fs-extra');
const { installPluginDependencies } = require('../utils/dependencyInstaller');
const {
  getPluginManifest,
  validatePluginDirectory,
  installPluginFromSource
} = require('../utils/pluginInstaller');
const {
  getGithubRemotePluginInfo,
  parseGithubRepositoryUrl
} = require('../utils/githubDiscovery');

function startsWithPath(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function parseVersion(version) {
  return String(version || '0.0.0')
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => {
      const value = Number.parseInt(part, 10);
      return Number.isFinite(value) ? value : 0;
    });
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] > b[index]) return 1;
    if (a[index] < b[index]) return -1;
  }
  return 0;
}

function isNewerDate(left, right) {
  if (!left || !right) return Boolean(left && !right);
  return new Date(left).getTime() > new Date(right).getTime();
}

function remoteRegistryFields(remote) {
  if (!remote) return {};
  return {
    latestVersion: remote.manifest.version,
    latestPushedAt: remote.repository.pushedAt,
    latestPackagePath: remote.packagePath,
    sourceRepository: remote.repository.fullName,
    githubUrl: remote.manifest.githubUrl || remote.repository.htmlUrl,
    homepage: remote.manifest.homepage,
    repository: remote.manifest.repository || remote.repository.htmlUrl,
    author: remote.manifest.author || remote.repository.owner,
    remoteDescription: remote.manifest.description || remote.repository.description
  };
}

class PluginManager {
  constructor({ client, commandManager, configManager, logger, rootDir = process.cwd() }) {
    this.client = client;
    this.commandManager = commandManager;
    this.configManager = configManager;
    this.logger = logger.child('plugins');
    this.rootDir = rootDir;
    this.loaded = new Map();
    this.discovered = new Map();

    this.configManager.on('pluginConfigChanged', (pluginId, nextConfig) => {
      const record = this.loaded.get(pluginId);
      if (record?.module?.onConfigChanged) {
        this.safeInvoke(pluginId, 'onConfigChanged', record.module.onConfigChanged, nextConfig);
      }
    });
  }

  pluginsDirectory() {
    return path.resolve(this.rootDir, this.configManager.getCore('plugins.directory', 'plugins'));
  }

  pluginDataDirectory(pluginId) {
    return path.resolve(this.rootDir, this.configManager.getCore('plugins.dataDirectory', 'data/plugins'), pluginId);
  }

  async discoverPlugins() {
    const pluginsDirectory = this.pluginsDirectory();
    await fs.ensureDir(pluginsDirectory);
    const entries = await fs.readdir(pluginsDirectory);
    this.discovered.clear();

    for (const entry of entries) {
      const pluginPath = path.join(pluginsDirectory, entry);
      const stats = await fs.stat(pluginPath);
      if (!stats.isDirectory()) continue;
      if (!(await fs.pathExists(path.join(pluginPath, 'package.json')))) continue;

      try {
        const { manifest } = await validatePluginDirectory(pluginPath);
        this.discovered.set(manifest.id, { manifest, path: pluginPath });
        await this.ensureRegistryEntry(manifest, pluginPath);
      } catch (error) {
        this.logger.error('Plugin discovery failed', { pluginPath, error });
      }
    }

    return this.discovered;
  }

  async ensureRegistryEntry(manifest, pluginPath) {
    const current = this.configManager.getPluginState(manifest.id);
    if (current) {
      await this.configManager.setPluginState(manifest.id, {
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        author: manifest.author || current.author,
        homepage: manifest.homepage || current.homepage,
        repository: manifest.repository || current.repository,
        githubUrl: manifest.githubUrl || current.githubUrl,
        path: path.relative(this.rootDir, pluginPath),
        requiresRestart: manifest.requiresRestart
      });
      return;
    }

    await this.configManager.setPluginState(manifest.id, {
      enabled: manifest.defaultEnabled,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
      homepage: manifest.homepage,
      repository: manifest.repository,
      githubUrl: manifest.githubUrl,
      source: 'local',
      path: path.relative(this.rootDir, pluginPath),
      installedAt: new Date().toISOString(),
      requiresRestart: manifest.requiresRestart
    });
  }

  async loadAll() {
    await this.discoverPlugins();
    const registry = this.configManager.getPluginRegistry();
    const results = [];

    for (const pluginId of this.discovered.keys()) {
      const state = registry.plugins[pluginId];
      if (state?.enabled !== false) {
        results.push(await this.loadPlugin(pluginId));
      }
    }

    return results;
  }

  clearRequireCache(pluginPath) {
    const root = path.resolve(pluginPath);
    for (const cacheKey of Object.keys(require.cache)) {
      if (startsWithPath(path.resolve(cacheKey), root)) {
        delete require.cache[cacheKey];
      }
    }
  }

  async readDefaultConfig(pluginPath, pluginModule) {
    const configPath = path.join(pluginPath, 'config.json');
    const fileConfig = (await fs.pathExists(configPath)) ? await fs.readJson(configPath) : {};
    return {
      ...fileConfig,
      ...(pluginModule.defaultConfig || {})
    };
  }

  createTrackedClient(pluginId, manifest, eventListeners) {
    const removeTrackedListener = (eventName, original) => {
      const index = eventListeners.findIndex((entry) => entry.eventName === eventName && entry.original === original);
      if (index === -1) return false;
      const [entry] = eventListeners.splice(index, 1);
      this.client.removeListener(entry.eventName, entry.listener);
      return true;
    };

    const registerTrackedListener = (method, eventName, original) => {
      if (typeof original !== 'function') {
        throw new Error(`Plugin listener for "${eventName}" must be a function.`);
      }

      const permission = `discord.events.${eventName}`;
      if (!this.hasPermission(manifest, permission)) {
        this.logger.warning('Plugin client listener skipped due to missing permission', {
          pluginId,
          eventName
        });
        return proxy;
      }

      const listener = (...args) => this.safeInvoke(pluginId, `client.${method}:${eventName}`, original.bind(this.client), ...args);
      const once = method === 'once' || method === 'prependOnceListener';
      if (once) this.client.once(eventName, listener);
      else if (method === 'prependListener') this.client.prependListener(eventName, listener);
      else this.client.on(eventName, listener);

      eventListeners.push({ eventName, listener, original, method });

      if ((eventName === 'ready' || eventName === 'clientReady') && this.client.isReady()) {
        setImmediate(() => listener(this.client));
      }

      return proxy;
    };

    const proxy = new Proxy(this.client, {
      get: (target, property) => {
        if (['on', 'addListener', 'once', 'prependListener', 'prependOnceListener'].includes(property)) {
          return (eventName, listener) => registerTrackedListener(property, eventName, listener);
        }

        if (['off', 'removeListener'].includes(property)) {
          return (eventName, listener) => {
            removeTrackedListener(eventName, listener);
            return proxy;
          };
        }

        if (property === 'removeAllListeners') {
          return (eventName) => {
            const matches = eventListeners.filter((entry) => !eventName || entry.eventName === eventName);
            for (const entry of matches) {
              removeTrackedListener(entry.eventName, entry.original);
            }
            return proxy;
          };
        }

        const value = target[property];
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });

    return {
      client: proxy,
      on: (eventName, listener) => registerTrackedListener('on', eventName, listener),
      once: (eventName, listener) => registerTrackedListener('once', eventName, listener),
      off: (eventName, listener) => {
        removeTrackedListener(eventName, listener);
        return proxy;
      }
    };
  }

  createPluginContext(pluginId, manifest, pluginPath, config, eventListeners = []) {
    const logger = this.logger.child(pluginId);
    const trackedClient = this.createTrackedClient(pluginId, manifest, eventListeners);
    return {
      pluginId,
      manifest,
      client: trackedClient.client,
      rawClient: this.client,
      events: {
        on: trackedClient.on,
        once: trackedClient.once,
        off: trackedClient.off
      },
      logger,
      config,
      getConfig: (pathExpression, fallback) => this.configManager.getPluginConfig(pluginId, pathExpression, fallback),
      setConfig: (pathExpression, value) => this.configManager.setPluginConfigValue(pluginId, pathExpression, value),
      saveConfig: (nextConfig) => this.configManager.savePluginConfig(pluginId, nextConfig),
      coreConfig: this.configManager.core,
      configManager: this.configManager,
      commandManager: this.commandManager,
      storagePath: this.pluginDataDirectory(pluginId),
      paths: {
        root: pluginPath,
        data: this.pluginDataDirectory(pluginId)
      }
    };
  }

  hasPermission(manifest, permission) {
    if (!this.configManager.getCore('security.enforcePluginPermissions', true)) return true;
    const permissions = manifest.permissions || [];
    if (permissions.includes('*')) return true;
    if (permissions.includes(permission)) return true;

    if (permission.startsWith('discord.events.')) {
      return permissions.includes('discord.events.*');
    }

    return false;
  }

  async safeInvoke(pluginId, hookName, fn, ...args) {
    try {
      return await fn(...args);
    } catch (error) {
      this.logger.error('Plugin hook failed', { pluginId, hookName, error });
      return undefined;
    }
  }

  async loadPlugin(pluginId) {
    if (this.loaded.has(pluginId)) return this.loaded.get(pluginId);
    if (!this.discovered.has(pluginId)) await this.discoverPlugins();

    const discovered = this.discovered.get(pluginId);
    if (!discovered) throw new Error(`Plugin "${pluginId}" is not installed.`);

    const pluginPath = discovered.path;
    const { manifest, entryPath } = await validatePluginDirectory(pluginPath);
    await this.configManager.setPluginState(pluginId, {
      status: 'loading',
      lastError: null,
      loadedAt: null
    });

    try {
      if (this.configManager.getCore('plugins.installDependencies', true)) {
        await installPluginDependencies(
          pluginPath,
          this.configManager.getCore('plugins.dependencyInstall', {}),
          this.logger.child(pluginId)
        );
      }

      this.clearRequireCache(pluginPath);
      const required = require(entryPath);
      const exported = required?.default || required;
      const provisionalConfig = await this.readDefaultConfig(pluginPath, exported);
      const config = await this.configManager.ensurePluginConfig(pluginId, provisionalConfig);
      await fs.ensureDir(this.pluginDataDirectory(pluginId));

      const eventListeners = [];
      const baseContext = this.createPluginContext(pluginId, manifest, pluginPath, config, eventListeners);
      const pluginModule = typeof exported === 'function' ? await exported(baseContext) : exported;
      const defaultConfig = await this.readDefaultConfig(pluginPath, pluginModule || {});
      const finalConfig = await this.configManager.ensurePluginConfig(pluginId, defaultConfig);
      const context = this.createPluginContext(pluginId, manifest, pluginPath, finalConfig, eventListeners);

      const record = {
        id: pluginId,
        manifest,
        path: pluginPath,
        module: pluginModule,
        context,
        eventListeners,
        status: 'loaded',
        loadedAt: new Date().toISOString()
      };

      this.loaded.set(pluginId, record);

      if (pluginModule?.load) {
        await this.safeInvoke(pluginId, 'load', pluginModule.load.bind(pluginModule), context);
      }

      if (pluginModule?.commands?.length) {
        if (!this.hasPermission(manifest, 'discord.commands')) {
          this.logger.warning('Plugin commands skipped due to missing permission', { pluginId });
        } else {
          this.commandManager.registerPluginCommands(pluginId, pluginModule.commands);
        }
      }

      if (pluginModule?.events?.length) {
        this.attachPluginEvents(record, pluginModule.events);
      }

      await this.configManager.setPluginState(pluginId, {
        enabled: true,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        author: manifest.author,
        homepage: manifest.homepage,
        repository: manifest.repository,
        githubUrl: manifest.githubUrl,
        status: 'loaded',
        lastError: null,
        loadedAt: record.loadedAt,
        requiresRestart: manifest.requiresRestart
      });
      this.logger.info('Plugin loaded', { pluginId, version: manifest.version });
      return record;
    } catch (error) {
      this.loaded.delete(pluginId);
      this.commandManager.unregisterPluginCommands(pluginId);
      await this.configManager.setPluginState(pluginId, {
        status: 'failed',
        lastError: error.message,
        failedAt: new Date().toISOString()
      });
      this.logger.error('Plugin load failed', { pluginId, error });
      return null;
    }
  }

  attachPluginEvents(record, events) {
    for (const eventDefinition of events) {
      const eventName = eventDefinition.name;
      if (!eventName || typeof eventDefinition.execute !== 'function') continue;

      const permission = `discord.events.${eventName}`;
      if (!this.hasPermission(record.manifest, permission)) {
        this.logger.warning('Plugin event skipped due to missing permission', {
          pluginId: record.id,
          eventName
        });
        continue;
      }

      const listener = (...args) => this.safeInvoke(
        record.id,
        `event:${eventName}`,
        eventDefinition.execute.bind(record.module),
        record.context,
        ...args
      );

      if (eventDefinition.once) this.client.once(eventName, listener);
      else this.client.on(eventName, listener);
      record.eventListeners.push({ eventName, listener, method: eventDefinition.once ? 'once' : 'on' });

      if ((eventName === 'ready' || eventName === 'clientReady') && this.client.isReady()) {
        setImmediate(() => listener(this.client));
      }
    }
  }

  async unloadPlugin(pluginId) {
    const record = this.loaded.get(pluginId);
    if (!record) return false;

    for (const { eventName, listener } of record.eventListeners) {
      this.client.removeListener(eventName, listener);
    }

    this.commandManager.unregisterPluginCommands(pluginId);

    if (record.module?.unload) {
      await this.safeInvoke(pluginId, 'unload', record.module.unload.bind(record.module), record.context);
    }

    this.loaded.delete(pluginId);
    this.clearRequireCache(record.path);
    await this.configManager.setPluginState(pluginId, {
      status: 'unloaded',
      unloadedAt: new Date().toISOString()
    });
    this.logger.info('Plugin unloaded', { pluginId });
    return true;
  }

  async enablePlugin(pluginId) {
    await this.configManager.setPluginState(pluginId, { enabled: true });
    return this.loadPlugin(pluginId);
  }

  async disablePlugin(pluginId) {
    await this.unloadPlugin(pluginId);
    await this.configManager.setPluginState(pluginId, { enabled: false, status: 'disabled' });
    return true;
  }

  async reloadPlugin(pluginId) {
    await this.unloadPlugin(pluginId);
    const state = this.configManager.getPluginState(pluginId);
    if (state?.enabled === false) return null;
    return this.loadPlugin(pluginId);
  }

  async uninstallPlugin(pluginId, options = {}) {
    await this.disablePlugin(pluginId);

    const discovered = this.discovered.get(pluginId);
    if (discovered?.path) {
      await fs.remove(discovered.path);
    }

    if (!options.keepConfig) {
      await fs.remove(this.configManager.pluginConfigPath(pluginId));
      await fs.remove(this.pluginDataDirectory(pluginId));
    }

    const registry = this.configManager.getPluginRegistry();
    delete registry.plugins[pluginId];
    await this.configManager.savePluginRegistry(registry);
    this.discovered.delete(pluginId);
    this.logger.info('Plugin uninstalled', { pluginId, keepConfig: options.keepConfig === true });
    return true;
  }

  async installFromSource(source, options = {}) {
    const securityConfig = this.configManager.getCore('security', {});
    const result = await installPluginFromSource(source, {
      packagePath: options.packagePath || null,
      pluginsDirectory: this.pluginsDirectory(),
      allowedHosts: securityConfig.allowedPluginHosts || [],
      allowRemoteInstall: securityConfig.allowRemotePluginInstall !== false,
      allowUntrusted: securityConfig.allowUntrustedPluginInstall === true,
      maxArchiveBytes: securityConfig.maxPluginArchiveBytes || 50 * 1024 * 1024,
      logger: this.logger
    });

    const packagePath = options.packagePath || 'package.json';
    const remote = parseGithubRepositoryUrl(source)
      ? await getGithubRemotePluginInfo(source, packagePath).catch((error) => {
        this.logger.warning('Unable to read GitHub plugin metadata after install', { source, error });
        return null;
      })
      : null;

    await this.discoverPlugins();
    await this.configManager.setPluginState(result.manifest.id, {
      enabled: result.manifest.defaultEnabled,
      source,
      name: result.manifest.name,
      version: result.manifest.version,
      description: result.manifest.description,
      author: result.manifest.author || remote?.manifest.author,
      homepage: result.manifest.homepage || remote?.manifest.homepage,
      repository: result.manifest.repository || remote?.manifest.repository,
      githubUrl: result.manifest.githubUrl || remote?.manifest.githubUrl,
      sourceType: remote ? 'github' : 'remote',
      packagePath,
      sourcePushedAt: remote?.repository.pushedAt,
      updateAvailable: false,
      latestCheckedAt: remote ? new Date().toISOString() : undefined,
      ...remoteRegistryFields(remote),
      installedAt: new Date().toISOString(),
      status: 'installed'
    });

    if (result.manifest.defaultEnabled) {
      await this.loadPlugin(result.manifest.id);
    }

    return result.manifest;
  }

  async checkPluginUpdate(pluginId) {
    if (!this.discovered.has(pluginId)) await this.discoverPlugins();
    const discovered = this.discovered.get(pluginId);
    const state = this.configManager.getPluginState(pluginId);
    if (!discovered || !state) throw new Error(`Plugin "${pluginId}" is not installed.`);

    const source = state.source;
    if (!source || source === 'local' || !parseGithubRepositoryUrl(source)) {
      const result = {
        id: pluginId,
        updateAvailable: false,
        updateReason: 'no-github-source',
        message: 'Plugin was not installed from a GitHub source.'
      };
      await this.configManager.setPluginState(pluginId, {
        latestCheckedAt: new Date().toISOString(),
        updateAvailable: false,
        updateReason: result.updateReason
      });
      return result;
    }

    const { manifest: localManifest } = await validatePluginDirectory(discovered.path);
    const remote = await getGithubRemotePluginInfo(source, state.packagePath || state.latestPackagePath || 'package.json');
    const remoteVersionNewer = compareVersions(remote.manifest.version, localManifest.version) > 0;
    const sourceChanged = isNewerDate(remote.repository.pushedAt, state.sourcePushedAt);
    const updateAvailable = remoteVersionNewer || sourceChanged;
    const updateReason = remoteVersionNewer ? 'version' : (sourceChanged ? 'source-pushed' : 'current');

    const updateState = {
      ...remoteRegistryFields(remote),
      latestCheckedAt: new Date().toISOString(),
      updateAvailable,
      updateReason
    };

    await this.configManager.setPluginState(pluginId, updateState);

    return {
      id: pluginId,
      currentVersion: localManifest.version,
      latestVersion: remote.manifest.version,
      currentPushedAt: state.sourcePushedAt,
      latestPushedAt: remote.repository.pushedAt,
      updateAvailable,
      updateReason,
      repository: remote.repository,
      manifest: remote.manifest
    };
  }

  async checkAllPluginUpdates() {
    const results = [];
    await this.discoverPlugins();
    for (const plugin of this.listPlugins()) {
      if (!plugin.source || plugin.source === 'local' || !parseGithubRepositoryUrl(plugin.source)) continue;
      try {
        results.push(await this.checkPluginUpdate(plugin.id));
      } catch (error) {
        this.logger.error('Plugin update check failed', { pluginId: plugin.id, error });
        results.push({
          id: plugin.id,
          updateAvailable: false,
          updateReason: 'error',
          error: error.message
        });
      }
    }
    return results;
  }

  async updatePlugin(pluginId) {
    if (!this.discovered.has(pluginId)) await this.discoverPlugins();
    const discovered = this.discovered.get(pluginId);
    const state = this.configManager.getPluginState(pluginId);
    if (!discovered || !state) throw new Error(`Plugin "${pluginId}" is not installed.`);

    const source = state.source;
    if (!source || source === 'local' || !parseGithubRepositoryUrl(source)) {
      throw new Error(`Plugin "${pluginId}" was not installed from a GitHub source and cannot be updated automatically.`);
    }

    const wasEnabled = state.enabled !== false;
    const previousVersion = state.version;
    await this.unloadPlugin(pluginId);

    const securityConfig = this.configManager.getCore('security', {});
    const packagePath = state.packagePath || state.latestPackagePath || 'package.json';
    const result = await installPluginFromSource(source, {
      packagePath,
      pluginsDirectory: this.pluginsDirectory(),
      allowedHosts: securityConfig.allowedPluginHosts || [],
      allowRemoteInstall: securityConfig.allowRemotePluginInstall !== false,
      allowUntrusted: securityConfig.allowUntrustedPluginInstall === true,
      maxArchiveBytes: securityConfig.maxPluginArchiveBytes || 50 * 1024 * 1024,
      overwrite: true,
      expectedPluginId: pluginId,
      logger: this.logger
    });
    const remote = await getGithubRemotePluginInfo(source, packagePath).catch((error) => {
      this.logger.warning('Unable to read GitHub plugin metadata after update', { pluginId, source, error });
      return null;
    });

    await this.discoverPlugins();
    await this.configManager.setPluginState(pluginId, {
      enabled: wasEnabled,
      source,
      sourceType: 'github',
      packagePath,
      name: result.manifest.name,
      version: result.manifest.version,
      previousVersion,
      description: result.manifest.description,
      author: result.manifest.author || remote?.manifest.author,
      homepage: result.manifest.homepage || remote?.manifest.homepage,
      repository: result.manifest.repository || remote?.manifest.repository,
      githubUrl: result.manifest.githubUrl || remote?.manifest.githubUrl,
      sourcePushedAt: remote?.repository.pushedAt,
      updateAvailable: false,
      updateReason: 'updated',
      latestCheckedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: wasEnabled ? 'installed' : 'disabled',
      lastError: null,
      ...remoteRegistryFields(remote)
    });

    if (wasEnabled) await this.loadPlugin(pluginId);
    this.logger.info('Plugin updated', { pluginId, previousVersion, version: result.manifest.version });
    return this.listPlugins().find((plugin) => plugin.id === pluginId);
  }

  async getDashboardComponent(pluginId) {
    const record = this.loaded.get(pluginId);
    if (!record?.module?.dashboard) return null;

    const dashboard = record.module.dashboard;
    if (typeof dashboard.getComponent === 'function') {
      return this.safeInvoke(pluginId, 'dashboard.getComponent', dashboard.getComponent, record.context);
    }

    return {
      html: dashboard.html || '',
      scripts: dashboard.scripts || []
    };
  }

  listPlugins() {
    const registry = this.configManager.getPluginRegistry();
    const ids = new Set([
      ...Object.keys(registry.plugins || {}),
      ...this.discovered.keys()
    ]);

    return Array.from(ids).sort().map((pluginId) => {
      const state = registry.plugins[pluginId] || {};
      const discovered = this.discovered.get(pluginId);
      const loaded = this.loaded.get(pluginId);
      const manifest = loaded?.manifest || discovered?.manifest || {};
      return {
        id: pluginId,
        name: manifest.name || state.name || pluginId,
        version: manifest.version || state.version,
        latestVersion: state.latestVersion,
        previousVersion: state.previousVersion,
        description: manifest.description || state.description,
        author: manifest.author || state.author,
        homepage: manifest.homepage || state.homepage,
        repository: manifest.repository || state.repository,
        githubUrl: manifest.githubUrl || state.githubUrl,
        enabled: state.enabled !== false,
        status: state.status || (loaded ? 'loaded' : 'installed'),
        loaded: Boolean(loaded),
        requiresRestart: Boolean(manifest.requiresRestart || state.requiresRestart),
        permissions: manifest.permissions || [],
        lastError: state.lastError,
        source: state.source,
        sourceType: state.sourceType,
        sourceRepository: state.sourceRepository,
        sourcePushedAt: state.sourcePushedAt,
        latestPushedAt: state.latestPushedAt,
        latestCheckedAt: state.latestCheckedAt,
        updateAvailable: state.updateAvailable === true,
        updateReason: state.updateReason,
        updatedAt: state.updatedAt,
        path: state.path || (discovered?.path ? path.relative(this.rootDir, discovered.path) : undefined)
      };
    });
  }

  async shutdown() {
    const ids = Array.from(this.loaded.keys());
    for (const pluginId of ids) {
      await this.unloadPlugin(pluginId);
    }
  }
}

module.exports = { PluginManager };
