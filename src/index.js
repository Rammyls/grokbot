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
  trackBotMessage,
  getBotMessagesInChannel,
  deleteBotMessageRecord,
} from './memory.js';
import {
  createPoll,
  getPollByMessageId,
  listOpenPolls,
  recordVote,
  removeVote,
  tallyVotes,
  closePoll,
} from './polls.js';
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
  TENOR_API_KEY,
} = process.env;

const DISCORD_INTERACTION_EXPIRED_CODE = 10062;
const DISCORD_UNKNOWN_MESSAGE_CODE = 10008;
const DISCORD_BULK_DELETE_LIMIT = 100;

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
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});

const inMemoryTurns = new Map();
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 4;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)(\?.*)?$/i;
const IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const VIDEO_EXT = /\.(mp4|mov|webm|mkv|m4v)(\?.*)?$/i;
const VIDEO_MIME_PREFIXES = ['video/'];
const NUMBER_EMOJIS = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
const pollTimers = new Map(); // messageId -> timeoutId

function parseDuration(input) {
  if (!input) return 24 * 60 * 60 * 1000; // default 24h
  const m = String(input).trim().match(/^(\d+)(m|h|d)$/i);
  if (!m) return 24 * 60 * 60 * 1000;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  if (unit === 'm') return n * 60 * 1000;
  if (unit === 'h') return n * 60 * 60 * 1000;
  if (unit === 'd') return n * 24 * 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}

function parseQuotedPoll(text) {
  // Example: poll "Question" "A" "B" --duration 2h
  const match = text.match(/poll\s+((?:\"[^\"]+\"\s*)+)(?:--duration\s+(\S+))?/i);
  if (!match) return null;
  const quoted = Array.from(match[1].matchAll(/\"([^\"]+)\"/g)).map(m => m[1]);
  if (quoted.length < 3) return null; // question + at least 2 options
  const question = quoted[0];
  const options = quoted.slice(1).slice(0, 10);
  const duration = parseDuration(match[2] || '24h');
  return { question, options, duration, multi: false };
}

async function schedulePollClosure(messageId, closeAt) {
  const delayMs = Math.max(0, closeAt - Date.now());
  if (pollTimers.has(messageId)) {
    clearTimeout(pollTimers.get(messageId));
  }
  const t = setTimeout(async () => {
    try {
      const poll = getPollByMessageId(messageId);
      if (!poll || poll.closed) return;
      const channel = await client.channels.fetch(poll.channel_id);
      await postPollResults(poll, channel);
      closePoll(poll.id);
    } catch (e) {
      console.error('Failed to auto-close poll', e);
    } finally {
      pollTimers.delete(messageId);
    }
  }, delayMs);
  pollTimers.set(messageId, t);
}

async function postPollResults(poll, channel) {
  const options = JSON.parse(poll.options_json);
  const counts = tallyVotes(poll.id, options.length);
  const total = counts.reduce((a, b) => a + b, 0);
  const lines = options.map((opt, i) => `${NUMBER_EMOJIS[i]} ${opt} — ${counts[i]} vote${counts[i] === 1 ? '' : 's'}`);
  const header = `📊 Poll closed: ${poll.question}`;
  const footer = `Total votes: ${total}`;
  await channel.send({ content: `${header}\n\n${lines.join('\n')}\n\n${footer}` });
}

const slashCommands = [
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask the bot a question')
    .addStringOption((option) =>
      option
        .setName('question')
        .setDescription('What do you want to ask?')
        .setDMPermission(true)
        .setRequired(true)
    )
    .addBooleanOption((option) =>
      option
        .setName('ghost')
        .setDescription('Make the response visible only to you (ghost message)')
        .setRequired(false)
    ),
  new SlashCommandBuilder()
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
  new SlashCommandBuilder()
    .setName('gif')
    .setDescription('Search Tenor and post a GIF')
    .addStringOption((option) =>
      option
        .setName('query')
        .setDescription('What GIF to search for?')
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
  new SlashCommandBuilder()
    .setName('purge')
    .setDescription('Delete bot messages in a channel within a time period')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
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
].map((cmd) => cmd.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), {
    body: slashCommands,
  });
  console.log('Slash commands registered.');
}

async function searchTenorGif(query) {
  if (!TENOR_API_KEY) {
    console.warn('TENOR_API_KEY not set — Tenor GIFs disabled');
    return null;
  }
  try {
    const url = new URL('https://tenor.googleapis.com/v2/search');
    url.searchParams.set('q', query);
    url.searchParams.set('key', TENOR_API_KEY);
    url.searchParams.set('limit', '1');
    url.searchParams.set('media_filter', 'gif');
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) return null;
    const data = await res.json();
    const item = data?.results?.[0];
    const direct = item?.media_formats?.gif?.url || item?.media_formats?.tinygif?.url || null;
    return direct;
  } catch (err) {
    console.error('Tenor API search failed:', err);
    return null;
  }
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

function isVideoAttachment(attachment) {
  if (!attachment?.url) return false;
  if (attachment.contentType && VIDEO_MIME_PREFIXES.some((p) => attachment.contentType.startsWith(p))) {
    return true;
  }
  return VIDEO_EXT.test(attachment.url) || VIDEO_EXT.test(attachment.name || '');
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

function getMessageVideoUrls(message) {
  const urls = [];
  for (const attachment of message.attachments?.values?.() || []) {
    if (isVideoAttachment(attachment)) {
      urls.push(attachment.url);
    }
  }
  // Basic extraction from text (file links with video extensions)
  if (message.content) {
    const matches = message.content.match(/https:\/\/[^\s<>()]+/gi) || [];
    for (const raw of matches) {
      const url = raw.replace(/[)>.,!?:;]+$/, '');
      if (VIDEO_EXT.test(url)) urls.push(url);
    }
  }
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
  const resolved = await resolveDirectMediaUrl(url);
  const finalUrl = resolved || url;
  const safe = await isSafeHttpsUrl(finalUrl);
  if (!safe) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(finalUrl, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) return null;
    if (response.url && response.url !== finalUrl) {
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

function parseGiphyIdFromUrl(u) {
  try {
    const url = new URL(u);
    if (!/giphy\.com$/i.test(url.hostname) && !/media\.giphy\.com$/i.test(url.hostname)) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'media' && parts[1]) return parts[1];
    if (parts[0] === 'gifs' && parts[1]) {
      const m = parts[1].match(/-([A-Za-z0-9]+)$/);
      if (m) return m[1];
    }
    return null;
  } catch {
    return null;
  }
}

function buildGiphyDirectUrl(id) {
  return `https://media.giphy.com/media/${id}/giphy.gif`;
}

async function resolveTenorDirect(u) {
  try {
    const url = new URL(u);
    if (!/tenor\.com$/i.test(url.hostname)) return null;
  } catch {
    return null;
  }
  if (!TENOR_API_KEY) {
    console.warn('TENOR_API_KEY not set — Tenor URL resolution disabled');
    return null;
  }
  try {
    let q = '';
    try {
      const pathSegs = new URL(u).pathname.split('/').filter(Boolean);
      q = decodeURIComponent(pathSegs[pathSegs.length - 1] || '');
    } catch {}
    if (!q) return null;
    const searchUrl = new URL('https://tenor.googleapis.com/v2/search');
    searchUrl.searchParams.set('q', q.replace(/[-_]/g, ' '));
    searchUrl.searchParams.set('key', TENOR_API_KEY);
    searchUrl.searchParams.set('limit', '1');
    searchUrl.searchParams.set('media_filter', 'gif');
    const resp = await fetch(searchUrl);
    if (!resp.ok) return null;
    const data = await resp.json();
    const item = data?.results?.[0];
    const direct = item?.media_formats?.gif?.url || item?.media_formats?.tinygif?.url || null;
    return direct || null;
  } catch (err) {
    console.error('Tenor direct resolution failed:', err);
    return null;
  }
}

async function resolveDirectMediaUrl(u) {
  if (IMAGE_EXT.test(u)) return u;
  const giphyId = parseGiphyIdFromUrl(u);
  if (giphyId) return buildGiphyDirectUrl(giphyId);
  const tenor = await resolveTenorDirect(u);
  if (tenor) return tenor;
  return null;
}

async function getReplyContext(message) {
  const replyId = message.reference?.messageId;
  if (!replyId) return null;
  try {
    const referenced = await message.channel.messages.fetch(replyId);
    const text = referenced.content?.trim() || '';
    const images = getMessageImageUrls(referenced);
    const videos = getMessageVideoUrls(referenced);
    return {
      author: referenced.author?.username || 'Unknown',
      text,
      images,
      videos,
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
  videoUrls,
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
  } else if (!effectivePrompt && (videoUrls?.length || (replyContextText && replyContextText.includes('video')))) {
    effectivePrompt = 'User referenced a video.';
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
    // Inline poll creation when mentioned with quoted syntax
    if (mentioned) {
      const parsed = parseQuotedPoll(content);
      if (parsed) {
        const { question, options, duration } = parsed;
        if (options.length < 2) {
          await message.reply('Need at least two options.');
          return;
        }
        if (options.length > NUMBER_EMOJIS.length) {
          await message.reply(`Max ${NUMBER_EMOJIS.length} options.`);
          return;
        }
        const closeAt = Date.now() + duration;
        const pollMsg = await message.channel.send({
          content: `📊 ${question}\n\n${options.map((o, i) => `${NUMBER_EMOJIS[i]} ${o}`).join('\n')}\n\n⏳ closes <t:${Math.floor(closeAt/1000)}:R>`
        });
        trackBotMessage(pollMsg.id, pollMsg.channelId, pollMsg.guildId);
        for (let i = 0; i < options.length; i++) {
          await pollMsg.react(NUMBER_EMOJIS[i]);
        }
        createPoll({
          guildId: pollMsg.guildId || null,
          channelId: pollMsg.channelId,
          messageId: pollMsg.id,
          creatorId: message.author.id,
          question,
          options,
          multiVote: false,
          anonymous: false,
          closesAt: closeAt,
        });
        schedulePollClosure(pollMsg.id, closeAt);
        return;
      }
    }
    const replyContext = await getReplyContext(message);
    const replyContextText = replyContext
      ? `Reply context from ${replyContext.author}: ${replyContext.text || '[no text]'}${(replyContext.videos?.length ? ' [video referenced]' : '')}`
      : '';
    const imageUrls = [
      ...getMessageImageUrls(message),
      ...(replyContext?.images || []),
    ];
    const videoUrls = [
      ...getMessageVideoUrls(message),
      ...(replyContext?.videos || []),
    ];
    if (!content && !imageUrls.length && !replyContextText) return;

    const replyFn = async (text) => {
      const sent = await message.reply({ content: text });
      trackReply({ userMessageId: message.id, botReplyId: sent.id });
      trackBotMessage(sent.id, message.channelId, message.guildId);
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
      videoUrls,
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
      videoUrls: [],
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
      const isDM = interaction.channel?.isDMBased?.();
      const ghost = !isDM && (interaction.options.getBoolean('ghost') ?? true);
      const ghost = interaction.options.getBoolean('ghost') ?? true; // Default to true (ephemeral)
      const settings = getUserSettings(interaction.user.id);
      const memoryChannel = interaction.channel?.isDMBased?.()
        ? true
        : isChannelAllowed(interaction.channelId);
      const allowMemoryContext = memoryChannel && settings.memory_enabled;
      const displayName =
        interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
      const replyFn = async (text) => {
        try {
          let reply;
          if (interaction.deferred) {
            reply = await interaction.editReply({ content: text });
          } else if (interaction.replied) {
            reply = await interaction.followUp({ content: text, ephemeral: ghost });
          } else {
            reply = await interaction.reply({ content: text, ephemeral: ghost });
          }
          // Track bot message for purge functionality (only track non-ephemeral messages)
          if (reply?.id && !ghost) {
            trackBotMessage(reply.id, interaction.channelId, interaction.guildId);
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
            await interaction.deferReply({ ephemeral: ghost });
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

    if (commandName === 'poll') {
      const question = interaction.options.getString('question', true);
      const optionsRaw = interaction.options.getString('options', true);
      const durationStr = interaction.options.getString('duration') || '24h';
      const multi = interaction.options.getBoolean('multi') || false;

      const options = optionsRaw.split('|').map((s) => s.trim()).filter(Boolean).slice(0, NUMBER_EMOJIS.length);
      if (options.length < 2) {
        await interaction.reply({ content: 'Need at least two options (use \'A|B|C\').', ephemeral: true });
        return;
      }

      const durationMs = parseDuration(durationStr);
      const closeAt = Date.now() + durationMs;
      await interaction.deferReply({ ephemeral: true });
      const channel = interaction.channel;
      const pollMsg = await channel.send({
        content: `📊 ${question}\n\n${options.map((o, i) => `${NUMBER_EMOJIS[i]} ${o}`).join('\n')}\n\n⏳ closes <t:${Math.floor(closeAt/1000)}:R>`
      });
      trackBotMessage(pollMsg.id, pollMsg.channelId, pollMsg.guildId);
      for (let i = 0; i < options.length; i++) {
        await pollMsg.react(NUMBER_EMOJIS[i]);
      }
      const row = createPoll({
        guildId: pollMsg.guildId || null,
        channelId: pollMsg.channelId,
        messageId: pollMsg.id,
        creatorId: interaction.user.id,
        question,
        options,
        multiVote: multi,
        anonymous: false,
        closesAt: closeAt,
      });
      schedulePollClosure(pollMsg.id, closeAt);
      await interaction.editReply({ content: `Poll created in <#${pollMsg.channelId}>` });
    }

    if (commandName === 'gif') {
      const query = interaction.options.getString('query', true);
      await interaction.deferReply({ ephemeral: true });
      const url = await searchTenorGif(query);
      if (!url) {
        await interaction.editReply({ content: 'No GIF found or Tenor not configured (set TENOR_API_KEY).' });
        return;
      }
      const sent = await interaction.channel.send({ content: url });
      trackBotMessage(sent.id, interaction.channelId, interaction.guildId);
      await interaction.editReply({ content: 'Posted your GIF!' });
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

    if (commandName === 'purge') {
      if (!interaction.inGuild() && !isSuperAdmin) {
        await interaction.reply({ content: 'Guilds only.', ephemeral: true });
        return;
      }
      if (!hasAdminPerms) {
        await interaction.reply({ content: 'Admin only.', ephemeral: true });
        return;
      }

      const timeframe = interaction.options.getString('timeframe', true);
      const channel = interaction.options.getChannel('channel', true);

      // Defer reply since this could take a while
      await interaction.deferReply({ ephemeral: true });

      // Calculate timestamp based on timeframe
      let sinceTimestamp;
      const now = Date.now();
      switch (timeframe) {
        case '1h':
          sinceTimestamp = now - (1 * 60 * 60 * 1000);
          break;
        case '6h':
          sinceTimestamp = now - (6 * 60 * 60 * 1000);
          break;
        case '12h':
          sinceTimestamp = now - (12 * 60 * 60 * 1000);
          break;
        case '24h':
          sinceTimestamp = now - (24 * 60 * 60 * 1000);
          break;
        case '7d':
          sinceTimestamp = now - (7 * 24 * 60 * 60 * 1000);
          break;
        case '30d':
          sinceTimestamp = now - (30 * 24 * 60 * 60 * 1000);
          break;
        case 'all':
          sinceTimestamp = 0;
          break;
        default:
          sinceTimestamp = 0;
      }

      try {
        // Get bot messages from database
        const messageIds = getBotMessagesInChannel(channel.id, interaction.guildId, sinceTimestamp);
        
        if (messageIds.length === 0) {
          await interaction.editReply({ 
            content: `No bot messages found in <#${channel.id}> within the specified timeframe.` 
          });
          return;
        }

        let deletedCount = 0;
        let failedCount = 0;

        // Helper to get human-readable timeframe text
        const timeframeLabels = {
          '1h': '1 hour',
          '6h': '6 hours',
          '12h': '12 hours',
          '24h': '24 hours',
          '7d': '7 days',
          '30d': '30 days',
          'all': 'all time'
        };
        const timeframeText = timeframeLabels[timeframe] || timeframe;

        // Try bulk delete for messages less than 14 days old
        const fourteenDaysAgo = Date.now() - (14 * 24 * 60 * 60 * 1000);
        const canUseBulkDelete = sinceTimestamp >= fourteenDaysAgo && messageIds.length >= 2;
        let bulkDeleteSucceeded = false;

        if (canUseBulkDelete && messageIds.length <= DISCORD_BULK_DELETE_LIMIT) {
          // Use bulk delete API (max 100 messages at a time)
          try {
            await channel.bulkDelete(messageIds, true);
            deletedCount = messageIds.length;
            bulkDeleteSucceeded = true;
            // Clean up database records for successfully deleted messages
            for (const messageId of messageIds) {
              deleteBotMessageRecord(messageId);
            }
          } catch (err) {
            console.log('Bulk delete failed, falling back to individual deletion:', err.message);
          }
        }

        // Individual deletion for messages older than 14 days or when bulk delete fails
        if (!bulkDeleteSucceeded) {
          for (const messageId of messageIds) {
            try {
              const msg = await channel.messages.fetch(messageId);
              await msg.delete();
              deletedCount++;
              // Only delete from database if Discord deletion succeeded
              deleteBotMessageRecord(messageId);
            } catch (err) {
              // Message might already be deleted or bot lacks permission
              failedCount++;
              console.log(`Failed to delete message ${messageId}:`, err.message);
              // Still clean up from database if the message doesn't exist anymore
              if (err.code === DISCORD_UNKNOWN_MESSAGE_CODE) {
                deleteBotMessageRecord(messageId);
              }
            }
          }
        }

        await interaction.editReply({
          content: `Purged ${deletedCount} bot message(s) from <#${channel.id}> (${timeframeText}).\n` +
                   (failedCount > 0 ? `${failedCount} message(s) could not be deleted (already removed or no permission).` : '')
        });
      } catch (err) {
        console.error('Error during purge:', err);
        await interaction.editReply({
          content: 'An error occurred while purging messages. Please check bot permissions and try again.'
        });
      }
    }
  });
});

client.on('messageReactionAdd', async (reaction, user) => {
  await safeExecute('messageReactionAdd', async () => {
    try {
      if (user.bot) return;
      if (reaction.partial) await reaction.fetch();
      const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
      const emoji = reaction.emoji.name;
      const optionIndex = NUMBER_EMOJIS.indexOf(emoji);
      if (optionIndex === -1) return;
      const poll = getPollByMessageId(message.id);
      if (!poll || poll.closed) return;
      // Single-choice polls only for MVP
      // Remove any other number reactions by the same user
      const userReactions = message.reactions.cache.filter(r => NUMBER_EMOJIS.includes(r.emoji.name));
      for (const r of userReactions.values()) {
        if (r.emoji.name !== emoji) {
          try { await r.users.remove(user.id); } catch {}
        }
      }
      recordVote({ pollId: poll.id, userId: user.id, optionIndex });
    } catch (e) {
      console.error('reactionAdd error', e);
    }
  });
});

client.on('messageReactionRemove', async (reaction, user) => {
  await safeExecute('messageReactionRemove', async () => {
    try {
      if (user.bot) return;
      if (reaction.partial) await reaction.fetch();
      const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
      const emoji = reaction.emoji.name;
      const optionIndex = NUMBER_EMOJIS.indexOf(emoji);
      if (optionIndex === -1) return;
      const poll = getPollByMessageId(message.id);
      if (!poll || poll.closed) return;
      // If user removes their number reaction, drop their vote
      removeVote({ pollId: poll.id, userId: user.id });
    } catch (e) {
      console.error('reactionRemove error', e);
    }
  });
});

client.once('ready', async () => {
  await safeExecute('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    await registerCommands();
    // Resume open polls on startup
    try {
      const open = listOpenPolls();
      for (const poll of open) {
        if (poll.closed) continue;
        const remaining = poll.closes_at - Date.now();
        if (remaining <= 0) {
          const channel = await client.channels.fetch(poll.channel_id);
          await postPollResults(poll, channel);
          closePoll(poll.id);
        } else {
          schedulePollClosure(poll.message_id, poll.closes_at);
        }
      }
    } catch (e) {
      console.error('Failed to resume polls', e);
    }
  });
});

setupProcessGuards();
client.login(DISCORD_TOKEN);
