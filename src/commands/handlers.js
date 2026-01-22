import { PermissionFlagsBits } from 'discord.js';
import {
  getUserSettings,
  isChannelAllowed,
  recordUserMessage,
  setUserMemory,
  setUserAutoreply,
  forgetUser,
  viewMemory,
  getProfileSummary,
  getRecentMessages,
  getUserContext,
  allowChannel,
  denyChannel,
  listChannels,
  resetGuildMemory,
  resetChannelMemory,
  getGuildMetadata,
  getGuildRoles,
  trackBotMessage,
  getBotMessagesInChannel,
  deleteBotMessageRecord,
} from '../memory.js';
import { checkRateLimit } from '../rateLimit.js';
import { searchGiphyGif } from '../services/media.js';
import { handlePrompt } from '../handlers/handlePrompt.js';
import { DISCORD_INTERACTION_EXPIRED_CODE, DISCORD_UNKNOWN_MESSAGE_CODE, DISCORD_BULK_DELETE_LIMIT, NUMBER_EMOJIS } from '../utils/constants.js';
import { parseDuration, containsHateSpeech } from '../utils/validators.js';
import {
  createPoll,
  recordVote,
  removeVote,
  tallyVotes,
  closePoll,
} from '../polls.js';

export async function executeAskCommand(interaction, inMemoryTurns, client) {
  const question = interaction.options.getString('question', true);
  const ghost = interaction.options.getBoolean('ghost') ?? true;
  const settings = getUserSettings(interaction.user.id);
  const memoryChannel = interaction.channel?.isDMBased?.()
    ? true
    : isChannelAllowed(interaction.channelId);
  const allowMemoryContext = memoryChannel && settings.memory_enabled;
  const displayName =
    interaction.member?.displayName || interaction.user.globalName || interaction.user.username;

  if (containsHateSpeech(question)) {
    await interaction.reply({ content: 'nah, not touching that.', ephemeral: true });
    return;
  }

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
    inMemoryTurns,
    client,
  });
}

export async function executePollCommand(interaction, pollTimers) {
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
  createPoll({
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
  
  const delayMs = Math.max(0, closeAt - Date.now());
  if (pollTimers.has(pollMsg.id)) {
    clearTimeout(pollTimers.get(pollMsg.id));
  }
  const t = setTimeout(async () => {
    try {
      const poll = await import('../polls.js').then(m => m.getPollByMessageId(pollMsg.id));
      if (!poll || poll.closed) return;
      const pollChannel = await interaction.client.channels.fetch(poll.channel_id);
      const opts = JSON.parse(poll.options_json);
      const counts = tallyVotes(poll.id, opts.length);
      const total = counts.reduce((a, b) => a + b, 0);
      const lines = opts.map((opt, i) => `${NUMBER_EMOJIS[i]} ${opt} — ${counts[i]} vote${counts[i] === 1 ? '' : 's'}`);
      const header = `📊 Poll closed: ${poll.question}`;
      const footer = `Total votes: ${total}`;
      await pollChannel.send({ content: `${header}\n\n${lines.join('\n')}\n\n${footer}` });
      closePoll(poll.id);
    } catch (e) {
      console.error('Failed to auto-close poll', e);
    } finally {
      pollTimers.delete(pollMsg.id);
    }
  }, delayMs);
  pollTimers.set(pollMsg.id, t);

  await interaction.editReply({ content: `Poll created in <#${pollMsg.channelId}>` });
}

export async function executeGifCommand(interaction) {
  const query = interaction.options.getString('query', true);
  await interaction.deferReply({ ephemeral: true });
  const url = await searchGiphyGif(query, process.env.GIPHY_API_KEY);
  if (!url) {
    await interaction.editReply({ content: 'No GIF found or Giphy not configured (set GIPHY_API_KEY).' });
    return;
  }
  const sent = await interaction.channel.send({ content: url });
  trackBotMessage(sent.id, interaction.channelId, interaction.guildId);
  await interaction.editReply({ content: 'Posted your GIF!' });
}

export async function executeMemoryCommand(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'on') {
    setUserMemory(interaction.user.id, true);
    await interaction.reply({ content: 'Memory is on.' });
  }
  if (sub === 'off') {
    setUserMemory(interaction.user.id, false);
    await interaction.reply({ content: 'Memory is off.' });
  }
  if (sub === 'view') {
    const summary = viewMemory(interaction.user.id);
    await interaction.reply({ content: summary });
  }
}

export async function executeLobotomizeCommand(interaction) {
  const scope = interaction.options.getString('scope') || 'me';
  
  if (scope === 'all') {
    const isSuperAdmin = interaction.user.id === process.env.SUPER_ADMIN_USER_ID;
    const hasAdminPerms = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
    
    if (!isSuperAdmin && !hasAdminPerms) {
      await interaction.reply({ content: 'Admin only.', ephemeral: true });
      return;
    }
    
    // Wipe everything
    const { db } = await import('../memory.js');
    db.exec(`
      DELETE FROM user_messages;
      DELETE FROM user_settings;
      DELETE FROM channel_profiles;
      DELETE FROM guild_profiles;
    `);
    await interaction.reply({ content: '🧠💥 **TOTAL LOBOTOMY COMPLETE** - All memory wiped across all users, channels, and guilds.' });
  } else {
    forgetUser(interaction.user.id);
    await interaction.reply({ content: 'Your memory has been wiped.' });
  }
}

export async function executeMemoryAllowCommand(interaction) {
  const channel = interaction.options.getChannel('channel', true);
  allowChannel(channel.id);
  await interaction.reply({ content: `Allowed memory in <#${channel.id}>.` });
}

export async function executeMemoryDenyCommand(interaction) {
  const channel = interaction.options.getChannel('channel', true);
  denyChannel(channel.id);
  await interaction.reply({ content: `Denied memory in <#${channel.id}>.` });
}

export async function executeMemoryListCommand(interaction) {
  const allRows = listChannels();
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

export async function executeMemoryResetGuildCommand(interaction) {
  resetGuildMemory(interaction.guildId);
  await interaction.reply({ content: 'Guild memory reset.' });
}

export async function executeMemoryResetChannelCommand(interaction) {
  const channel = interaction.options.getChannel('channel', true);
  resetChannelMemory(channel.id);
  await interaction.reply({ content: `Memory reset for <#${channel.id}>.` });
}

export async function executeMemoryResetUserCommand(interaction) {
  const user = interaction.options.getUser('user', true);
  forgetUser(user.id);
  await interaction.reply({ content: `Memory reset for ${user.username}. This action has been logged.` });
  
  try {
    await user.send(
      `Your conversation memory and personality profile have been reset by an administrator in ${interaction.guild.name}.`
    );
  } catch (dmErr) {
    console.log(`Could not send DM to user ${user.username} about memory reset:`, dmErr.message);
  }
}

export async function executePurgeCommand(interaction) {
  const timeframe = interaction.options.getString('timeframe', true);
  const channel = interaction.options.getChannel('channel', true);

  await interaction.deferReply({ ephemeral: true });

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
    const messageIds = getBotMessagesInChannel(channel.id, interaction.guildId, sinceTimestamp);
    
    if (messageIds.length === 0) {
      await interaction.editReply({ 
        content: `No bot messages found in <#${channel.id}> within the specified timeframe.` 
      });
      return;
    }

    let deletedCount = 0;
    let failedCount = 0;

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

    const fourteenDaysAgo = Date.now() - (14 * 24 * 60 * 60 * 1000);
    const canUseBulkDelete = sinceTimestamp >= fourteenDaysAgo && messageIds.length >= 2;
    let bulkDeleteSucceeded = false;

    if (canUseBulkDelete && messageIds.length <= DISCORD_BULK_DELETE_LIMIT) {
      try {
        await channel.bulkDelete(messageIds, true);
        deletedCount = messageIds.length;
        bulkDeleteSucceeded = true;
        for (const messageId of messageIds) {
          deleteBotMessageRecord(messageId);
        }
      } catch (err) {
        console.log('Bulk delete failed, falling back to individual deletion:', err.message);
      }
    }

    if (!bulkDeleteSucceeded) {
      for (const messageId of messageIds) {
        try {
          const msg = await channel.messages.fetch(messageId);
          await msg.delete();
          deletedCount++;
          deleteBotMessageRecord(messageId);
        } catch (err) {
          failedCount++;
          console.log(`Failed to delete message ${messageId}:`, err.message);
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

export async function executeServerInfoCommand(interaction) {
  const guild = interaction.guild;
  const metadata = getGuildMetadata(guild.id);
  const roles = getGuildRoles(guild.id);
  
  let info = `**${guild.name}**\n\n`;
  info += `👥 Members: ${guild.memberCount}\n`;
  info += `👑 Owner: <@${guild.ownerId}>\n`;
  info += `📅 Created: <t:${Math.floor(guild.createdTimestamp / 1000)}:D>\n`;
  
  if (roles.length > 0) {
    const topRoles = roles.slice(0, 10).map(r => r.role_name).join(', ');
    info += `\n🎭 Top Roles: ${topRoles}`;
    if (roles.length > 10) {
      info += ` (+${roles.length - 10} more)`;
    }
  }

  await interaction.reply({ content: info, ephemeral: true });
}

export async function executeMyDataCommand(interaction) {
  const settings = getUserSettings(interaction.user.id);
  const profileSummary = getProfileSummary(interaction.user.id);
  const recentMessages = getRecentMessages(interaction.user.id, 5);
  
  let info = `**Your Data**\n\n`;
  info += `Memory enabled: ${settings.memory_enabled ? 'Yes' : 'No'}\n`;
  info += `Total messages recorded: ${settings.message_count || 0}\n\n`;
  
  if (profileSummary) {
    info += `**Profile:**\n${profileSummary}\n\n`;
  }
  
  if (interaction.inGuild()) {
    const userCtx = getUserContext(interaction.guildId, interaction.user.id);
    if (userCtx) {
      info += `**Server Info:**\n${userCtx}\n\n`;
    }
  }
  
  if (recentMessages.length > 0) {
    info += `**Recent messages (${recentMessages.length}):**\n`;
    info += recentMessages.map(m => `• ${m.substring(0, 60)}${m.length > 60 ? '...' : ''}`).join('\n');
  }
  
  info += `\n\nUse \`/lobotomize\` to clear all your data.`;
  
  await interaction.reply({ content: info, ephemeral: true });
}

export async function executeAutoreplyCommand(interaction) {
  const mode = interaction.options.getString('mode', true);
  const enabled = mode === 'on';
  
  setUserAutoreply(interaction.user.id, enabled);
  
  const status = enabled ? '✅ Auto-reply **enabled**. I\'ll respond to all your messages in this guild.' : '❌ Auto-reply **disabled**. You\'ll need to mention me.';
  await interaction.reply({ content: status, ephemeral: true });
}
