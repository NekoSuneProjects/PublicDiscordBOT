const path = require('node:path');
const fs = require('fs-extra');

const xpCooldowns = new Map();
let xpPath = null;

async function readXp() {
  try {
    return await fs.readJson(xpPath);
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

async function writeXp(data) {
  await fs.ensureDir(path.dirname(xpPath));
  await fs.writeJson(xpPath, data, { spaces: 2 });
}

function levelForXp(xp) {
  return Math.floor(Math.sqrt(xp / 100));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function mentionedUserId(raw) {
  const match = String(raw || '').match(/^<@!?(\d+)>$/);
  return match?.[1] || raw;
}

module.exports = {
  defaultConfig: {
    automod: {
      enabled: true,
      blockedWords: ['badword'],
      deleteMessage: true,
      warnMessage: 'That message was blocked by auto-moderation.'
    },
    xp: {
      enabled: true,
      minPerMessage: 5,
      maxPerMessage: 14,
      cooldownMs: 60000
    }
  },

  async load(ctx) {
    xpPath = path.join(ctx.storagePath, 'xp.json');
    await fs.ensureDir(ctx.storagePath);
    ctx.logger.info('Utility plugin storage ready', { xpPath });
  },

  events: [
    {
      name: 'messageCreate',
      async execute(ctx, message) {
        if (!message.guild || message.author.bot) return;

        const automod = ctx.configManager.getPluginConfig(ctx.pluginId, 'automod', {});
        if (automod.enabled && automod.blockedWords?.length && message.content) {
          const lowered = message.content.toLowerCase();
          const blocked = automod.blockedWords.find((word) => lowered.includes(String(word).toLowerCase()));
          const canBypass = message.member?.permissions?.has?.('ManageMessages');
          if (blocked && !canBypass) {
            if (automod.deleteMessage && message.deletable) {
              await message.delete().catch((error) => ctx.logger.warning('Failed to delete moderated message', { error }));
            }
            await message.channel.send(`${message.author}, ${automod.warnMessage}`).catch(() => {});
            ctx.logger.info('Auto-moderation blocked a message', { guildId: message.guildId, userId: message.author.id, blocked });
            return;
          }
        }

        const xpConfig = ctx.configManager.getPluginConfig(ctx.pluginId, 'xp', {});
        if (!xpConfig.enabled) return;

        const cooldownKey = `${message.guildId}:${message.author.id}`;
        const now = Date.now();
        if ((xpCooldowns.get(cooldownKey) || 0) > now) return;
        xpCooldowns.set(cooldownKey, now + (xpConfig.cooldownMs || 60000));

        const xp = await readXp();
        const guildXp = xp[message.guildId] || {};
        const userXp = guildXp[message.author.id] || { xp: 0, messages: 0 };
        userXp.xp += randomInt(xpConfig.minPerMessage || 5, xpConfig.maxPerMessage || 14);
        userXp.messages += 1;
        guildXp[message.author.id] = userXp;
        xp[message.guildId] = guildXp;
        await writeXp(xp);
      }
    }
  ],

  commands: [
    {
      name: 'level',
      description: 'Show a user XP level.',
      aliases: ['rank'],
      options: [
        {
          name: 'user',
          description: 'User id or mention',
          type: 'string',
          required: false
        }
      ],
      async execute(ctx) {
        if (!ctx.guildId) return ctx.reply('Level lookup requires a guild context.');
        const targetId = mentionedUserId(ctx.options.user || ctx.args[0] || ctx.user.id);
        const xp = await readXp();
        const userXp = xp[ctx.guildId]?.[targetId] || { xp: 0, messages: 0 };
        return ctx.reply(`User ${targetId}: level ${levelForXp(userXp.xp)}, ${userXp.xp} XP, ${userXp.messages} messages.`);
      }
    },
    {
      name: 'xp-top',
      description: 'Show the top XP users for this guild.',
      cooldownMs: 5000,
      async execute(ctx) {
        if (!ctx.guildId) return ctx.reply('XP leaderboard requires a guild context.');
        const xp = await readXp();
        const top = Object.entries(xp[ctx.guildId] || {})
          .sort((a, b) => b[1].xp - a[1].xp)
          .slice(0, 10);

        if (!top.length) return ctx.reply('No XP data yet.');
        return ctx.reply(top.map(([userId, data], index) => `${index + 1}. ${userId}: ${data.xp} XP`).join('\n'));
      }
    },
    {
      name: 'automod',
      description: 'Manage blocked words.',
      permissions: {
        user: ['ManageGuild']
      },
      options: [
        {
          name: 'action',
          description: 'add, remove, list, on, off',
          type: 'string',
          required: true
        },
        {
          name: 'word',
          description: 'Word to add or remove',
          type: 'string',
          required: false
        }
      ],
      async execute(ctx) {
        const action = ctx.options.action || ctx.args[0];
        const word = ctx.options.word || ctx.args[1];
        const config = ctx.configManager.getPluginConfig(ctx.command.pluginId);
        config.automod = config.automod || {};
        config.automod.blockedWords = config.automod.blockedWords || [];

        if (action === 'list') {
          return ctx.reply(config.automod.blockedWords.length ? config.automod.blockedWords.join(', ') : 'No blocked words configured.');
        }

        if (action === 'on' || action === 'off') {
          config.automod.enabled = action === 'on';
          await ctx.configManager.savePluginConfig(ctx.command.pluginId, config);
          return ctx.reply(`Auto-moderation ${config.automod.enabled ? 'enabled' : 'disabled'}.`);
        }

        if (action === 'add' && word) {
          if (!config.automod.blockedWords.includes(word)) config.automod.blockedWords.push(word);
          await ctx.configManager.savePluginConfig(ctx.command.pluginId, config);
          return ctx.reply(`Added "${word}" to blocked words.`);
        }

        if (action === 'remove' && word) {
          config.automod.blockedWords = config.automod.blockedWords.filter((item) => item !== word);
          await ctx.configManager.savePluginConfig(ctx.command.pluginId, config);
          return ctx.reply(`Removed "${word}" from blocked words.`);
        }

        return ctx.reply('Usage: automod <add|remove|list|on|off> [word]');
      }
    }
  ],

  dashboard: {
    async getComponent(ctx) {
      const xp = await readXp();
      const guildCount = Object.keys(xp).length;
      const userCount = Object.values(xp).reduce((sum, guild) => sum + Object.keys(guild).length, 0);
      return {
        html: `
          <!doctype html>
          <html>
            <head>
              <style>
                body { margin: 0; padding: 16px; font-family: system-ui, sans-serif; color: #14161b; }
                .metric { display: inline-grid; gap: 4px; margin-right: 18px; }
                strong { font-size: 24px; }
                span { color: #586070; }
              </style>
            </head>
            <body>
              <div class="metric"><span>Guilds with XP</span><strong>${guildCount}</strong></div>
              <div class="metric"><span>Tracked users</span><strong>${userCount}</strong></div>
            </body>
          </html>
        `
      };
    }
  }
};
