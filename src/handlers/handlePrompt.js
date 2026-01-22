import { checkRateLimit } from '../rateLimit.js';
import { getUserSettings, isChannelAllowed, recordUserMessage, getProfileSummary, getRecentMessages, getRecentChannelMessages, getChannelSummary, getGuildSummary, getGuildUserNames, trackBotMessage, getServerContext, getUserContext } from '../memory.js';
import { fetchImageAsDataUrl, resolveDirectMediaUrl } from '../services/media.js';
import { getLLMResponse } from '../llm.js';
import { MAX_IMAGES } from '../utils/constants.js';
import { containsHateSpeech, getMessageImageUrls, getMessageVideoUrls } from '../utils/validators.js';

export async function handlePrompt({
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
  inMemoryTurns,
  client,
}) {
  const rateKey = [prompt, replyContextText || '', ...(imageUrls || []), ...(videoUrls || [])].join('|');
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
    if (!memoryContent && videoUrls?.length) {
      memoryContent = `User sent ${videoUrls.length} video(s).`;
    } else if (videoUrls?.length) {
      memoryContent = `${memoryContent} [shared ${videoUrls.length} video(s)]`;
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
  const serverContext = allowMemory && guildId ? getServerContext(guildId) : null;
  const userContext = allowMemory && guildId ? getUserContext(guildId, userId) : null;

  const imageInputs = [];
  if (imageUrls?.length) {
    for (const url of imageUrls.slice(0, MAX_IMAGES)) {
      const dataUrl = await fetchImageAsDataUrl(url, (u) => resolveDirectMediaUrl(u, process.env.GIPHY_API_KEY));
      if (dataUrl) {
        imageInputs.push(dataUrl);
      } else {
        console.warn('Image input dropped (failed to resolve):', url);
      }
    }
  }

  if (imageInputs.length) {
    console.info('Prepared image inputs for model:', imageInputs.map((v) => (typeof v === 'string' ? v.slice(0, 80) : v)));
  }
  
  let effectivePrompt = prompt;
  if (!effectivePrompt && imageInputs.length > 0) {
    effectivePrompt = 'User sent an image.';
  } else if (!effectivePrompt && (videoUrls?.length || (replyContextText && replyContextText.includes('video')))) {
    effectivePrompt = 'User referenced a video.';
  } else if (!effectivePrompt && replyContextText) {
    effectivePrompt = 'Following up on the replied message.';
  }

  // Surface attached videos to the model even if they are not fetched as image inputs.
  if (videoUrls?.length) {
    const videoNote = `Attached video URLs:\n- ${videoUrls.slice(0, 3).join('\n- ')}`;
    effectivePrompt = effectivePrompt ? `${effectivePrompt}\n${videoNote}` : videoNote;
    console.info('Video URLs included in prompt:', videoUrls);
  }
  
  function addTurn(role, content) {
    const turns = inMemoryTurns.get(userId) || [];
    const updated = [...turns, { role, content }].slice(-6);
    inMemoryTurns.set(userId, updated);
    return updated;
  }

  const recentTurns = allowMemory
    ? addTurn('user', effectivePrompt || '...')
    : [];
  if (onTyping) {
    await onTyping();
  }
  const response = await getLLMResponse({
    botName: process.env.BOT_NAME || 'GrokBuddy',
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
    serverContext,
    userContext,
  });
  if (allowMemory) {
    addTurn('assistant', response);
  }
  await reply(response);
}
