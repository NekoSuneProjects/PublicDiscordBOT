const path = require('node:path');
const fs = require('fs-extra');
const { installPluginDependencies } = require('../utils/dependencyInstaller');
const {
  getPluginManifest,
  validatePluginDirectory,
  installPluginFromSource
} = require('../utils/pluginInstaller');

function startsWithPath(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
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
        path: path.relative(this.rootDir, pluginPath),
        requiresRestart: manifest.requiresRestart
      });
      return;
    }

    await this.configManager.setPluginState(manifest.id, {
      enabled: manifest.defaultEnabled,
      name: manifest.name,
      version: manifest.version,
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

  createPluginContext(pluginId, manifest, pluginPath, config) {
    const logger = this.logger.child(pluginId);
    return {
      pluginId,
      manifest,
      client: this.client,
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

      const baseContext = this.createPluginContext(pluginId, manifest, pluginPath, config);
      const pluginModule = typeof exported === 'function' ? await exported(baseContext) : exported;
      const defaultConfig = await this.readDefaultConfig(pluginPath, pluginModule || {});
      const finalConfig = await this.configManager.ensurePluginConfig(pluginId, defaultConfig);
      const context = this.createPluginContext(pluginId, manifest, pluginPath, finalConfig);

      const record = {
        id: pluginId,
        manifest,
        path: pluginPath,
        module: pluginModule,
        context,
        eventListeners: [],
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
      record.eventListeners.push({ eventName, listener });
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

  async installFromSource(source) {
    const securityConfig = this.configManager.getCore('security', {});
    const result = await installPluginFromSource(source, {
      pluginsDirectory: this.pluginsDirectory(),
      allowedHosts: securityConfig.allowedPluginHosts || [],
      allowRemoteInstall: securityConfig.allowRemotePluginInstall !== false,
      allowUntrusted: securityConfig.allowUntrustedPluginInstall === true,
      maxArchiveBytes: securityConfig.maxPluginArchiveBytes || 50 * 1024 * 1024,
      logger: this.logger
    });

    await this.discoverPlugins();
    await this.configManager.setPluginState(result.manifest.id, {
      enabled: result.manifest.defaultEnabled,
      source,
      installedAt: new Date().toISOString(),
      status: 'installed'
    });

    if (result.manifest.defaultEnabled) {
      await this.loadPlugin(result.manifest.id);
    }

    return result.manifest;
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
        description: manifest.description || state.description,
        enabled: state.enabled !== false,
        status: state.status || (loaded ? 'loaded' : 'installed'),
        loaded: Boolean(loaded),
        requiresRestart: Boolean(manifest.requiresRestart || state.requiresRestart),
        permissions: manifest.permissions || [],
        lastError: state.lastError,
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
