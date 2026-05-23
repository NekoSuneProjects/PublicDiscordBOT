# Security and Stability Guide

## Plugin Trust Model

Plugins execute JavaScript in the same Node.js process as the bot. That means a malicious plugin can access process memory, environment variables, the filesystem permitted to the process, and network APIs.

This project reduces risk with:

- Manifest validation
- Plugin ID validation
- Allowed remote plugin hosts
- ZIP path traversal checks
- Plugin-local `node_modules`
- Dependency install timeouts
- `npm install --ignore-scripts` by default
- Plugin permission manifest checks for commands and Discord events
- Error isolation around commands, events, dashboard hooks, and lifecycle hooks

These controls are not equivalent to a VM, container, or OS sandbox.

## Production Recommendations

- Keep `security.allowUntrustedPluginInstall` set to `false`
- Keep `plugins.dependencyInstall.ignoreScripts` set to `true`
- Restrict `security.allowedPluginHosts` to repositories you control
- Require code review before enabling new plugins
- Run the bot under a dedicated OS user with minimal filesystem permissions
- Store secrets only in environment variables or a secret manager
- Do not give dashboard access to regular guild moderators
- Use HTTPS and secure cookies behind a reverse proxy in production
- Keep `dashboard.allowAnyAuthenticatedUser` set to `false`
- Use guild slash command registration during development and global registration only for stable releases

## Dashboard OAuth

The dashboard checks authenticated Discord IDs against:

- `dashboard.adminUserIds`
- `discord.ownerIds`

Users who authenticate successfully but are not listed are denied.

## Dependency Installation

The dependency installer runs inside the plugin directory. By default it omits dev dependencies and ignores install scripts:

```text
npm install --no-audit --no-fund --omit=dev --ignore-scripts
```

Some media or native dependencies may require install scripts. Only disable `ignoreScripts` for plugins you trust.

## Fault Isolation

Plugin command, event, dashboard, and lifecycle errors are caught and logged. A failing plugin should not crash the bot core. Load failures mark the plugin as `failed` in `config/plugins.json` and the dashboard.

## Recommended Deployment

- Run `npm ci` for core dependencies
- Run behind nginx, Caddy, or another HTTPS reverse proxy
- Set `DASHBOARD_SESSION_SECRET`
- Set `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, and `DISCORD_CLIENT_SECRET` from the host environment
- Use `npm run start:watchdog` or a real process supervisor such as systemd, PM2, Docker, or Kubernetes
- Back up `config/`, `plugins/`, and `data/`
