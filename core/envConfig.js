function toBool(value, fallback) {
  if (value == null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function toNumber(value, fallback) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toCsv(value, fallback = []) {
  if (value == null || value === '') return fallback;
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function applyEnvOverrides(core = {}, env = process.env) {
  const next = structuredClone(core);

  next.discord ||= {};
  next.commands ||= {};
  next.dashboard ||= {};
  next.logging ||= {};

  if (env.DISCORD_TOKEN) next.discord.token = env.DISCORD_TOKEN;
  if (env.DISCORD_CLIENT_ID) next.discord.clientId = env.DISCORD_CLIENT_ID;
  const ownerIds = toCsv(env.DISCORD_OWNER_IDS);
  if (ownerIds.length) next.discord.ownerIds = ownerIds;

  if (env.BOT_PREFIX) next.bot = { ...(next.bot || {}), prefix: env.BOT_PREFIX };

  if (env.COMMANDS_SLASH_REGISTRATION) next.commands.slashRegistration = env.COMMANDS_SLASH_REGISTRATION;
  const guildIds = toCsv(env.COMMANDS_GUILD_IDS);
  if (guildIds.length) next.commands.guildIds = guildIds;
  next.commands.registerOnReady = toBool(env.COMMANDS_REGISTER_ON_READY, next.commands.registerOnReady);
  next.commands.allowPrefixCommands = toBool(env.COMMANDS_ALLOW_PREFIX, next.commands.allowPrefixCommands);
  next.commands.allowDashboardTesting = toBool(env.COMMANDS_ALLOW_DASHBOARD_TESTING, next.commands.allowDashboardTesting);

  next.dashboard.enabled = toBool(env.DASHBOARD_ENABLED, next.dashboard.enabled);
  if (env.DASHBOARD_HOST) next.dashboard.host = env.DASHBOARD_HOST;
  next.dashboard.port = toNumber(env.DASHBOARD_PORT ?? env.PORT, next.dashboard.port);
  if (env.DASHBOARD_PUBLIC_URL) next.dashboard.publicUrl = env.DASHBOARD_PUBLIC_URL;
  if (env.DASHBOARD_SESSION_SECRET) next.dashboard.sessionSecret = env.DASHBOARD_SESSION_SECRET;
  const adminIds = toCsv(env.DASHBOARD_ADMIN_USER_IDS);
  if (adminIds.length) next.dashboard.adminUserIds = adminIds;
  next.dashboard.allowAnyAuthenticatedUser = toBool(env.DASHBOARD_ALLOW_ANY_AUTH_USER, next.dashboard.allowAnyAuthenticatedUser);

  if (env.LOG_LEVEL) next.logging.level = env.LOG_LEVEL;
  next.logging.console = toBool(env.LOG_CONSOLE, next.logging.console);
  next.logging.file = toBool(env.LOG_FILE, next.logging.file);
  if (env.LOG_FILE_PATH) next.logging.filePath = env.LOG_FILE_PATH;

  return next;
}

module.exports = { applyEnvOverrides };
