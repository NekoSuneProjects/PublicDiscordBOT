require('dotenv').config({ quiet: true });

const { Client, GatewayIntentBits } = require('discord.js');
const { ConfigManager } = require('../core/configManager');
const { Logger } = require('../core/logger');
const { CommandManager } = require('../core/commandManager');
const { PluginManager } = require('../core/pluginManager');
const { registerCoreCommands } = require('../core/coreCommands');

async function main() {
  const rootDir = process.cwd();
  const configManager = new ConfigManager({ rootDir });
  await configManager.init();
  const logger = new Logger(configManager.getCore('logging', {}));
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const commandManager = new CommandManager({ client, configManager, logger });
  const pluginManager = new PluginManager({ client, commandManager, configManager, logger, rootDir });

  registerCoreCommands({
    commandManager,
    pluginManager,
    configManager,
    requestRestart: () => {
      throw new Error('Restart is not available from the command registration script.');
    }
  });

  await pluginManager.loadAll();
  await commandManager.syncSlashCommands();
  await pluginManager.shutdown();
  await configManager.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
