require('dotenv').config({ quiet: true });

const { Client, GatewayIntentBits, Partials, ActivityType } = require('discord.js');
const { ConfigManager } = require('./core/configManager');
const { Logger } = require('./core/logger');
const { CommandManager } = require('./core/commandManager');
const { PluginManager } = require('./core/pluginManager');
const { DashboardServer } = require('./dashboard/server');
const { registerCoreCommands } = require('./core/coreCommands');

function resolveDiscordFlags(source, enumObject, label) {
  return (source || []).map((entry) => {
    if (typeof entry === 'number') return entry;
    if (enumObject[entry] !== undefined) return enumObject[entry];
    throw new Error(`Unknown Discord ${label}: ${entry}`);
  });
}

function activityType(type) {
  if (!type) return ActivityType.Watching;
  return ActivityType[type] ?? ActivityType.Watching;
}

async function main() {
  const rootDir = process.cwd();
  const configManager = new ConfigManager({ rootDir });
  await configManager.init();

  const logger = new Logger(configManager.getCore('logging', {}));
  logger.info('Starting ModularDiscordBot');

  const client = new Client({
    intents: resolveDiscordFlags(configManager.getCore('discord.intents', ['Guilds']), GatewayIntentBits, 'intent'),
    partials: resolveDiscordFlags(configManager.getCore('discord.partials', []), Partials, 'partial')
  });

  const commandManager = new CommandManager({ client, configManager, logger });
  const pluginManager = new PluginManager({ client, commandManager, configManager, logger, rootDir });

  let dashboard = null;
  let shuttingDown = false;

  async function shutdown(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Graceful shutdown started', { code });

    try {
      if (dashboard) await dashboard.stop();
      await pluginManager.shutdown();
      await configManager.close();
      client.destroy();
      logger.info('Graceful shutdown complete');
    } catch (error) {
      logger.error('Graceful shutdown encountered an error', { error });
      code = code || 1;
    } finally {
      process.exit(code);
    }
  }

  function requestRestart() {
    setTimeout(() => shutdown(42), 250);
  }

  registerCoreCommands({ commandManager, pluginManager, configManager, requestRestart });
  commandManager.attachClientListeners();

  client.once('ready', async () => {
    logger.info('Discord client ready', {
      user: client.user?.tag,
      guilds: client.guilds.cache.size
    });

    applyPresence(client, configManager, logger);

    if (configManager.getCore('commands.registerOnReady', false)) {
      await commandManager.syncSlashCommands();
    }
  });

  client.on('warn', (message) => logger.warning('Discord client warning', { message }));
  client.on('error', (error) => logger.error('Discord client error', { error }));
  client.on('shardError', (error, shardId) => logger.error('Discord shard error', { shardId, error }));
  client.on('shardReconnecting', (shardId) => logger.warning('Discord shard reconnecting', { shardId }));
  client.on('shardResume', (shardId, replayedEvents) => logger.info('Discord shard resumed', { shardId, replayedEvents }));

  configManager.on('coreChanged', () => {
    if (client.isReady()) applyPresence(client, configManager, logger);
  });

  configManager.on('error', (error) => logger.error('Configuration watcher error', { error }));

  await pluginManager.loadAll();

  if (configManager.getCore('dashboard.enabled', true)) {
    dashboard = new DashboardServer({ client, configManager, pluginManager, commandManager, logger, rootDir });
    await dashboard.start();
  }

  const token = process.env.DISCORD_TOKEN || configManager.getCore('discord.token');
  if (!token) {
    logger.warning('Discord token is not configured. Dashboard is running, but the bot is not connected.');
  } else {
    await client.login(token);
  }

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', { error });
    shutdown(1);
  });
  process.on('unhandledRejection', (error) => {
    logger.error('Unhandled promise rejection', { error });
  });
}

function applyPresence(client, configManager, logger) {
  const activity = configManager.getCore('bot.activity', {});
  if (!client.user || !activity.name) return;

  client.user.setPresence({
    status: activity.status || 'online',
    activities: [
      {
        name: activity.name,
        type: activityType(activity.type)
      }
    ]
  });
  logger.debug('Applied bot presence', { activity });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
