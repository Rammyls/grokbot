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
import dns from 'node:dns/promises';
import net from 'node:net';

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
    // Normalize to lowercase for consistent checking
    const normalized = address.toLowerCase();
    
    // Parse the IPv6 address to handle various representations
    // For loopback, check common representations
    if (normalized === '::1' || 
        normalized === '0:0:0:0:0:0:0:1' ||
        normalized === '0000:0000:0000:0000:0000:0000:0000:0001') {
      return true;
    }
    
    // For other private ranges, we need to check if they START with the private prefix
    // Unique Local Addresses (ULA): fc00::/7 and Link-local: fe80::/10
    
    // Split the address into segments
    const segments = normalized.split(':');
    
    // If the address starts with '::', the first actual segment is at index 0 or 1
    // but represents zeros. We need the first NON-ZERO segment that's actually first.
    // However, if it starts with '::' followed by something, that something is NOT
    // the first segment of the expanded address.
    
    // Check if it starts with fc, fd, or fe80 (not preceded by ::)
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) {
      // Extract first segment to validate it's in the right range
      const firstSegment = segments[0];
      if (firstSegment) {
        const firstHex = parseInt(firstSegment, 16);
        if (!isNaN(firstHex) && firstHex >= 0xfc00 && firstHex <= 0xfdff) {
          return true;
        }
      }
    }
    
    if (normalized.startsWith('fe')) {
      const firstSegment = segments[0];
      if (firstSegment) {
        const firstHex = parseInt(firstSegment, 16);
        // Link-local: fe80::/10 covers fe80-febf
        if (!isNaN(firstHex) && firstHex >= 0xfe80 && firstHex <= 0xfebf) {
          return true;
        }
      }
    }
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
  channelId,
  prompt,
  reply,
  isDirect,
  replyContextText,
  imageUrls,
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
  const allowed = isAllowedToStore(channelId, isDirect);
  if (settings.memory_enabled && allowed) {
    let memoryContent = prompt;
    if (!memoryContent && imageUrls?.length) {
      memoryContent = 'User sent an image.';
    }
    if (!memoryContent && replyContextText) {
      memoryContent = 'User replied to a message.';
    }
    if (imageUrls?.length && memoryContent && !/\bimage\b/i.test(memoryContent)) {
      memoryContent = `${memoryContent} [shared ${imageUrls.length} image(s)]`;
    }
    recordUserMessage({ userId, channelId, content: memoryContent });
  }

  const profileSummary = getProfileSummary(userId);
  const imageInputs = [];
  if (imageUrls?.length) {
    for (const url of imageUrls.slice(0, MAX_IMAGES)) {
      const dataUrl = await fetchImageAsDataUrl(url);
      if (dataUrl) imageInputs.push(dataUrl);
    }
  }
  let effectivePrompt;
  if (typeof prompt === 'string' && prompt !== '') {
    effectivePrompt = prompt;
  } else if (imageInputs.length > 0) {
    effectivePrompt = 'User sent an image.';
  } else if (typeof replyContextText === 'string' && replyContextText.trim() !== '') {
    effectivePrompt = 'Following up on the replied message.';
  } else {
    effectivePrompt = '';
  }
  const recentTurns = effectivePrompt
    ? addTurn(userId, 'user', effectivePrompt)
    : addTurn(userId, 'user', '...');
  const response = await getLLMResponse({
    botName: BOT_NAME,
    profileSummary,
    recentTurns,
    userContent: effectivePrompt,
    replyContext: replyContextText,
    imageInputs,
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

  await handlePrompt({
    userId: message.author.id,
    channelId: message.channelId,
    prompt: content,
    reply: replyFn,
    isDirect,
    replyContextText,
    imageUrls,
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

  await handlePrompt({
    userId: hydrated.author.id,
    channelId: hydrated.channelId,
    prompt: content,
    reply: replyFn,
    isDirect,
    replyContextText,
    imageUrls,
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
      replyContextText: '',
      imageUrls: [],
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
