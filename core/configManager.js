const { EventEmitter } = require('node:events');
const path = require('node:path');
const fs = require('fs-extra');
const { applyEnvOverrides } = require('./envConfig');

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, override) {
  const output = Array.isArray(base) ? [...base] : { ...base };
  if (!isObject(override)) return output;

  for (const [key, value] of Object.entries(override)) {
    if (isObject(value) && isObject(output[key])) {
      output[key] = deepMerge(output[key], value);
    } else {
      output[key] = value;
    }
  }

  return output;
}

function getByPath(source, dottedPath, fallback) {
  if (!dottedPath) return source;
  return dottedPath.split('.').reduce((cursor, part) => {
    if (cursor && Object.prototype.hasOwnProperty.call(cursor, part)) return cursor[part];
    return undefined;
  }, source) ?? fallback;
}

function setByPath(source, dottedPath, value) {
  const parts = dottedPath.split('.');
  let cursor = source;
  for (const part of parts.slice(0, -1)) {
    if (!isObject(cursor[part])) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = value;
}

class ConfigManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.rootDir = options.rootDir || process.cwd();
    this.corePath = path.resolve(this.rootDir, options.corePath || 'config/core.json');
    this.pluginRegistryPath = path.resolve(this.rootDir, options.pluginRegistryPath || 'config/plugins.json');
    this.pluginConfigDirectory = path.resolve(this.rootDir, options.pluginConfigDirectory || 'config/plugins');
    this.core = {};
    this.fileCore = {};
    this.pluginRegistry = { plugins: {} };
    this.pluginConfigs = new Map();
    this.watcher = null;
  }

  async init() {
    await fs.ensureDir(path.dirname(this.corePath));
    await fs.ensureDir(this.pluginConfigDirectory);
    await this.reloadCore();
    await this.reloadPluginRegistry();
    await this.watch();
  }

  async readJson(filePath, fallback) {
    try {
      return await fs.readJson(filePath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        await fs.ensureDir(path.dirname(filePath));
        await fs.writeJson(filePath, fallback, { spaces: 2 });
        return fallback;
      }
      throw error;
    }
  }

  async writeJson(filePath, data) {
    await fs.ensureDir(path.dirname(filePath));
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeJson(tempPath, data, { spaces: 2 });
    await fs.move(tempPath, filePath, { overwrite: true });
  }

  async reloadCore() {
    this.fileCore = await this.readJson(this.corePath, {});
    this.core = applyEnvOverrides(this.fileCore);
    this.emit('coreChanged', this.core);
    return this.core;
  }

  async saveCore(nextCore) {
    this.fileCore = nextCore;
    await this.writeJson(this.corePath, nextCore);
    this.core = applyEnvOverrides(this.fileCore);
    this.emit('coreChanged', this.core);
  }

  getCore(pathExpression, fallback) {
    return getByPath(this.core, pathExpression, fallback);
  }

  async setCore(pathExpression, value) {
    const next = deepMerge({}, this.core);
    setByPath(next, pathExpression, value);
    await this.saveCore(next);
    return next;
  }

  async reloadPluginRegistry() {
    this.pluginRegistry = await this.readJson(this.pluginRegistryPath, { plugins: {} });
    if (!this.pluginRegistry.plugins) this.pluginRegistry.plugins = {};
    this.emit('pluginRegistryChanged', this.pluginRegistry);
    return this.pluginRegistry;
  }

  async savePluginRegistry(nextRegistry = this.pluginRegistry) {
    this.pluginRegistry = nextRegistry;
    if (!this.pluginRegistry.plugins) this.pluginRegistry.plugins = {};
    await this.writeJson(this.pluginRegistryPath, this.pluginRegistry);
    this.emit('pluginRegistryChanged', this.pluginRegistry);
  }

  getPluginRegistry() {
    return this.pluginRegistry;
  }

  getPluginState(pluginId) {
    return this.pluginRegistry.plugins[pluginId];
  }

  async setPluginState(pluginId, nextState) {
    this.pluginRegistry.plugins[pluginId] = {
      ...(this.pluginRegistry.plugins[pluginId] || {}),
      ...nextState
    };
    await this.savePluginRegistry();
    return this.pluginRegistry.plugins[pluginId];
  }

  pluginConfigPath(pluginId) {
    return path.join(this.pluginConfigDirectory, `${pluginId}.json`);
  }

  async ensurePluginConfig(pluginId, defaultConfig = {}) {
    const configPath = this.pluginConfigPath(pluginId);
    const existing = await this.readJson(configPath, defaultConfig);
    const merged = deepMerge(defaultConfig, existing);
    await this.writeJson(configPath, merged);
    this.pluginConfigs.set(pluginId, merged);
    return merged;
  }

  async reloadPluginConfig(pluginId) {
    const configPath = this.pluginConfigPath(pluginId);
    const config = await this.readJson(configPath, {});
    this.pluginConfigs.set(pluginId, config);
    this.emit('pluginConfigChanged', pluginId, config);
    return config;
  }

  getPluginConfig(pluginId, dottedPath, fallback) {
    const config = this.pluginConfigs.get(pluginId) || {};
    return getByPath(config, dottedPath, fallback);
  }

  async savePluginConfig(pluginId, nextConfig) {
    this.pluginConfigs.set(pluginId, nextConfig);
    await this.writeJson(this.pluginConfigPath(pluginId), nextConfig);
    this.emit('pluginConfigChanged', pluginId, nextConfig);
    return nextConfig;
  }

  async setPluginConfigValue(pluginId, dottedPath, value) {
    const nextConfig = deepMerge({}, this.pluginConfigs.get(pluginId) || {});
    setByPath(nextConfig, dottedPath, value);
    return this.savePluginConfig(pluginId, nextConfig);
  }

  async watch() {
    if (this.watcher) return;
    const chokidar = await import('chokidar');
    this.watcher = chokidar.watch([
      this.corePath,
      this.pluginRegistryPath,
      path.join(this.pluginConfigDirectory, '*.json')
    ], {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 250,
        pollInterval: 100
      }
    });

    const handleConfigFile = async (changedPath) => {
      try {
        const resolved = path.resolve(changedPath);
        if (resolved === this.corePath) {
          await this.reloadCore();
        } else if (resolved === this.pluginRegistryPath) {
          await this.reloadPluginRegistry();
        } else if (path.dirname(resolved) === this.pluginConfigDirectory) {
          await this.reloadPluginConfig(path.basename(resolved, '.json'));
        }
      } catch (error) {
        this.emit('error', error);
      }
    };

    this.watcher.on('change', handleConfigFile);
    this.watcher.on('add', handleConfigFile);
  }

  async close() {
    if (this.watcher) await this.watcher.close();
  }
}

module.exports = {
  ConfigManager,
  deepMerge,
  getByPath,
  setByPath
};
