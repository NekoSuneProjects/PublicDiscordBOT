# CREATE PLUGIN.md

This guide explains how to build plugins for this bot, what files are required, what APIs you can use, how commands/events work, and ready-to-copy snippets.

---

## 1) Required plugin files

Create a folder under `plugins/`:

```text
plugins/my-plugin/
  package.json
  index.js
  config.json (optional but recommended)
```

### `package.json` minimum

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "main": "index.js",
  "modularDiscordBotPlugin": {
    "id": "my-plugin",
    "name": "My Plugin",
    "entry": "index.js",
    "defaultEnabled": true,
    "permissions": ["discord.commands"]
  }
}
```

### Plugin ID rules
- lowercase letters, numbers, `_`, `-`
- 2-64 chars
- must be unique across installed plugins

---

## 2) Plugin module shape (`index.js`)

You can export either an object, or a factory function `(ctx) => pluginObject`.

```js
module.exports = {
  // Lifecycle
  async load(ctx) {},
  async unload(ctx) {},
  async onConfigChanged(nextConfig) {},

  // Features
  commands: [],
  events: [],

  // Optional dashboard component block
  dashboard: {
    html: '<div>Hello from plugin dashboard</div>',
    scripts: []
    // or getComponent(ctx) { return { html, scripts }; }
  }
};
```

---

## 3) Plugin context (`ctx`) you get

In lifecycle, command execute, and event execute handlers, you can use:

- `ctx.pluginId`
- `ctx.manifest`
- `ctx.client` (tracked/safe Discord client proxy)
- `ctx.rawClient` (raw Discord client)
- `ctx.events.on/once/off(...)` (tracked event registration)
- `ctx.config` (current plugin config object)
- `ctx.getConfig(path, fallback)`
- `ctx.setConfig(path, value)`
- `ctx.saveConfig(nextConfig)`
- `ctx.coreConfig` (full merged core config)
- `ctx.configManager`
- `ctx.logger`
- `ctx.dataPath` (plugin data directory)

---

## 4) Commands

Each command supports both prefix and slash by default.

```js
commands: [
  {
    name: 'ping',
    description: 'Ping command',
    aliases: ['p'],
    slash: true,
    prefix: true,
    ownerOnly: false,
    cooldownMs: 1500,
    category: 'utility',
    permissions: {
      user: ['ManageMessages']
    },
    options: [
      {
        name: 'target',
        description: 'Target user',
        type: 'user',
        required: false
      }
    ],
    async execute(ctx) {
      await ctx.reply('Pong!');
    }
  }
]
```

### Command option `type` values
- `string`
- `integer`
- `boolean`
- `user`
- `channel`
- `role`
- `mentionable`
- `number`
- `attachment`

### Slash vs prefix mode
Controlled globally by core/env:
- `commands.mode = both|slash|prefix`

---

## 5) Events

You can define plugin-managed event handlers:

```js
events: [
  {
    name: 'guildMemberAdd',
    once: false,
    async execute(ctx, member) {
      ctx.logger.info('Member joined', { userId: member.id });
    }
  }
]
```

You can also use the tracked client directly:

```js
async load(ctx) {
  ctx.client.on('ready', () => {
    ctx.logger.info('Plugin saw ready event');
  });
}
```

### What Discord events can be used?
Any event emitted by Discord.js client can be used (examples: `ready`, `messageCreate`, `interactionCreate`, `guildCreate`, `guildMemberAdd`, `voiceStateUpdate`, etc.) as long as:
1. Bot has required Gateway Intents.
2. Plugin permission allows it (when permission enforcement is enabled).

For full event list, use Discord.js client event documentation for your installed `discord.js` version.

---

## 6) Permissions manifest (`modularDiscordBotPlugin.permissions`)

Examples:

```json
{
  "permissions": [
    "discord.commands",
    "discord.events.ready",
    "discord.events.messageCreate",
    "discord.events.guildMemberAdd"
  ]
}
```

Wildcard for events:

```json
{
  "permissions": ["discord.events.*"]
}
```

---

## 7) Config file (`config.json`) and runtime changes

Default plugin config example:

```json
{
  "enabled": true,
  "welcomeChannelId": "",
  "welcomeMessage": "Welcome {user}!"
}
```

React to updates from dashboard/API:

```js
async onConfigChanged(nextConfig) {
  // refresh cache, schedules, etc.
}
```

---

## 8) Dashboard UI component from plugin

Static:

```js
dashboard: {
  html: '<div><h3>My Plugin</h3><p>Status OK</p></div>',
  scripts: [
    'console.log("dashboard script from plugin")'
  ]
}
```

Dynamic:

```js
dashboard: {
  getComponent(ctx) {
    return {
      html: `<div>Plugin: ${ctx.pluginId}</div>`,
      scripts: []
    };
  }
}
```

---

## 9) Full example plugin

```js
module.exports = {
  async load(ctx) {
    ctx.logger.info('Loaded');
    ctx.client.on('ready', () => ctx.logger.info('Client ready (tracked listener)'));
  },

  async unload(ctx) {
    ctx.logger.info('Unloaded');
  },

  async onConfigChanged(nextConfig) {
    // called when config/plugins/<plugin-id>.json changes
  },

  commands: [
    {
      name: 'hello',
      description: 'Say hello',
      aliases: ['hi'],
      category: 'general',
      async execute(ctx) {
        const who = ctx.user?.username || 'there';
        await ctx.reply(`Hello ${who}!`);
      }
    }
  ],

  events: [
    {
      name: 'messageCreate',
      async execute(ctx, message) {
        if (!message.guild || message.author?.bot) return;
        if (message.content === '!plugin-ping') {
          await message.reply('plugin pong');
        }
      }
    }
  ],

  dashboard: {
    html: '<div><strong>My Plugin dashboard block</strong></div>',
    scripts: []
  }
};
```

---

## 10) Install, reload, update flow

From bot owner commands:
- `!plugin reload my-plugin`
- `!plugin disable my-plugin`
- `!plugin enable my-plugin`
- `!plugin uninstall my-plugin`
- `!plugin sync-commands`

From dashboard:
- Install by URL
- GitHub discovery install
- Per-plugin config edit
- Enable/disable/reload/update/uninstall

---

## 11) Best practices

1. Always guard message handlers (`ignore bot users`, `check guild`).
2. Keep command names lowercase and unique.
3. Add explicit permissions in manifest.
4. Use `ctx.client` (tracked) instead of `ctx.rawClient` unless needed.
5. Keep `config.json` defaults small and sane.
6. Log useful diagnostics via `ctx.logger`.
7. Catch and validate external API data inside plugin logic.

---

## 12) Troubleshooting

- **Command not showing in slash UI**:
  - Check `commands.mode` and `commands.slashRegistration`.
  - Run `!plugin sync-commands`.
  - Check logs for permission/validation issues.
- **Event not firing**:
  - Ensure required Gateway Intent is enabled.
  - Ensure plugin manifest includes `discord.events.<eventName>` or `discord.events.*`.
- **Plugin load fails**:
  - Verify `package.json` and `modularDiscordBotPlugin.entry` path.
  - Check bot logs for isolated plugin error stack.
