import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import {
  allowChannel,
  denyChannel,
  getProfileSummary,
  getUserSettings,
  isChannelAllowed,
  listChannels,
  recordUserMessage,
  setUserMemory,
  forgetUser,
  viewMemory,
} from './memory.js';
import { getLLMResponse } from './llm.js';
import { checkRateLimit } from './rateLimit.js';
import { getReplyId, shouldHandleEdit, trackReply } from './editSync.js';

const {
  DISCORD_TOKEN,
  GROK_BASE_URL,
  GROK_API_KEY,
  BOT_NAME = 'GrokBuddy',
  SUPER_ADMIN_USER_ID,
} = process.env;

if (!DISCORD_TOKEN || !GROK_BASE_URL || !GROK_API_KEY) {
  console.error('Missing required env vars. Check README.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

const MAX_IN_MEMORY_TURNS = 1000;

class BoundedMap extends Map {
  constructor(maxSize) {
    super();
    this.maxSize = maxSize;
  }

  set(key, value) {
    // If key already exists, delete it first so that the reinsertion
    // updates its recency while keeping overall behavior consistent.
    if (this.has(key)) {
      super.delete(key);
    }

    super.set(key, value);

    if (this.size > this.maxSize) {
      const firstKey = this.keys().next().value;
      if (firstKey !== undefined) {
        super.delete(firstKey);
      }
    }

    return this;
  }
}

const inMemoryTurns = new BoundedMap(MAX_IN_MEMORY_TURNS);

const slashCommands = [
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask the bot a question')
    .addStringOption((option) =>
      option
        .setName('question')
        .setDescription('What do you want to ask?')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('memory')
    .setDescription('Manage your memory preferences')
    .addSubcommand((sub) => sub.setName('on').setDescription('Enable memory'))
    .addSubcommand((sub) => sub.setName('off').setDescription('Disable memory'))
    .addSubcommand((sub) => sub.setName('forget').setDescription('Forget your history'))
    .addSubcommand((sub) => sub.setName('view').setDescription('View stored summary')),
  new SlashCommandBuilder()
    .setName('memory-allow')
    .setDescription('Allow memory writes in a channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('Channel to allow')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('memory-deny')
    .setDescription('Deny memory writes in a channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('Channel to deny')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('memory-list')
    .setDescription('List channels with memory permissions')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
].map((cmd) => cmd.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), {
    body: slashCommands,
  });
  console.log('Slash commands registered.');
}

function stripMention(content) {
  if (!client.user) return content;
  const regex = new RegExp(`<@!?${client.user.id}>`, 'g');
  return content.replace(regex, '').trim();
}

function addTurn(userId, role, content) {
  const turns = inMemoryTurns.get(userId) || [];
  const updated = [...turns, { role, content }].slice(-6);
  inMemoryTurns.set(userId, updated);
  return updated;
}

function isDM(message) {
  return message.channel?.isDMBased?.() || message.guildId === null;
}

function isAllowedToStore(channelId, dm) {
  if (dm) return true;
  return isChannelAllowed(channelId);
}

function containsHateSpeech(text) {
  const banned = [
    /\b(?:nazi|kkk)\b/i,
    /\b(?:faggot|tranny|nigger|cuntface)\b/i,
  ];
  return banned.some((pattern) => pattern.test(text));
}

async function handlePrompt({
  userId,
  channelId,
  prompt,
  reply,
  isDirect,
}) {
  const rate = checkRateLimit(userId, prompt);
  if (!rate.allow) {
    await reply(rate.message);
    return;
  }

  if (containsHateSpeech(prompt)) {
    await reply('nah, not touching that.');
    return;
  }

  const settings = getUserSettings(userId);
  const allowed = isAllowedToStore(channelId, isDirect);
  if (settings.memory_enabled && allowed) {
    recordUserMessage({ userId, channelId, content: prompt });
  }

  const recentTurns = addTurn(userId, 'user', prompt);
  const profileSummary = getProfileSummary(userId);
  const response = await getLLMResponse({
    botName: BOT_NAME,
    profileSummary,
    recentTurns,
    userContent: prompt,
  });
  addTurn(userId, 'assistant', response);
  await reply(response);
}

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  const isDirect = isDM(message);
  const mentioned = message.mentions.has(client.user);
  if (!isDirect && !mentioned) return;

  const content = isDirect ? message.content.trim() : stripMention(message.content);
  if (!content) return;

  const replyFn = async (text) => {
    const sent = await message.reply({ content: text });
    trackReply({ userMessageId: message.id, botReplyId: sent.id });
  };

  await handlePrompt({
    userId: message.author.id,
    channelId: message.channelId,
    prompt: content,
    reply: replyFn,
    isDirect,
  });
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
  if (!newMessage) return;
  const hydrated = newMessage.partial ? await newMessage.fetch() : newMessage;
  if (hydrated.author?.bot) return;
  if (!shouldHandleEdit(hydrated.id)) return;

  const isDirect = isDM(hydrated);
  const mentioned = hydrated.mentions.has(client.user);
  if (!isDirect && !mentioned) return;

  const content = isDirect
    ? hydrated.content.trim()
    : stripMention(hydrated.content);
  if (!content) return;

  const replyId = getReplyId(hydrated.id);
  if (!replyId) return;

  const replyFn = async (text) => {
    const messageToEdit = await hydrated.channel.messages.fetch(replyId);
    await messageToEdit.edit({ content: text });
  };

  await handlePrompt({
    userId: hydrated.author.id,
    channelId: hydrated.channelId,
    prompt: content,
    reply: replyFn,
    isDirect,
  });
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;
  const isSuperAdmin = interaction.user.id === SUPER_ADMIN_USER_ID;

  if (commandName === 'ask') {
    const question = interaction.options.getString('question', true);
    const replyFn = async (text) => {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: text });
      } else {
        await interaction.reply({ content: text });
      }
    };

    await handlePrompt({
      userId: interaction.user.id,
      channelId: interaction.channelId,
      prompt: question,
      reply: replyFn,
      isDirect: interaction.channel?.isDMBased?.() ?? false,
    });
  }

  if (commandName === 'memory') {
    const sub = interaction.options.getSubcommand();
    if (sub === 'on') {
      setUserMemory(interaction.user.id, true);
      await interaction.reply({ content: 'Memory is on.' });
    }
    if (sub === 'off') {
      setUserMemory(interaction.user.id, false);
      await interaction.reply({ content: 'Memory is off.' });
    }
    if (sub === 'forget') {
      forgetUser(interaction.user.id);
      await interaction.reply({ content: 'Memory wiped.' });
    }
    if (sub === 'view') {
      const summary = viewMemory(interaction.user.id);
      await interaction.reply({ content: summary });
    }
  }

  if (commandName === 'memory-allow') {
    if (!interaction.inGuild() && !isSuperAdmin) {
      await interaction.reply({ content: 'Guilds only.', ephemeral: true });
      return;
    }
    const channel = interaction.options.getChannel('channel', true);
    allowChannel(channel.id);
    await interaction.reply({ content: `Allowed memory in <#${channel.id}>.` });
  }

  if (commandName === 'memory-deny') {
    if (!interaction.inGuild() && !isSuperAdmin) {
      await interaction.reply({ content: 'Guilds only.', ephemeral: true });
      return;
    }
    const channel = interaction.options.getChannel('channel', true);
    denyChannel(channel.id);
    await interaction.reply({ content: `Denied memory in <#${channel.id}>.` });
  }

  if (commandName === 'memory-list') {
    if (!interaction.inGuild() && !isSuperAdmin) {
      await interaction.reply({ content: 'Guilds only.', ephemeral: true });
      return;
    }
    const rows = listChannels();
    if (!rows.length) {
      await interaction.reply({ content: 'No channels configured.' });
      return;
    }
    const formatted = rows
      .map((row) => `• <#${row.channel_id}>: ${row.enabled ? 'allowed' : 'denied'}`)
      .join('\n');
    await interaction.reply({ content: formatted });
  }
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
});

client.login(DISCORD_TOKEN);
