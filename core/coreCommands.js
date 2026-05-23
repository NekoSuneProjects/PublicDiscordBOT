function parseConfigValue(raw) {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function registerCoreCommands({ commandManager, pluginManager, configManager, requestRestart }) {
  commandManager.registerCommand('core', {
    name: 'plugins',
    description: 'List installed plugins and their status.',
    aliases: ['plugin-list'],
    cooldownMs: 1000,
    async execute(ctx) {
      const plugins = pluginManager.listPlugins();
      if (!plugins.length) return ctx.reply('No plugins are installed.');

      const lines = plugins.map((plugin) => {
        const marker = plugin.loaded ? 'loaded' : plugin.status;
        return `${plugin.id} (${plugin.enabled ? 'enabled' : 'disabled'}, ${marker})`;
      });

      return ctx.reply(`Installed plugins:\n${lines.join('\n')}`);
    }
  });

  commandManager.registerCommand('core', {
    name: 'plugin',
    description: 'Manage a plugin.',
    ownerOnly: true,
    cooldownMs: 1000,
    options: [
      {
        name: 'action',
        description: 'Plugin action',
        type: 'string',
        required: true,
        choices: [
          { name: 'enable', value: 'enable' },
          { name: 'disable', value: 'disable' },
          { name: 'reload', value: 'reload' },
          { name: 'uninstall', value: 'uninstall' },
          { name: 'status', value: 'status' },
          { name: 'sync-commands', value: 'sync-commands' }
        ]
      },
      {
        name: 'id',
        description: 'Plugin id',
        type: 'string',
        required: false
      }
    ],
    async execute(ctx) {
      const action = ctx.options.action || ctx.args[0];
      const pluginId = ctx.options.id || ctx.args[1];

      if (!action) return ctx.reply('Usage: plugin <enable|disable|reload|uninstall|status|sync-commands> [plugin-id]');

      if (action === 'sync-commands') {
        await commandManager.syncSlashCommands();
        return ctx.reply('Slash command sync requested.');
      }

      if (!pluginId) return ctx.reply('Plugin id is required for this action.');

      if (action === 'enable') {
        await pluginManager.enablePlugin(pluginId);
        return ctx.reply(`Plugin "${pluginId}" enabled.`);
      }

      if (action === 'disable') {
        await pluginManager.disablePlugin(pluginId);
        return ctx.reply(`Plugin "${pluginId}" disabled.`);
      }

      if (action === 'reload') {
        await pluginManager.reloadPlugin(pluginId);
        return ctx.reply(`Plugin "${pluginId}" reloaded.`);
      }

      if (action === 'uninstall') {
        await pluginManager.uninstallPlugin(pluginId);
        return ctx.reply(`Plugin "${pluginId}" uninstalled.`);
      }

      if (action === 'status') {
        const plugin = pluginManager.listPlugins().find((item) => item.id === pluginId);
        if (!plugin) return ctx.reply(`Plugin "${pluginId}" is not installed.`);
        return ctx.reply(JSON.stringify(plugin, null, 2));
      }

      return ctx.reply(`Unknown plugin action "${action}".`);
    }
  });

  commandManager.registerCommand('core', {
    name: 'botsettings',
    description: 'Read or update core bot settings.',
    ownerOnly: true,
    cooldownMs: 1000,
    options: [
      {
        name: 'action',
        description: 'get or set',
        type: 'string',
        required: true,
        choices: [
          { name: 'get', value: 'get' },
          { name: 'set', value: 'set' }
        ]
      },
      {
        name: 'path',
        description: 'Dotted config path, such as bot.prefix',
        type: 'string',
        required: true
      },
      {
        name: 'value',
        description: 'JSON value for set',
        type: 'string',
        required: false
      }
    ],
    async execute(ctx) {
      const action = ctx.options.action || ctx.args[0];
      const configPath = ctx.options.path || ctx.args[1];
      const value = ctx.options.value ?? ctx.args.slice(2).join(' ');

      if (!action || !configPath) return ctx.reply('Usage: botsettings <get|set> <path> [json-value]');

      if (action === 'get') {
        return ctx.reply(JSON.stringify(configManager.getCore(configPath), null, 2));
      }

      if (action === 'set') {
        await configManager.setCore(configPath, parseConfigValue(value));
        return ctx.reply(`Updated core setting "${configPath}".`);
      }

      return ctx.reply(`Unknown settings action "${action}".`);
    }
  });

  commandManager.registerCommand('core', {
    name: 'botrestart',
    description: 'Gracefully restart the bot process when running under the watchdog.',
    ownerOnly: true,
    cooldownMs: 5000,
    async execute(ctx) {
      await ctx.reply('Restart requested. The process will exit with code 42.');
      requestRestart();
    }
  });
}

module.exports = { registerCoreCommands };
