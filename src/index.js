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
  resetGuildMemory,
  resetChannelMemory,
  setUserMemory,
  forgetUser,
  viewMemory,
  getRecentMessages,
  getRecentChannelMessages,
  getChannelSummary,
  getGuildSummary,
  getGuildUserNames,
} from './memory.js';
import { getLLMResponse } from './llm.js';
import { checkRateLimit } from './rateLimit.js';
import { getReplyId, shouldHandleEdit, trackReply } from './editSync.js';
import dns from 'node:dns/promises';
import net from 'node:net';

const {
  DISCORD_TOKEN,
  GROK_BASE_URL,
  GROK_API_KEY,
  BOT_NAME = 'GrokBuddy',
  SUPER_ADMIN_USER_ID,
} = process.env;

const DISCORD_INTERACTION_EXPIRED_CODE = 10062;

function setupProcessGuards() {
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
  });
  process.on('SIGTERM', () => {
    console.log('SIGTERM received. Closing Discord client.');
    client.destroy();
  });
  process.on('SIGINT', () => {
    console.log('SIGINT received. Closing Discord client.');
    client.destroy();
  });
}

async function safeExecute(label, fn, context) {
  try {
    await fn();
  } catch (err) {
    console.error(`Handler error (${label}):`, err);

    // Attempt to notify the user that an error occurred, if we have context.
    if (!context) {
      return;
    }

    try {
      // Discord interactions (e.g. slash commands)
      if (typeof context.isRepliable === 'function' && context.isRepliable()) {
        const replyPayload = {
          content: 'An unexpected error occurred while processing your request. Please try again later.',
          ephemeral: true,
        };

        if (context.deferred || context.replied) {
          await context.followUp(replyPayload);
        } else {
          await context.reply(replyPayload);
        }
        return;
      }

      // Fallback for message-based contexts
      if (typeof context.reply === 'function') {
        await context.reply('An unexpected error occurred while processing your request. Please try again later.');
      }
    } catch (notifyErr) {
      console.error('Failed to send error response to user:', notifyErr);
    }
  }
}

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

const inMemoryTurns = new Map();
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 4;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)(\?.*)?$/i;
const IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

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
  new SlashCommandBuilder()
    .setName('memory-reset-guild')
    .setDescription('Reset memory for this guild')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('memory-reset-channel')
    .setDescription('Reset memory for a specific channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((option) =>
      option.setName('channel').setDescription('Channel to reset').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('memory-reset-user')
    .setDescription('Reset memory for a user')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption((option) =>
      option.setName('user').setDescription('User to reset').setRequired(true)
    ),
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

function isMemoryEnabledChannel(message) {
  if (isDM(message)) return true;
  return isChannelAllowed(message.channelId);
}

function containsHateSpeech(text) {
  const banned = [
    /\b(?:nazi|kkk)\b/i,
    /\b(?:faggot|tranny|nigger|cuntface)\b/i,
  ];
  return banned.some((pattern) => pattern.test(text));
}

function isImageAttachment(attachment) {
  if (!attachment?.url) return false;
  if (attachment.contentType && attachment.contentType.startsWith('image/')) {
    return true;
  }
  return IMAGE_EXT.test(attachment.url) || IMAGE_EXT.test(attachment.name || '');
}

function extractImageUrlsFromText(text) {
  if (!text) return [];
  const matches = text.match(/https:\/\/[^\s<>()]+/gi) || [];
  return matches
    .map((raw) => raw.replace(/[)>.,!?:;]+$/, ''))
    .filter((url) => IMAGE_EXT.test(url));
}

function extractImageUrlsFromEmbeds(embeds = []) {
  const urls = [];
  for (const embed of embeds) {
    if (embed?.image?.url) urls.push(embed.image.url);
    if (embed?.thumbnail?.url) urls.push(embed.thumbnail.url);
  }
  return urls;
}

function getMessageImageUrls(message) {
  const urls = [];
  for (const attachment of message.attachments?.values?.() || []) {
    if (isImageAttachment(attachment)) {
      urls.push(attachment.url);
    }
  }
  urls.push(...extractImageUrlsFromText(message.content || ''));
  urls.push(...extractImageUrlsFromEmbeds(message.embeds));
  return Array.from(new Set(urls));
}

function isPrivateIp(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    if (lower === '::1') return true;
    // Check for unique local addresses (fc00::/7 range)
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
    // Check for link-local addresses (fe80::/10 range)
    if (lower.startsWith('fe80')) return true;
  }
  return false;
}

async function isSafeHttpsUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (net.isIP(parsed.hostname) && isPrivateIp(parsed.hostname)) return false;
  if (parsed.hostname.toLowerCase() === 'localhost') return false;
  try {
    const records = await dns.lookup(parsed.hostname, { all: true });
    return records.every((record) => !isPrivateIp(record.address));
  } catch {
    return false;
  }
}

async function fetchImageAsDataUrl(url) {
  const safe = await isSafeHttpsUrl(url);
  if (!safe) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) return null;
    if (response.url && response.url !== url) {
      const redirectSafe = await isSafeHttpsUrl(response.url);
      if (!redirectSafe) return null;
    }
    const contentType = response.headers.get('content-type')?.split(';')[0] || '';
    if (!IMAGE_MIME.includes(contentType)) return null;
    const lengthHeader = response.headers.get('content-length');
    if (lengthHeader && Number(lengthHeader) > MAX_IMAGE_BYTES) return null;
    if (!response.body) return null;
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > MAX_IMAGE_BYTES) return null;
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    const base64 = buffer.toString('base64');
    return `data:${contentType};base64,${base64}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function getReplyContext(message) {
  const replyId = message.reference?.messageId;
  if (!replyId) return null;
  try {
    const referenced = await message.channel.messages.fetch(replyId);
    const text = referenced.content?.trim() || '';
    const images = getMessageImageUrls(referenced);
    return {
      author: referenced.author?.username || 'Unknown',
      text,
      images,
    };
  } catch {
    return null;
  }
}

async function handlePrompt({
  userId,
  guildId,
  channelId,
  prompt,
  reply,
  replyContextText,
  imageUrls,
  allowMemory,
  alreadyRecorded = false,
  onTyping,
  displayName,
}) {
  const rateKey = [prompt, replyContextText || '', ...(imageUrls || [])].join('|');
  const rate = checkRateLimit(userId, rateKey);
  if (!rate.allow) {
    await reply(rate.message);
    return;
  }

  if (containsHateSpeech(prompt) || containsHateSpeech(replyContextText || '')) {
    await reply('nah, not touching that.');
    return;
  }

  const settings = getUserSettings(userId);
  if (settings.memory_enabled && allowMemory && !alreadyRecorded) {
    let memoryContent = prompt || '';
    if (!memoryContent && imageUrls?.length) {
      memoryContent = `User sent ${imageUrls.length} image(s).`;
    } else if (imageUrls?.length) {
      memoryContent = `${memoryContent} [shared ${imageUrls.length} image(s)]`;
    }
    if (!memoryContent && replyContextText) {
      memoryContent = 'User replied to a message.';
    }
    recordUserMessage({
      userId,
      channelId,
      guildId,
      content: memoryContent,
      displayName,
    });
  }

  const profileSummary = allowMemory ? getProfileSummary(userId) : '';
  const recentUserMessages = allowMemory ? getRecentMessages(userId, 3) : [];
  const recentChannelMessages =
    allowMemory && channelId ? getRecentChannelMessages(channelId, userId, 3) : [];
  const channelSummary =
    allowMemory && channelId ? getChannelSummary(channelId) : '';
  const guildSummary = allowMemory && guildId ? getGuildSummary(guildId) : '';
  const knownUsers = allowMemory && guildId ? getGuildUserNames(guildId, 12) : [];
  const imageInputs = [];
  if (imageUrls?.length) {
    for (const url of imageUrls.slice(0, MAX_IMAGES)) {
      const dataUrl = await fetchImageAsDataUrl(url);
      if (dataUrl) imageInputs.push(dataUrl);
    }
  }
  
  // Determine effective prompt for the LLM
  let effectivePrompt = prompt;
  if (!effectivePrompt && imageInputs.length > 0) {
    effectivePrompt = 'User sent an image.';
  } else if (!effectivePrompt && replyContextText) {
    effectivePrompt = 'Following up on the replied message.';
  }
  
  const recentTurns = allowMemory
    ? addTurn(userId, 'user', effectivePrompt || '...')
    : [];
  if (onTyping) {
    await onTyping();
  }
  const response = await getLLMResponse({
    botName: BOT_NAME,
    profileSummary,
    recentTurns,
    userContent: effectivePrompt,
    replyContext: replyContextText,
    imageInputs,
    recentUserMessages,
    recentChannelMessages,
    channelSummary,
    guildSummary,
    knownUsers,
  });
  if (allowMemory) {
    addTurn(userId, 'assistant', response);
  }
  await reply(response);
}

client.on('messageCreate', async (message) => {
  await safeExecute('messageCreate', async () => {
    if (message.author.bot) return;
    const isDirect = isDM(message);
    const memoryChannel = isMemoryEnabledChannel(message);
    const settings = getUserSettings(message.author.id);
    const allowMemoryContext = memoryChannel && settings.memory_enabled;
    const displayName = message.member?.displayName || message.author.username;
    
    // Passively record messages in allowlisted channels only from users who have memory enabled
    if (allowMemoryContext && message.content && message.content.trim()) {
      recordUserMessage({
        userId: message.author.id,
        channelId: message.channelId,
        guildId: message.guildId,
        content: message.content,
        displayName,
      });
    }

    const mentioned = message.mentions.has(client.user);
    if (!isDirect && !mentioned) return;

    const content = isDirect ? message.content.trim() : stripMention(message.content);
    const replyContext = await getReplyContext(message);
    const replyContextText = replyContext
      ? `Reply context from ${replyContext.author}: ${replyContext.text || '[no text]'}`
      : '';
    const imageUrls = [
      ...getMessageImageUrls(message),
      ...(replyContext?.images || []),
    ];
    if (!content && !imageUrls.length && !replyContextText) return;

    const replyFn = async (text) => {
      const sent = await message.reply({ content: text });
      trackReply({ userMessageId: message.id, botReplyId: sent.id });
    };
    const typingFn = async () => {
      await message.channel.sendTyping();
    };

    await handlePrompt({
      userId: message.author.id,
      guildId: message.guildId,
      channelId: message.channelId,
      prompt: content,
      reply: replyFn,
      replyContextText,
      imageUrls,
      allowMemory: allowMemoryContext,
      alreadyRecorded: allowMemoryContext,
      onTyping: typingFn,
      displayName,
    });
  });
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
  await safeExecute('messageUpdate', async () => {
    if (!newMessage) return;
    const hydrated = newMessage.partial ? await newMessage.fetch() : newMessage;
    if (hydrated.author?.bot) return;

    const isDirect = isDM(hydrated);
    const memoryChannel = isMemoryEnabledChannel(hydrated);
    const settings = getUserSettings(hydrated.author.id);
    const allowMemoryContext = memoryChannel && settings.memory_enabled;
    const displayName = hydrated.member?.displayName || hydrated.author.username;

    // Passively record edited messages in allowlisted channels
    if (allowMemoryContext && hydrated.content && hydrated.content.trim()) {
      recordUserMessage({
        userId: hydrated.author.id,
        channelId: hydrated.channelId,
        guildId: hydrated.guildId,
        content: hydrated.content,
        displayName,
      });
    }

    if (!shouldHandleEdit(hydrated.id)) return;

    const mentioned = hydrated.mentions.has(client.user);
    if (!isDirect && !mentioned) return;

    const content = isDirect
      ? hydrated.content.trim()
      : stripMention(hydrated.content);
    const replyContext = await getReplyContext(hydrated);
    const replyContextText = replyContext
      ? `Reply context from ${replyContext.author}: ${replyContext.text || '[no text]'}`
      : '';
    const imageUrls = [
      ...getMessageImageUrls(hydrated),
      ...(replyContext?.images || []),
    ];
    if (!content && !imageUrls.length && !replyContextText) return;

    const replyId = getReplyId(hydrated.id);
    if (!replyId) return;

    const replyFn = async (text, isEdit = false) => {
      const messageToEdit = await hydrated.channel.messages.fetch(replyId);
      await messageToEdit.edit({ content: text });
    };
    const typingFn = async () => {
      await hydrated.channel.sendTyping();
    };

    await handlePrompt({
      userId: hydrated.author.id,
      guildId: hydrated.guildId,
      channelId: hydrated.channelId,
      prompt: content,
      reply: replyFn,
      replyContextText,
      imageUrls,
      allowMemory: allowMemoryContext,
      alreadyRecorded: allowMemoryContext,
      onTyping: typingFn,
      displayName,
    });
  });
});

client.on('interactionCreate', async (interaction) => {
  await safeExecute('interactionCreate', async () => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;
    const isSuperAdmin = interaction.user.id === SUPER_ADMIN_USER_ID;
    const hasAdminPerms =
      isSuperAdmin || interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);

    if (commandName === 'ask') {
      const question = interaction.options.getString('question', true);
      const settings = getUserSettings(interaction.user.id);
      const memoryChannel = interaction.channel?.isDMBased?.()
        ? true
        : isChannelAllowed(interaction.channelId);
      const allowMemoryContext = memoryChannel && settings.memory_enabled;
      const displayName =
        interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
      const replyFn = async (text) => {
        try {
          if (interaction.deferred) {
            await interaction.editReply({ content: text });
          } else if (interaction.replied) {
            await interaction.followUp({ content: text });
          } else {
            await interaction.reply({ content: text });
          }
        } catch (err) {
          if (err.code === DISCORD_INTERACTION_EXPIRED_CODE) {
            console.error('Failed to send reply: Interaction expired before response could be sent');
          } else {
            throw err;
          }
        }
      };
      const typingFn = async () => {
        try {
          if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply();
          }
        } catch (err) {
          if (err.code === DISCORD_INTERACTION_EXPIRED_CODE) {
            console.error('Failed to defer reply: Interaction expired before deferReply could be called');
          } else {
            throw err;
          }
        }
      };

      // Passively record /ask messages in allowlisted channels
      if (allowMemoryContext && question && question.trim()) {
        recordUserMessage({
          userId: interaction.user.id,
          channelId: interaction.channelId,
          guildId: interaction.guildId,
          content: question,
          displayName,
        });
      }

      await handlePrompt({
        userId: interaction.user.id,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        prompt: question,
        reply: replyFn,
        replyContextText: '',
        imageUrls: [],
        allowMemory: allowMemoryContext,
        alreadyRecorded: allowMemoryContext,
        onTyping: typingFn,
        displayName,
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
      if (!hasAdminPerms) {
        await interaction.reply({ content: 'Admin only.', ephemeral: true });
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
      if (!hasAdminPerms) {
        await interaction.reply({ content: 'Admin only.', ephemeral: true });
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
      if (!hasAdminPerms) {
        await interaction.reply({ content: 'Admin only.', ephemeral: true });
        return;
      }
      const allRows = listChannels();
      // Filter to only show channels from the current guild
      const guild = interaction.guild;
      const guildChannelIds = new Set(guild.channels.cache.keys());
      const rows = allRows.filter((row) => guildChannelIds.has(row.channel_id));
      
      if (!rows.length) {
        await interaction.reply({ content: 'No channels configured in this guild.' });
        return;
      }
      const formatted = rows
        .map((row) => `• <#${row.channel_id}>: ${row.enabled ? 'allowed' : 'denied'}`)
        .join('\n');
      await interaction.reply({ content: formatted });
    }

    if (commandName === 'memory-reset-guild') {
      if (!interaction.inGuild() && !isSuperAdmin) {
        await interaction.reply({ content: 'Guilds only.', ephemeral: true });
        return;
      }
      if (!hasAdminPerms) {
        await interaction.reply({ content: 'Admin only.', ephemeral: true });
        return;
      }
      resetGuildMemory(interaction.guildId);
      await interaction.reply({ content: 'Guild memory reset.' });
    }

    if (commandName === 'memory-reset-channel') {
      if (!interaction.inGuild() && !isSuperAdmin) {
        await interaction.reply({ content: 'Guilds only.', ephemeral: true });
        return;
      }
      if (!hasAdminPerms) {
        await interaction.reply({ content: 'Admin only.', ephemeral: true });
        return;
      }
      const channel = interaction.options.getChannel('channel', true);
      resetChannelMemory(channel.id);
      await interaction.reply({ content: `Memory reset for <#${channel.id}>.` });
    }

    if (commandName === 'memory-reset-user') {
      if (!interaction.inGuild() && !isSuperAdmin) {
        await interaction.reply({ content: 'Guilds only.', ephemeral: true });
        return;
      }
      if (!hasAdminPerms) {
        await interaction.reply({ content: 'Admin only.', ephemeral: true });
        return;
      }
      const user = interaction.options.getUser('user', true);
      forgetUser(user.id);
      await interaction.reply({ content: `Memory reset for ${user.username}. This action has been logged.` });
      
      // Attempt to notify the user via DM
      try {
        await user.send(
          `Your conversation memory and personality profile have been reset by an administrator in ${interaction.guild.name}.`
        );
      } catch (dmErr) {
        // User may have DMs disabled or blocked the bot, which is fine
        console.log(`Could not send DM to user ${user.username} about memory reset:`, dmErr.message);
      }
    }
  });
});

client.once('ready', async () => {
  await safeExecute('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    await registerCommands();
  });
});

setupProcessGuards();
client.login(DISCORD_TOKEN);
