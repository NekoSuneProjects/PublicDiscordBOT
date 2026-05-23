const { EventEmitter } = require('node:events');
const path = require('node:path');
const fs = require('fs-extra');

const LEVELS = {
  debug: 10,
  info: 20,
  warning: 30,
  warn: 30,
  error: 40
};

class Logger extends EventEmitter {
  constructor(config = {}) {
    super();
    this.level = config.level || 'info';
    this.console = config.console !== false;
    this.file = config.file === true;
    this.filePath = path.resolve(config.filePath || 'logs/bot.log');
    this.maxMemoryEntries = config.maxMemoryEntries || 500;
    this.entries = [];
    this.ready = this.file ? fs.ensureDir(path.dirname(this.filePath)) : Promise.resolve();
  }

  child(scope) {
    return {
      child: (nestedScope) => this.child(`${scope}:${nestedScope}`),
      debug: (message, meta) => this.debug(message, { scope, ...meta }),
      info: (message, meta) => this.info(message, { scope, ...meta }),
      warning: (message, meta) => this.warning(message, { scope, ...meta }),
      warn: (message, meta) => this.warning(message, { scope, ...meta }),
      error: (message, meta) => this.error(message, { scope, ...meta })
    };
  }

  shouldLog(level) {
    return LEVELS[level] >= LEVELS[this.level];
  }

  serializeError(error) {
    if (!error) return undefined;
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: error.stack
      };
    }
    return error;
  }

  async write(level, message, meta = {}) {
    const normalizedLevel = level === 'warn' ? 'warning' : level;
    if (!this.shouldLog(normalizedLevel)) return;

    const entry = {
      timestamp: new Date().toISOString(),
      level: normalizedLevel,
      message,
      meta: {
        ...meta,
        error: this.serializeError(meta.error)
      }
    };

    this.entries.push(entry);
    if (this.entries.length > this.maxMemoryEntries) {
      this.entries.splice(0, this.entries.length - this.maxMemoryEntries);
    }

    if (this.console) {
      const suffix = Object.keys(entry.meta).length ? ` ${JSON.stringify(entry.meta)}` : '';
      const line = `[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.message}${suffix}`;
      if (normalizedLevel === 'error') console.error(line);
      else if (normalizedLevel === 'warning') console.warn(line);
      else console.log(line);
    }

    if (this.file) {
      await this.ready;
      await fs.appendFile(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
    }

    this.emit('entry', entry);
  }

  debug(message, meta) {
    return this.write('debug', message, meta);
  }

  info(message, meta) {
    return this.write('info', message, meta);
  }

  warning(message, meta) {
    return this.write('warning', message, meta);
  }

  warn(message, meta) {
    return this.warning(message, meta);
  }

  error(message, meta) {
    return this.write('error', message, meta);
  }

  getRecent(limit = 100) {
    return this.entries.slice(-limit);
  }
}

module.exports = { Logger, LEVELS };
