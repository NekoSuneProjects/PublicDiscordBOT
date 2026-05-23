const {
  REST,
  Routes,
  PermissionFlagsBits,
  ApplicationCommandOptionType,
  MessageFlags
} = require('discord.js');

const OPTION_TYPE_MAP = {
  string: ApplicationCommandOptionType.String,
  integer: ApplicationCommandOptionType.Integer,
  boolean: ApplicationCommandOptionType.Boolean,
  user: ApplicationCommandOptionType.User,
  channel: ApplicationCommandOptionType.Channel,
  role: ApplicationCommandOptionType.Role,
  mentionable: ApplicationCommandOptionType.Mentionable,
  number: ApplicationCommandOptionType.Number,
  attachment: ApplicationCommandOptionType.Attachment
};

function parseArgs(input) {
  const args = [];
  const regex = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match;
  while ((match = regex.exec(input))) {
    args.push((match[1] || match[2] || match[3] || '').replace(/\\(["'])/g, '$1'));
  }
  return args;
}

function optionType(type) {
  if (typeof type === 'number') return type;
  return OPTION_TYPE_MAP[String(type || 'string').toLowerCase()] || ApplicationCommandOptionType.String;
}

function normalizeOption(option) {
  return {
    name: option.name,
    description: option.description || option.name,
    type: optionType(option.type),
    required: option.required === true,
    choices: option.choices,
    autocomplete: option.autocomplete === true
  };
}

function resolvePermission(permission) {
  if (typeof permission === 'bigint') return permission;
  return PermissionFlagsBits[permission] || BigInt(permission);
}

class CommandManager {
  constructor({ client, configManager, logger }) {
    this.client = client;
    this.configManager = configManager;
    this.logger = logger.child('commands');
    this.commands = new Map();
    this.aliases = new Map();
    this.cooldowns = new Map();
    this.listenersAttached = false;
    this.pendingSyncTimer = null;
    this.groupedSlashRoutes = new Map();
  }

  attachClientListeners() {
    if (this.listenersAttached) return;
    this.client.on('messageCreate', (message) => this.handleMessage(message));
    this.client.on('interactionCreate', (interaction) => this.handleInteraction(interaction));
    this.listenersAttached = true;
  }

  registerCommand(pluginId, command) {
    if (!command?.name || typeof command.execute !== 'function') {
      throw new Error(`Invalid command from ${pluginId}; commands require name and execute().`);
    }

    const normalized = {
      pluginId,
      aliases: [],
      cooldownMs: this.configManager.getCore('bot.defaultCooldownMs', 2500),
      slash: true,
      prefix: true,
      ...command
    };

    this.commands.set(normalized.name, normalized);
    for (const alias of normalized.aliases || []) {
      this.aliases.set(alias, normalized.name);
    }
  }

  registerPluginCommands(pluginId, commands = []) {
    for (const command of commands) {
      this.registerCommand(pluginId, command);
    }
    this.logger.info('Registered plugin commands', { pluginId, count: commands.length });
    this.scheduleSlashSync('plugin command registration');
  }

  unregisterPluginCommands(pluginId) {
    for (const [name, command] of this.commands.entries()) {
      if (command.pluginId === pluginId) {
        this.commands.delete(name);
      }
    }

    for (const [alias, commandName] of this.aliases.entries()) {
      if (!this.commands.has(commandName)) {
        this.aliases.delete(alias);
      }
    }

    this.scheduleSlashSync('plugin command unregistration');
  }

  listCommands() {
    return Array.from(this.commands.values()).map((command) => ({
      name: command.name,
      description: command.description,
      pluginId: command.pluginId,
      aliases: command.aliases || [],
      slash: command.slash !== false,
      prefix: command.prefix !== false
    }));
  }

  resolveCommand(name) {
    return this.commands.get(name) || this.commands.get(this.aliases.get(name));
  }

  commandMode() {
    return this.configManager.getCore('commands.mode', 'both');
  }

  scheduleSlashSync(reason = 'runtime change') {
    if (!this.configManager.getCore('commands.autoSyncSlash', true)) return;
    if (this.pendingSyncTimer) clearTimeout(this.pendingSyncTimer);
    this.pendingSyncTimer = setTimeout(async () => {
      this.pendingSyncTimer = null;
      try {
        await this.syncSlashCommands();
        this.logger.info('Auto slash sync completed', { reason });
      } catch (error) {
        this.logger.error('Auto slash sync failed', { reason, error });
      }
    }, 1200);
  }

  groupedPayloads(commandsByCategory) {
    return Object.entries(commandsByCategory).slice(0, 100).map(([category, commands]) => ({
      name: category.slice(0, 32),
      description: `Commands for ${category}`.slice(0, 100),
      options: commands.slice(0, 25).map((command) => ({
        type: ApplicationCommandOptionType.Subcommand,
        name: command.name,
        description: (command.description || command.name).slice(0, 100)
      }))
    }));
  }

  slashPayloads() {
    this.groupedSlashRoutes.clear();
    const slashCommands = Array.from(this.commands.values()).filter((command) => command.slash !== false);
    const directPayloads = slashCommands.map((command) => {
      if (command.slashCommand?.toJSON) return command.slashCommand.toJSON();
      if (command.slashCommand && typeof command.slashCommand === 'object') return command.slashCommand;

      const payload = {
        name: command.name,
        description: command.description || `/${command.name}`,
        options: (command.options || []).map(normalizeOption)
      };

      if (command.defaultMemberPermissions) {
        payload.default_member_permissions = String(resolvePermission(command.defaultMemberPermissions));
      }

      return payload;
    });

    if (directPayloads.length <= 100) return directPayloads;

    const commandsByCategory = {};
    for (const command of slashCommands) {
      const category = String(command.category || command.pluginId || 'general').toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 32);
      commandsByCategory[category] ||= [];
      commandsByCategory[category].push(command);
      this.groupedSlashRoutes.set(`${category}:${command.name}`, command.name);
    }

    this.logger.warning('Slash command count exceeded 100; using category compression mode.', {
      originalCount: directPayloads.length,
      categories: Object.keys(commandsByCategory).length
    });

    return this.groupedPayloads(commandsByCategory);
  }

  async syncSlashCommands() {
    const token = process.env.DISCORD_TOKEN || this.configManager.getCore('discord.token');
    const clientId = process.env.DISCORD_CLIENT_ID || this.configManager.getCore('discord.clientId');
    const mode = this.configManager.getCore('commands.slashRegistration', 'off');
    const guildIds = this.configManager.getCore('commands.guildIds', []);

    if (!token || !clientId || mode === 'off') {
      this.logger.warning('Slash command sync skipped; token, client id, or registration mode is missing.', { mode });
      return;
    }

    const rest = new REST({ version: '10' }).setToken(token);
    const payloads = this.slashPayloads();

    if (mode === 'global') {
      await rest.put(Routes.applicationCommands(clientId), { body: payloads });
      this.logger.info('Synced global slash commands', { count: payloads.length });
      return;
    }

    for (const guildId of guildIds) {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: payloads });
      this.logger.info('Synced guild slash commands', { guildId, count: payloads.length });
    }
  }

  cooldownKey(command, userId, guildId, source) {
    return `${source}:${guildId || 'dm'}:${userId || 'anonymous'}:${command.name}`;
  }

  checkCooldown(command, userId, guildId, source) {
    const cooldownMs = command.cooldownMs ?? this.configManager.getCore('bot.defaultCooldownMs', 2500);
    if (!cooldownMs) return 0;

    const key = this.cooldownKey(command, userId, guildId, source);
    const now = Date.now();
    const expiresAt = this.cooldowns.get(key) || 0;
    if (expiresAt > now) return expiresAt - now;

    this.cooldowns.set(key, now + cooldownMs);
    return 0;
  }

  isOwner(userId) {
    const owners = this.configManager.getCore('discord.ownerIds', []);
    return Boolean(userId && owners.includes(userId));
  }

  async hasPermission(command, context) {
    const userId = context.user?.id;
    if (command.ownerOnly && !this.isOwner(userId)) return false;
    if (this.isOwner(userId)) return true;

    const required = command.permissions?.user || [];
    if (!required.length) return true;

    const member = context.member || context.interaction?.member || context.message?.member;
    if (!member?.permissions?.has) return false;

    return required.every((permission) => member.permissions.has(resolvePermission(permission)));
  }

  createReply(context) {
    return async (payload) => {
      const response = typeof payload === 'string' ? { content: payload } : payload;

      if (context.source === 'interaction' && context.interaction) {
        const interactionPayload = {
          ...response,
          flags: response.ephemeral ? MessageFlags.Ephemeral : response.flags
        };
        delete interactionPayload.ephemeral;

        if (context.interaction.deferred || context.interaction.replied) {
          return context.interaction.followUp(interactionPayload);
        }
        return context.interaction.reply(interactionPayload);
      }

      if (context.source === 'message' && context.message) {
        return context.message.reply(response);
      }

      context.output.push(response.content || JSON.stringify(response));
      return response;
    };
  }

  slashOptions(interaction) {
    const data = {};
    for (const option of interaction.options.data || []) {
      data[option.name] = option.value;
    }
    return data;
  }

  async executeCommand(command, context) {
    const waitMs = this.checkCooldown(command, context.user?.id, context.guildId, context.source);
    if (waitMs > 0) {
      return context.reply(`Command is on cooldown. Try again in ${Math.ceil(waitMs / 1000)}s.`);
    }

    if (!(await this.hasPermission(command, context))) {
      return context.reply({
        content: 'You do not have permission to run this command.',
        ephemeral: true
      });
    }

    try {
      return await command.execute(context);
    } catch (error) {
      this.logger.error('Command execution failed', {
        command: command.name,
        pluginId: command.pluginId,
        error
      });
      return context.reply({
        content: `Command "${command.name}" failed. The error was isolated and logged.`,
        ephemeral: true
      });
    }
  }

  async handleMessage(message) {
    const mode = this.commandMode();
    if (mode === 'slash') return;
    if (!this.configManager.getCore('commands.allowPrefixCommands', true)) return;
    if (!message.guild || message.author?.bot) return;

    const prefix = this.configManager.getCore('bot.prefix', '!');
    if (!message.content?.startsWith(prefix)) return;

    const raw = message.content.slice(prefix.length).trim();
    const [name, ...args] = parseArgs(raw);
    if (!name) return;

    const command = this.resolveCommand(name);
    if (!command || command.prefix === false) return;

    const context = {
      source: 'message',
      client: this.client,
      command,
      message,
      interaction: null,
      guildId: message.guildId,
      guild: message.guild,
      member: message.member,
      user: message.author,
      args,
      options: {},
      configManager: this.configManager,
      logger: this.logger.child(command.pluginId),
      output: []
    };
    context.reply = this.createReply(context);

    await this.executeCommand(command, context);
  }

  async handleInteraction(interaction) {
    if (!interaction.isChatInputCommand()) return;
    const mode = this.commandMode();
    if (mode === 'prefix') return;

    let command = this.resolveCommand(interaction.commandName);
    if (!command && interaction.options?.getSubcommand) {
      const subcommand = interaction.options.getSubcommand(false);
      if (subcommand) {
        const mappedName = this.groupedSlashRoutes.get(`${interaction.commandName}:${subcommand}`);
        if (mappedName) command = this.resolveCommand(mappedName);
      }
    }
    if (!command || command.slash === false) return;

    const options = this.slashOptions(interaction);
    const context = {
      source: 'interaction',
      client: this.client,
      command,
      message: null,
      interaction,
      guildId: interaction.guildId,
      guild: interaction.guild,
      member: interaction.member,
      user: interaction.user,
      args: Object.values(options).filter((value) => value !== undefined),
      options,
      configManager: this.configManager,
      logger: this.logger.child(command.pluginId),
      output: []
    };
    context.reply = this.createReply(context);

    await this.executeCommand(command, context);
  }

  async executeDashboardCommand(commandLine, dashboardUser) {
    if (!this.configManager.getCore('commands.allowDashboardTesting', true)) {
      throw new Error('Dashboard command testing is disabled.');
    }

    const [name, ...args] = parseArgs(commandLine.trim());
    const command = this.resolveCommand(name);
    if (!command) throw new Error(`Unknown command "${name}".`);

    const context = {
      source: 'dashboard',
      client: this.client,
      command,
      message: null,
      interaction: null,
      guildId: null,
      guild: null,
      member: null,
      user: dashboardUser,
      args,
      options: {},
      configManager: this.configManager,
      logger: this.logger.child(command.pluginId),
      output: []
    };
    context.reply = this.createReply(context);

    await this.executeCommand(command, context);
    return context.output;
  }
}

module.exports = {
  CommandManager,
  parseArgs
};
