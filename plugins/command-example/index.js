module.exports = {
  defaultConfig: {
    greeting: 'Hello',
    allowEcho: true,
    echoPrefix: 'Echo'
  },

  commands: [
    {
      name: 'hello',
      description: 'Send a configurable greeting.',
      aliases: ['hi'],
      cooldownMs: 1500,
      options: [
        {
          name: 'name',
          description: 'Name to greet',
          type: 'string',
          required: false
        }
      ],
      async execute(ctx) {
        const name = ctx.options.name || ctx.args.join(' ') || ctx.user.username || 'there';
        const greeting = ctx.configManager.getPluginConfig('command-example', 'greeting', 'Hello');
        return ctx.reply(`${greeting}, ${name}.`);
      }
    },
    {
      name: 'echo',
      description: 'Echo text back with Manage Messages permission.',
      cooldownMs: 1000,
      permissions: {
        user: ['ManageMessages']
      },
      options: [
        {
          name: 'text',
          description: 'Text to echo',
          type: 'string',
          required: true
        }
      ],
      async execute(ctx) {
        if (!ctx.configManager.getPluginConfig('command-example', 'allowEcho', true)) {
          return ctx.reply('Echo is disabled in this plugin config.');
        }

        const text = ctx.options.text || ctx.args.join(' ');
        if (!text) return ctx.reply('Nothing to echo.');

        const prefix = ctx.configManager.getPluginConfig('command-example', 'echoPrefix', 'Echo');
        return ctx.reply(`${prefix}: ${text}`);
      }
    }
  ],

  dashboard: {
    getComponent(ctx) {
      const greeting = ctx.getConfig('greeting', 'Hello');
      const allowEcho = ctx.getConfig('allowEcho', true);
      return {
        html: `
          <!doctype html>
          <html>
            <head>
              <style>
                body { margin: 0; padding: 16px; font-family: system-ui, sans-serif; color: #14161b; }
                dl { display: grid; grid-template-columns: max-content 1fr; gap: 8px 12px; }
                dt { font-weight: 700; }
                dd { margin: 0; }
              </style>
            </head>
            <body>
              <dl>
                <dt>Greeting</dt><dd>${greeting}</dd>
                <dt>Echo</dt><dd>${allowEcho ? 'Enabled' : 'Disabled'}</dd>
              </dl>
            </body>
          </html>
        `
      };
    }
  }
};
