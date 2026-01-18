import { SlashCommandBuilder } from 'discord.js';

export const askCommand = {
  data: new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask the bot a question')
    .addStringOption((option) =>
      option
        .setName('question')
        .setDescription('What do you want to ask?')
        .setRequired(true)
    )
    .addBooleanOption((option) =>
      option
        .setName('ghost')
        .setDescription('Make the response visible only to you (ghost message)')
        .setRequired(false)
    ),
};

export const pollCommand = {
  data: new SlashCommandBuilder()
    .setName('poll')
    .setDescription('Create a reaction-based poll')
    .addStringOption((option) =>
      option
        .setName('question')
        .setDescription('Poll question')
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName('options')
        .setDescription('Options separated by | (e.g., A|B|C)')
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName('duration')
        .setDescription('How long the poll runs (e.g., 30m, 2h, 1d). Default 24h')
        .setRequired(false)
    )
    .addBooleanOption((option) =>
      option
        .setName('multi')
        .setDescription('Allow multiple choices per user')
        .setRequired(false)
    ),
};

export const gifCommand = {
  data: new SlashCommandBuilder()
    .setName('gif')
    .setDescription('Search Tenor and post a GIF')
    .addStringOption((option) =>
      option
        .setName('query')
        .setDescription('What GIF to search for?')
        .setRequired(true)
    ),
};

export const memoryCommand = {
  data: new SlashCommandBuilder()
    .setName('memory')
    .setDescription('Manage your memory preferences')
    .addSubcommand((sub) => sub.setName('on').setDescription('Enable memory'))
    .addSubcommand((sub) => sub.setName('off').setDescription('Disable memory'))
    .addSubcommand((sub) => sub.setName('view').setDescription('View stored summary')),
};

export const memoryAllowCommand = {
  data: new SlashCommandBuilder()
    .setName('memory-allow')
    .setDescription('Allow memory writes in a channel')
    .setDefaultMemberPermissions(16)
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('Channel to allow')
        .setRequired(true)
    ),
};

export const memoryDenyCommand = {
  data: new SlashCommandBuilder()
    .setName('memory-deny')
    .setDescription('Deny memory writes in a channel')
    .setDefaultMemberPermissions(16)
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('Channel to deny')
        .setRequired(true)
    ),
};

export const memoryListCommand = {
  data: new SlashCommandBuilder()
    .setName('memory-list')
    .setDescription('List channels with memory permissions')
    .setDefaultMemberPermissions(16),
};

export const memoryResetGuildCommand = {
  data: new SlashCommandBuilder()
    .setName('memory-reset-guild')
    .setDescription('Reset memory for this guild')
    .setDefaultMemberPermissions(16),
};

export const memoryResetChannelCommand = {
  data: new SlashCommandBuilder()
    .setName('memory-reset-channel')
    .setDescription('Reset memory for a specific channel')
    .setDefaultMemberPermissions(16)
    .addChannelOption((option) =>
      option.setName('channel').setDescription('Channel to reset').setRequired(true)
    ),
};

export const memoryResetUserCommand = {
  data: new SlashCommandBuilder()
    .setName('memory-reset-user')
    .setDescription('Reset memory for a user')
    .setDefaultMemberPermissions(16)
    .addUserOption((option) =>
      option.setName('user').setDescription('User to reset').setRequired(true)
    ),
};

export const lobotomizeCommand = {
  data: new SlashCommandBuilder()
    .setName('lobotomize')
    .setDescription('Lobotomize yourself or everyone (forget all history)')
    .addStringOption((option) =>
      option
        .setName('scope')
        .setDescription('Who to lobotomize (default: just you)')
        .setRequired(false)
        .addChoices(
          { name: 'Just me', value: 'me' },
          { name: 'Everyone (admin only)', value: 'all' }
        )
    ),
};

export const purgeCommand = {
  data: new SlashCommandBuilder()
    .setName('purge')
    .setDescription('Delete bot messages in a channel within a time period')
    .setDefaultMemberPermissions(16)
    .addStringOption((option) =>
      option
        .setName('timeframe')
        .setDescription('Time period to purge messages from')
        .setRequired(true)
        .addChoices(
          { name: '1 hour', value: '1h' },
          { name: '6 hours', value: '6h' },
          { name: '12 hours', value: '12h' },
          { name: '24 hours', value: '24h' },
          { name: '7 days', value: '7d' },
          { name: '30 days', value: '30d' },
          { name: 'All time', value: 'all' }
        )
    )
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('Channel to purge messages from')
        .setRequired(true)
    ),
};

export const serverInfoCommand = {
  data: new SlashCommandBuilder()
    .setName('serverinfo')
    .setDescription('View server information (members, roles, etc.)'),
};

export const myDataCommand = {
  data: new SlashCommandBuilder()
    .setName('mydata')
    .setDescription('View what the bot knows about you'),
};

export const commands = [
  askCommand,
  pollCommand,
  gifCommand,
  memoryCommand,
  memoryAllowCommand,
  memoryDenyCommand,
  memoryListCommand,
  memoryResetGuildCommand,
  memoryResetChannelCommand,
  memoryResetUserCommand,
  lobotomizeCommand,
  purgeCommand,
  serverInfoCommand,
  myDataCommand,
];
