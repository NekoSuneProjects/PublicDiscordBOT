require('dotenv').config({ quiet: true });
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { WebSocketServer } = require('ws');
const { searchGithubPluginRepositories } = require('../utils/githubDiscovery');


function mergeSensitiveCoreFields(nextCore = {}, currentCore = {}) {
  const merged = structuredClone(nextCore);
  if (!merged.discord) merged.discord = {};
  if (!merged.dashboard) merged.dashboard = {};

  if (merged.discord.token === '***redacted***') merged.discord.token = currentCore?.discord?.token || '';
  if (merged.dashboard.sessionSecret === '***redacted***') merged.dashboard.sessionSecret = currentCore?.dashboard?.sessionSecret || '';
  return merged;
}

function sanitizeCoreForDashboard(core = {}) {
  const next = structuredClone(core);
  if (!next.discord) next.discord = {};
  if (!next.dashboard) next.dashboard = {};
  next.discord.token = next.discord.token ? '***redacted***' : '';
  next.dashboard.sessionSecret = next.dashboard.sessionSecret ? '***redacted***' : '';
  return next;
}


class DashboardServer {
  constructor({ client, configManager, pluginManager, commandManager, logger, rootDir = process.cwd() }) {
    this.client = client;
    this.configManager = configManager;
    this.pluginManager = pluginManager;
    this.commandManager = commandManager;
    this.rootLogger = logger;
    this.logger = logger.child('dashboard');
    this.rootDir = rootDir;
    this.app = express();
    this.server = null;
    this.wss = null;
    this.wsTokens = new Map();
  }

  config(pathExpression, fallback) {
    return this.configManager.getCore(`dashboard.${pathExpression}`, fallback);
  }

  oauthConfig(pathExpression, fallback) {
    return process.env[pathExpression] || fallback;
  }

  sessionSecret() {
    const configured = process.env.DASHBOARD_SESSION_SECRET || this.config('sessionSecret');
    if (configured) return configured;
    this.logger.warning('Dashboard session secret is not configured; using an ephemeral secret for this run.');
    return crypto.randomBytes(32).toString('hex');
  }

  isAuthorized(user) {
    if (!user?.id) return false;
    if (this.config('allowAnyAuthenticatedUser', false)) return true;

    const dashboardAdmins = this.config('adminUserIds', []);
    const botOwners = this.configManager.getCore('discord.ownerIds', []);
    return dashboardAdmins.includes(user.id) || botOwners.includes(user.id);
  }

  requireAuth() {
    return (req, res, next) => {
      if (req.session?.user && this.isAuthorized(req.session.user)) return next();
      if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      return res.redirect('/');
    };
  }

  async exchangeDiscordCode(code, redirectUri) {
    const clientId = process.env.DISCORD_CLIENT_ID || this.configManager.getCore('discord.clientId');
    const clientSecret = process.env.DISCORD_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error('DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET are required for OAuth login.');
    }

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri
    });

    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });

    if (!tokenResponse.ok) {
      throw new Error(`Discord token exchange failed: ${tokenResponse.status}`);
    }

    const token = await tokenResponse.json();
    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${token.access_token}` }
    });

    if (!userResponse.ok) {
      throw new Error(`Discord user lookup failed: ${userResponse.status}`);
    }

    const user = await userResponse.json();
    return {
      id: user.id,
      username: user.username,
      globalName: user.global_name,
      avatar: user.avatar
    };
  }

  setupRoutes() {
    const publicDir = path.join(this.rootDir, 'dashboard/public');
    const sessionMiddleware = session({
      name: 'mdb.sid',
      secret: this.sessionSecret(),
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: false,
        maxAge: 1000 * 60 * 60 * 8
      }
    });

    this.app.set('trust proxy', 1);
    this.app.use(helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'connect-src': ["'self'", 'ws:', 'wss:'],
          'script-src': ["'self'"],
          'style-src': ["'self'"]
        }
      }
    }));
    this.app.use(express.json({ limit: '1mb' }));
    this.app.use(sessionMiddleware);
    this.app.use(rateLimit({
      windowMs: this.config('rateLimit.windowMs', 60000),
      max: this.config('rateLimit.max', 120),
      standardHeaders: true,
      legacyHeaders: false
    }));

    this.app.get('/', (req, res) => {
      if (req.session?.user && this.isAuthorized(req.session.user)) {
        return res.sendFile(path.join(publicDir, 'index.html'));
      }

      return res.type('html').send(`
        <!doctype html>
        <html lang="en">
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>ModularDiscordBot Login</title>
            <link rel="stylesheet" href="/style.css">
          </head>
          <body class="login-page">
            <main class="login-panel">
              <h1>ModularDiscordBot</h1>
              <p>Sign in with Discord to manage plugins, settings, and logs.</p>
              <a class="button primary" href="/auth/discord">Sign in with Discord</a>
            </main>
          </body>
        </html>
      `);
    });

    this.app.get('/auth/discord', (req, res) => {
      const clientId = process.env.DISCORD_CLIENT_ID || this.configManager.getCore('discord.clientId');
      const redirectUri = process.env.DISCORD_REDIRECT_URI || `${this.config('publicUrl')}/auth/discord/callback`;
      if (!clientId) return res.status(500).send('DISCORD_CLIENT_ID is not configured.');

      const state = crypto.randomBytes(24).toString('hex');
      req.session.oauthState = state;
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        scope: 'identify guilds',
        redirect_uri: redirectUri,
        state
      });
      return res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
    });

    this.app.get('/auth/discord/callback', async (req, res, next) => {
      try {
        if (!req.query.code || req.query.state !== req.session.oauthState) {
          return res.status(400).send('Invalid OAuth callback state.');
        }

        const redirectUri = process.env.DISCORD_REDIRECT_URI || `${this.config('publicUrl')}/auth/discord/callback`;
        const user = await this.exchangeDiscordCode(req.query.code, redirectUri);
        if (!this.isAuthorized(user)) {
          this.logger.warning('Unauthorized dashboard login attempt', { userId: user.id, username: user.username });
          return res.status(403).send('You are authenticated, but not authorized for this dashboard.');
        }

        req.session.user = user;
        delete req.session.oauthState;
        return res.redirect('/');
      } catch (error) {
        return next(error);
      }
    });

    this.app.post('/auth/logout', this.requireAuth(), (req, res) => {
      req.session.destroy(() => res.json({ ok: true }));
    });

    this.app.use(express.static(publicDir, {
      index: false,
      maxAge: '1h'
    }));

    const api = express.Router();
    api.use(this.requireAuth());

    api.get('/me', (req, res) => {
      res.json({ user: req.session.user });
    });

    api.get('/status', (req, res) => {
      res.json({
        ready: this.client.isReady(),
        user: this.client.user ? {
          id: this.client.user.id,
          username: this.client.user.username,
          tag: this.client.user.tag
        } : null,
        guilds: this.client.guilds.cache.size,
        uptimeMs: this.client.uptime,
        pingMs: this.client.ws.ping
      });
    });

    api.get('/plugins', async (req, res, next) => {
      try {
        await this.pluginManager.discoverPlugins();
        res.json({ plugins: this.pluginManager.listPlugins() });
      } catch (error) {
        next(error);
      }
    });

    api.post('/plugins/install', async (req, res, next) => {
      try {
        const source = String(req.body.source || '').trim();
        if (!source) return res.status(400).json({ error: 'source is required' });
        const packagePath = req.body.packagePath ? String(req.body.packagePath).trim() : null;
        const plugin = await this.pluginManager.installFromSource(source, { packagePath });
        res.json({ plugin });
      } catch (error) {
        next(error);
      }
    });

    api.get('/plugins/discover/github', async (req, res, next) => {
      try {
        const discoveryConfig = this.configManager.getCore('plugins.discovery.github', {});
        if (discoveryConfig.enabled === false) {
          return res.status(403).json({ error: 'GitHub plugin discovery is disabled.' });
        }

        const result = await searchGithubPluginRepositories({
          topic: req.query.topic || discoveryConfig.topic,
          query: req.query.query,
          limit: req.query.limit,
          defaultLimit: discoveryConfig.defaultLimit,
          sort: req.query.sort || discoveryConfig.sort,
          order: req.query.order || discoveryConfig.order
        });

        const installedPlugins = this.pluginManager.listPlugins();
        const installedSources = new Set(installedPlugins.map((plugin) => plugin.source).filter(Boolean));
        const installedIds = new Set(installedPlugins.map((plugin) => plugin.id));

        res.json({
          ...result,
          repositories: result.repositories.map((repository) => ({
            ...repository,
            installed: installedSources.has(repository.cloneUrl) || installedIds.has(repository.pluginId) || installedIds.has(repository.name),
            pluginPackages: (repository.pluginPackages || []).map((pkg) => ({
              ...pkg,
              installed: installedIds.has(pkg.pluginId)
            }))
          }))
        });
      } catch (error) {
        next(error);
      }
    });

    api.post('/plugins/check-updates', async (req, res, next) => {
      try {
        const updates = await this.pluginManager.checkAllPluginUpdates();
        res.json({ updates, plugins: this.pluginManager.listPlugins() });
      } catch (error) {
        next(error);
      }
    });

    api.post('/plugins/:id/:action', async (req, res, next) => {
      try {
        const { id, action } = req.params;
        if (action === 'enable') await this.pluginManager.enablePlugin(id);
        else if (action === 'disable') await this.pluginManager.disablePlugin(id);
        else if (action === 'reload') await this.pluginManager.reloadPlugin(id);
        else if (action === 'check-update') await this.pluginManager.checkPluginUpdate(id);
        else if (action === 'update') await this.pluginManager.updatePlugin(id);
        else if (action === 'uninstall') await this.pluginManager.uninstallPlugin(id, { keepConfig: req.body.keepConfig === true });
        else return res.status(400).json({ error: `Unsupported action "${action}"` });
        res.json({ ok: true, plugins: this.pluginManager.listPlugins() });
      } catch (error) {
        next(error);
      }
    });

    api.get('/plugins/:id/config', async (req, res, next) => {
      try {
        await this.configManager.reloadPluginConfig(req.params.id);
        res.json({ config: this.configManager.getPluginConfig(req.params.id) });
      } catch (error) {
        next(error);
      }
    });

    api.put('/plugins/:id/config', async (req, res, next) => {
      try {
        if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
          return res.status(400).json({ error: 'JSON object body is required' });
        }
        const config = await this.configManager.savePluginConfig(req.params.id, req.body);
        res.json({ config });
      } catch (error) {
        next(error);
      }
    });

    api.get('/plugins/:id/dashboard', async (req, res, next) => {
      try {
        res.json({ component: await this.pluginManager.getDashboardComponent(req.params.id) });
      } catch (error) {
        next(error);
      }
    });

    api.get('/settings/core', (req, res) => {
      res.json({ config: sanitizeCoreForDashboard(this.configManager.core) });
    });

    api.put('/settings/core', async (req, res, next) => {
      try {
        if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
          return res.status(400).json({ error: 'JSON object body is required' });
        }
        const safeCore = mergeSensitiveCoreFields(req.body, this.configManager.fileCore || this.configManager.core);
        await this.configManager.saveCore(safeCore);
        res.json({ config: sanitizeCoreForDashboard(this.configManager.core) });
      } catch (error) {
        next(error);
      }
    });

    api.get('/commands', (req, res) => {
      res.json({ commands: this.commandManager.listCommands() });
    });

    api.post('/commands/test', async (req, res, next) => {
      try {
        const command = String(req.body.command || '').trim();
        if (!command) return res.status(400).json({ error: 'command is required' });
        const output = await this.commandManager.executeDashboardCommand(command, req.session.user);
        res.json({ output });
      } catch (error) {
        next(error);
      }
    });

    api.get('/logs', (req, res) => {
      res.json({ logs: this.rootLogger.getRecent(150) });
    });

    api.post('/logs/token', (req, res) => {
      const token = crypto.randomBytes(24).toString('hex');
      this.wsTokens.set(token, {
        userId: req.session.user.id,
        expiresAt: Date.now() + 30000
      });
      res.json({ token });
    });

    this.app.use('/api', api);

    this.app.use((error, req, res, next) => {
      this.logger.error('Dashboard request failed', { path: req.path, error });
      if (res.headersSent) return next(error);
      return res.status(500).json({ error: error.message || 'Internal server error' });
    });

    this.sessionMiddleware = sessionMiddleware;
  }

  setupWebSocket() {
    this.wss = new WebSocketServer({ noServer: true });

    this.server.on('upgrade', (request, socket, head) => {
      const requestUrl = new URL(request.url, 'http://localhost');
      if (requestUrl.pathname !== '/ws/logs') {
        socket.destroy();
        return;
      }

      const token = requestUrl.searchParams.get('token');
      const tokenRecord = this.wsTokens.get(token);
      this.wsTokens.delete(token);

      if (!tokenRecord || tokenRecord.expiresAt < Date.now()) {
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit('connection', ws, request);
      });
    });

    this.wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'snapshot', entries: this.rootLogger.getRecent(150) }));
    });

    this.logListener = (entry) => {
      const payload = JSON.stringify({ type: 'entry', entry });
      for (const client of this.wss.clients) {
        if (client.readyState === 1) client.send(payload);
      }
    };
  }

  async start() {
    if (!this.configManager.getCore('dashboard.enabled', true)) {
      this.logger.info('Dashboard disabled by configuration.');
      return null;
    }

    this.setupRoutes();
    this.server = http.createServer(this.app);
    this.setupWebSocket();
    this.rootLogger.on('entry', this.logListener);

    const host = this.config('host', '0.0.0.0');
    const port = this.config('port', process.env.PORT || 3000);

    await new Promise((resolve) => {
      this.server.listen(port, host, resolve);
    });

    this.logger.info('Dashboard listening', { url: `http://${host}:${port}` });
    return this.server;
  }

  async stop() {
    if (this.logListener) this.rootLogger.off('entry', this.logListener);
    if (this.wss) {
      for (const client of this.wss.clients) client.close();
      this.wss.close();
    }
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
    }
  }
}

module.exports = { DashboardServer };
