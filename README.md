# ModularDiscordBot

Production-grade Discord.js v14 bot scaffold with dynamic plugins, plugin-local dependencies, prefix and slash commands, config hot reload, and a Discord OAuth dashboard.

## Features

- Modular plugins in `plugins/<plugin-id>` with their own `package.json`, `index.js`, and `config.json`
- Plugin lifecycle actions: load, enable, disable, reload, uninstall
- Plugin-local `npm install` with `node_modules` isolated inside each plugin directory
- Prefix commands, slash command payload generation, permissions, owner-only commands, and cooldowns
- Discord events registered by plugins with permission manifest checks
- Express dashboard with Discord OAuth2 login, plugin controls, JSON config editors, command testing, and live logs
- Config hot reload from `config/core.json` and `config/plugins/*.json`
- Graceful shutdown and watchdog restart flow
- Bundled examples for command, utility/automod/XP, and music playback

## Requirements

- Node.js `20.11+`
- npm
- A Discord application and bot token
- Message Content intent enabled in the Discord Developer Portal if you want prefix commands and automod text scanning
- Guild Members intent enabled if plugins need member join or member metadata events

## Quick Start

```powershell
npm install
Copy-Item .env.example .env
```

Fill `.env`:

```env
DISCORD_TOKEN=your-bot-token
DISCORD_CLIENT_ID=your-application-client-id
DISCORD_CLIENT_SECRET=your-oauth-client-secret
DISCORD_REDIRECT_URI=http://localhost:3000/auth/discord/callback
DASHBOARD_SESSION_SECRET=replace-with-a-long-random-string
```

Edit `config/core.json`:

- `discord.ownerIds`: Discord user IDs allowed to run owner-only bot commands
- `dashboard.adminUserIds`: Discord user IDs allowed into the dashboard
- `commands.guildIds`: guild IDs for fast guild slash command registration
- `bot.prefix`: prefix command trigger

Start the bot:

```powershell
npm start
```

Open the dashboard:

```text
http://localhost:3000
```

Register slash commands manually:

```powershell
npm run register:commands
```

For automatic slash command registration on startup, set `commands.registerOnReady` to `true`.

## Watchdog Restart

The `botrestart` owner command exits with code `42`. Run through the watchdog to restart automatically:

```powershell
npm run start:watchdog
```

## Project Layout

```text
core/
  commandManager.js
  configManager.js
  coreCommands.js
  logger.js
  pluginManager.js
dashboard/
  server.js
  public/
plugins/
  command-example/
  utility-example/
  music-example/
utils/
  dependencyInstaller.js
  pluginInstaller.js
config/
  core.json
  plugins.json
  plugins/
scripts/
```

## Plugin Structure

Each plugin is a normal Node.js package:

```text
plugins/my-plugin/
  package.json
  index.js
  config.json
```

Minimum `package.json`:

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

Plugin export shape:

```js
module.exports = {
  defaultConfig: {},
  async load(ctx) {},
  async unload(ctx) {},
  async onConfigChanged(nextConfig) {},
  commands: [
    {
      name: 'ping',
      description: 'Ping command',
      async execute(ctx) {
        return ctx.reply('Pong');
      }
    }
  ],
  events: [
    {
      name: 'guildMemberAdd',
      async execute(ctx, member) {}
    }
  ],
  dashboard: {
    getComponent(ctx) {
      return { html: '<!doctype html><html><body>Plugin panel</body></html>' };
    }
  }
};
```

Plugin context includes:

- `client`
- `logger`
- `config`
- `getConfig(path, fallback)`
- `setConfig(path, value)`
- `saveConfig(config)`
- `storagePath`
- `configManager`
- `commandManager`

## Plugin Dependencies

When a plugin is loaded, the manager reads the plugin's `dependencies` and runs:

```text
npm install --no-audit --no-fund --omit=dev --ignore-scripts
```

inside that plugin directory if dependencies are missing. This keeps plugin packages under `plugins/<id>/node_modules`.

Change `plugins.dependencyInstall.ignoreScripts` in `config/core.json` only for trusted plugins that require install scripts.

## Dashboard

The dashboard supports:

- Installed plugin inventory
- Git/ZIP plugin installation from allowed hosts
- Enable, disable, reload, uninstall
- Core config editing
- Plugin config editing
- Plugin dashboard component iframe rendering
- Command testing
- Live log streaming

Remote plugin installation is controlled by:

```json
"security": {
  "allowRemotePluginInstall": true,
  "allowUntrustedPluginInstall": false,
  "allowedPluginHosts": ["github.com", "raw.githubusercontent.com", "codeload.github.com"]
}
```

## Bundled Plugins

`command-example`

- `hello`
- `echo`
- Shows command registration, aliases, permissions, config, and dashboard component output

`utility-example`

- `level`
- `xp-top`
- `automod`
- Shows message events, auto-moderation, XP storage, guild permissions, and live config changes

`music-example`

- `play`
- `pause`
- `resume`
- `stop`
- `queue`
- Uses `@discordjs/voice` and `play-dl`
- Disabled by default because it installs heavier media dependencies

## Operations

Useful owner commands:

```text
!plugins
!plugin reload command-example
!plugin enable music-example
!plugin disable utility-example
!plugin sync-commands
!botsettings get bot.prefix
!botsettings set bot.prefix "?"
!botrestart
```

Logs are written to memory and optionally to `logs/bot.log`.

## Verification

Run the syntax checker:

```powershell
npm run check
```

## Notes

Plugins are Node.js code. The system isolates failures and plugin dependencies, but in-process JavaScript is not a hard security sandbox. Install only trusted plugins in production.
