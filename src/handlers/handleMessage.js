import { getUserSettings, isChannelAllowed, recordUserMessage, trackBotMessage } from '../memory.js';
import { getReplyId, shouldHandleEdit, trackReply as trackReplySync } from '../editSync.js';
import { handlePrompt } from './handlePrompt.js';
import { getMessageImageUrls, getMessageVideoUrls, stripMention, parseQuotedPoll, containsHateSpeech } from '../utils/validators.js';
import { NUMBER_EMOJIS } from '../utils/constants.js';
import { createPoll, getPollByMessageId, recordVote, removeVote } from '../polls.js';
import { getReplyContext } from '../services/media.js';
import { routeIntent } from '../services/intentRouter.js';

export async function handleMessage({ client, message, inMemoryTurns }) {
  if (message.author.bot) return;

  const isDirect = message.channel?.isDMBased?.() || message.guildId === null;
  const memoryChannel = isDirect || isChannelAllowed(message.channelId);
  const settings = getUserSettings(message.author.id);
  const allowMemoryContext = memoryChannel && settings.memory_enabled;
  const displayName = message.member?.displayName || message.author.username;
  
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
  const autoreplyEnabled = settings.autoreply_enabled && message.guildId;
  
  // Only process if: DM, mentioned, or autoreply enabled
  if (!isDirect && !mentioned && !autoreplyEnabled) return;

  const content = isDirect ? message.content.trim() : mentioned ? stripMention(message.content, client.user.id) : message.content.trim();
  
  // Try to route simple cache-backed intents (owner, find user, role members, random)
  if (content && message.guildId) {
    const intentReply = await routeIntent(content, {
      guildId: message.guildId,
      userId: message.author.id,
      client,
    });
    if (intentReply) {
      await message.reply({ content: intentReply });
      return;
    }
  }
  
  // Inline poll creation
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
      return;
    }
  }

  const replyContext = await getReplyContext(message);
  const replyContextText = replyContext
    ? `Reply context from ${replyContext.author}: ${replyContext.text || '[no text]'}${(replyContext.videos?.length ? ' [video referenced]' : '')}`
    : '';
  
  // Collect image URLs (GIFs remain as URLs so the model can fetch them directly)
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
    trackReplySync({ userMessageId: message.id, botReplyId: sent.id });
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
    inMemoryTurns,
    client,
  });
}

export async function handleMessageUpdate({ client, newMessage, inMemoryTurns }) {
  if (!newMessage) return;
  const hydrated = newMessage.partial ? await newMessage.fetch() : newMessage;
  if (hydrated.author?.bot) return;

  const isDirect = hydrated.channel?.isDMBased?.() || hydrated.guildId === null;
  const memoryChannel = isDirect || isChannelAllowed(hydrated.channelId);
  const settings = getUserSettings(hydrated.author.id);
  const allowMemoryContext = memoryChannel && settings.memory_enabled;
  const displayName = hydrated.member?.displayName || hydrated.author.username;

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
    : stripMention(hydrated.content, client.user.id);
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

  const replyFn = async (text) => {
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
    inMemoryTurns,
    client,
  });
}
