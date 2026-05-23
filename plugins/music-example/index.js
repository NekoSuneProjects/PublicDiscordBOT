let voice = null;
let playdl = null;
let runtimeContext = null;

const queues = new Map();

function getQueue(guildId) {
  if (!queues.has(guildId)) {
    const player = voice.createAudioPlayer();
    const queue = {
      guildId,
      player,
      connection: null,
      tracks: [],
      current: null,
      textChannel: null,
      playing: false
    };

    player.on(voice.AudioPlayerStatus.Idle, () => {
      playNext(guildId).catch((error) => runtimeContext.logger.error('Failed to play next track', { guildId, error }));
    });

    player.on('error', (error) => {
      runtimeContext.logger.error('Audio player error', { guildId, error });
      playNext(guildId).catch((nextError) => runtimeContext.logger.error('Failed to recover queue', { guildId, error: nextError }));
    });

    queues.set(guildId, queue);
  }

  return queues.get(guildId);
}

function queryText(ctx) {
  return (ctx.options.query || ctx.args.join(' ') || '').trim();
}

function voiceChannelFor(ctx) {
  const cachedMember = ctx.guild?.members.cache.get(ctx.user.id);
  return cachedMember?.voice?.channel || ctx.member?.voice?.channel || null;
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

async function searchYouTube(query) {
  const results = await playdl.search(query, {
    limit: 1,
    source: { youtube: 'video' }
  });

  if (!results.length) throw new Error('No YouTube results found.');
  const video = results[0];
  return {
    title: video.title || query,
    url: video.url,
    duration: video.durationRaw || ''
  };
}

async function resolveSpotify(query) {
  const spotify = await playdl.spotify(query);
  if (spotify?.type === 'track') {
    const artists = (spotify.artists || []).map((artist) => artist.name).join(' ');
    return searchYouTube(`${spotify.name} ${artists}`);
  }

  const tracks = spotify?.tracks || spotify?.fetched_tracks?.get?.() || [];
  const first = Array.isArray(tracks) ? tracks[0] : null;
  if (!first) throw new Error('Spotify URL did not expose a playable track.');
  const artists = (first.artists || []).map((artist) => artist.name).join(' ');
  return searchYouTube(`${first.name} ${artists}`);
}

async function resolveTrack(query) {
  if (!query) throw new Error('A search query or URL is required.');

  if (isHttpUrl(query) && query.includes('open.spotify.com')) {
    return resolveSpotify(query);
  }

  if (isHttpUrl(query) && (query.includes('youtube.com') || query.includes('youtu.be'))) {
    const info = await playdl.video_basic_info(query);
    return {
      title: info.video_details.title,
      url: info.video_details.url,
      duration: info.video_details.durationRaw || ''
    };
  }

  return searchYouTube(query);
}

async function ensureConnection(ctx, channel) {
  const queue = getQueue(ctx.guildId);
  if (queue.connection && queue.connection.joinConfig.channelId === channel.id) {
    return queue.connection;
  }

  if (queue.connection) queue.connection.destroy();
  queue.connection = voice.joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: true
  });
  queue.connection.subscribe(queue.player);
  return queue.connection;
}

async function playNext(guildId) {
  const queue = queues.get(guildId);
  if (!queue) return;

  const next = queue.tracks.shift();
  if (!next) {
    queue.current = null;
    queue.playing = false;
    if (runtimeContext.getConfig('leaveOnQueueEnd', true) && queue.connection) {
      queue.connection.destroy();
      queue.connection = null;
    }
    return;
  }

  queue.current = next;
  queue.playing = true;

  const stream = await playdl.stream(next.url);
  const resource = voice.createAudioResource(stream.stream, {
    inputType: stream.type,
    inlineVolume: true
  });
  const volume = Number(runtimeContext.getConfig('volume', 0.65));
  if (resource.volume && Number.isFinite(volume)) resource.volume.setVolume(Math.max(0, Math.min(volume, 1.5)));

  queue.player.play(resource);
  if (queue.textChannel) {
    await queue.textChannel.send(`Now playing: ${next.title}`).catch(() => {});
  }
}

async function stopQueue(guildId) {
  const queue = queues.get(guildId);
  if (!queue) return;
  queue.tracks = [];
  queue.current = null;
  queue.playing = false;
  queue.player.stop(true);
  if (runtimeContext.getConfig('leaveOnStop', true) && queue.connection) {
    queue.connection.destroy();
    queue.connection = null;
  }
}

module.exports = {
  defaultConfig: {
    maxQueueSize: 50,
    volume: 0.65,
    leaveOnStop: true,
    leaveOnQueueEnd: true
  },

  async load(ctx) {
    runtimeContext = ctx;
    voice = require('@discordjs/voice');
    playdl = require('play-dl');
    ctx.logger.info('Music dependencies loaded');
  },

  async unload() {
    for (const queue of queues.values()) {
      queue.tracks = [];
      queue.player.stop(true);
      if (queue.connection) queue.connection.destroy();
    }
    queues.clear();
  },

  commands: [
    {
      name: 'play',
      description: 'Play a YouTube or Spotify track.',
      cooldownMs: 2500,
      options: [
        {
          name: 'query',
          description: 'Search terms, YouTube URL, or Spotify URL',
          type: 'string',
          required: true
        }
      ],
      async execute(ctx) {
        if (!ctx.guildId) return ctx.reply('Music playback requires a guild.');
        const channel = voiceChannelFor(ctx);
        if (!channel) return ctx.reply('Join a voice channel first.');
        if (ctx.interaction && !ctx.interaction.deferred && !ctx.interaction.replied) {
          await ctx.interaction.deferReply();
        }

        const queue = getQueue(ctx.guildId);
        const maxQueueSize = Number(ctx.configManager.getPluginConfig('music-example', 'maxQueueSize', 50));
        if (queue.tracks.length >= maxQueueSize) return ctx.reply(`Queue limit reached (${maxQueueSize}).`);

        const track = await resolveTrack(queryText(ctx));
        queue.textChannel = ctx.message?.channel || ctx.interaction?.channel || queue.textChannel;
        await ensureConnection(ctx, channel);
        queue.tracks.push(track);

        if (!queue.playing && queue.player.state.status !== voice.AudioPlayerStatus.Playing) {
          await playNext(ctx.guildId);
          return ctx.reply(`Queued and started: ${track.title}`);
        }

        return ctx.reply(`Queued: ${track.title}`);
      }
    },
    {
      name: 'pause',
      description: 'Pause music playback.',
      async execute(ctx) {
        const queue = queues.get(ctx.guildId);
        if (!queue?.player.pause()) return ctx.reply('Nothing is playing.');
        return ctx.reply('Playback paused.');
      }
    },
    {
      name: 'resume',
      description: 'Resume music playback.',
      aliases: ['unpause'],
      async execute(ctx) {
        const queue = queues.get(ctx.guildId);
        if (!queue?.player.unpause()) return ctx.reply('Nothing is paused.');
        return ctx.reply('Playback resumed.');
      }
    },
    {
      name: 'stop',
      description: 'Stop playback and clear the queue.',
      async execute(ctx) {
        await stopQueue(ctx.guildId);
        return ctx.reply('Playback stopped and queue cleared.');
      }
    },
    {
      name: 'queue',
      description: 'Show the current music queue.',
      async execute(ctx) {
        const queue = queues.get(ctx.guildId);
        if (!queue || (!queue.current && !queue.tracks.length)) return ctx.reply('The queue is empty.');

        const lines = [];
        if (queue.current) lines.push(`Now: ${queue.current.title}`);
        queue.tracks.slice(0, 10).forEach((track, index) => lines.push(`${index + 1}. ${track.title}`));
        if (queue.tracks.length > 10) lines.push(`...and ${queue.tracks.length - 10} more`);
        return ctx.reply(lines.join('\n'));
      }
    }
  ],

  dashboard: {
    getComponent() {
      const activeQueues = Array.from(queues.values()).filter((queue) => queue.current || queue.tracks.length);
      const rows = activeQueues.map((queue) => `
        <tr>
          <td>${queue.guildId}</td>
          <td>${queue.current?.title || '-'}</td>
          <td>${queue.tracks.length}</td>
        </tr>
      `).join('');

      return {
        html: `
          <!doctype html>
          <html>
            <head>
              <style>
                body { margin: 0; padding: 16px; font-family: system-ui, sans-serif; color: #14161b; }
                table { width: 100%; border-collapse: collapse; }
                th, td { border-bottom: 1px solid #d8dde6; padding: 8px; text-align: left; }
              </style>
            </head>
            <body>
              <table>
                <thead><tr><th>Guild</th><th>Current</th><th>Queued</th></tr></thead>
                <tbody>${rows || '<tr><td colspan="3">No active queues</td></tr>'}</tbody>
              </table>
            </body>
          </html>
        `
      };
    }
  }
};
