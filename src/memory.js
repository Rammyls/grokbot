import Database from 'better-sqlite3';

/**
 * Memory System Structure:
 * 
 * 1. USER MEMORY (per-user conversation & personality):
 *    - user_settings: tracks memory on/off, profile summary, message counts
 *    - user_messages: stores all messages from users (linked to channels/guilds)
 *    - Used to learn about individual users' preferences, personality, history
 * 
 * 2. CHANNEL MEMORY (per-channel context):
 *    - channel_profiles: tracks channel-level summaries and message counts
 *    - Provides context about what's been discussed in a specific channel
 * 
 * 3. GUILD MEMORY (per-server context):
 *    - guild_profiles: tracks server-level summaries and message counts
 *    - guild_users: caches display names for mentioning users naturally
 *    - Provides broader server context and known participants
 * 
 * 4. CHANNEL ALLOWLIST:
 *    - channel_allowlist: controls which channels can record memory
 *    - Admins use /memory-allow and /memory-deny to configure
 */

const db = new Database('data.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS user_settings (
    user_id TEXT PRIMARY KEY,
    memory_enabled INTEGER DEFAULT 1,
    profile_summary TEXT DEFAULT '',
    message_count INTEGER DEFAULT 0,
    last_summary_at INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS channel_allowlist (
    channel_id TEXT PRIMARY KEY,
    enabled INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS user_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    guild_id TEXT,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS channel_profiles (
    channel_id TEXT PRIMARY KEY,
    guild_id TEXT,
    summary TEXT DEFAULT '',
    message_count INTEGER DEFAULT 0,
    last_summary_at INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS guild_profiles (
    guild_id TEXT PRIMARY KEY,
    summary TEXT DEFAULT '',
    message_count INTEGER DEFAULT 0,
    last_summary_at INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS guild_users (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    last_seen_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );
`);

try {
  db.exec('ALTER TABLE user_messages ADD COLUMN guild_id TEXT');
} catch {}
try {
  db.exec('ALTER TABLE user_settings ADD COLUMN message_count INTEGER DEFAULT 0');
} catch {}
try {
  db.exec('ALTER TABLE user_settings ADD COLUMN last_summary_at INTEGER DEFAULT 0');
} catch {}
try {
  db.exec('ALTER TABLE channel_profiles ADD COLUMN guild_id TEXT');
} catch {}
try {
  db.exec('ALTER TABLE channel_profiles ADD COLUMN message_count INTEGER DEFAULT 0');
} catch {}
try {
  db.exec('ALTER TABLE channel_profiles ADD COLUMN last_summary_at INTEGER DEFAULT 0');
} catch {}
try {
  db.exec('ALTER TABLE guild_profiles ADD COLUMN message_count INTEGER DEFAULT 0');
} catch {}
try {
  db.exec('ALTER TABLE guild_profiles ADD COLUMN last_summary_at INTEGER DEFAULT 0');
} catch {}

const insertMessageStmt = db.prepare(
  'INSERT INTO user_messages (user_id, channel_id, guild_id, content, created_at) VALUES (?, ?, ?, ?, ?)'
);
const getSettingsStmt = db.prepare(
  'SELECT user_id, memory_enabled, profile_summary, message_count, last_summary_at FROM user_settings WHERE user_id = ?'
);
const upsertSettingsStmt = db.prepare(`
  INSERT INTO user_settings (user_id, memory_enabled, profile_summary, message_count, last_summary_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET
    memory_enabled = excluded.memory_enabled,
    profile_summary = excluded.profile_summary,
    message_count = excluded.message_count,
    last_summary_at = excluded.last_summary_at
`);
const allowChannelStmt = db.prepare(
  'INSERT INTO channel_allowlist (channel_id, enabled) VALUES (?, 1) ON CONFLICT(channel_id) DO UPDATE SET enabled = 1'
);
const denyChannelStmt = db.prepare(
  'INSERT INTO channel_allowlist (channel_id, enabled) VALUES (?, 0) ON CONFLICT(channel_id) DO UPDATE SET enabled = 0'
);
const listChannelsStmt = db.prepare(
  'SELECT channel_id, enabled FROM channel_allowlist'
);
const isChannelAllowedStmt = db.prepare(
  'SELECT enabled FROM channel_allowlist WHERE channel_id = ?'
);
const deleteUserMessagesStmt = db.prepare(
  'DELETE FROM user_messages WHERE user_id = ?'
);
const deleteChannelMessagesStmt = db.prepare(
  'DELETE FROM user_messages WHERE channel_id = ?'
);
const deleteGuildMessagesStmt = db.prepare(
  'DELETE FROM user_messages WHERE guild_id = ?'
);
const deleteChannelProfileStmt = db.prepare(
  'DELETE FROM channel_profiles WHERE channel_id = ?'
);
const deleteGuildChannelProfilesStmt = db.prepare(
  'DELETE FROM channel_profiles WHERE guild_id = ?'
);
const deleteGuildProfileStmt = db.prepare(
  'DELETE FROM guild_profiles WHERE guild_id = ?'
);
const deleteGuildUsersStmt = db.prepare(
  'DELETE FROM guild_users WHERE guild_id = ?'
);
const recentMessagesStmt = db.prepare(
  'SELECT content FROM user_messages WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
);
const recentChannelMessagesStmt = db.prepare(
  'SELECT content FROM user_messages WHERE channel_id = ? ORDER BY created_at DESC LIMIT ?'
);
const getChannelProfileStmt = db.prepare(
  'SELECT channel_id, guild_id, summary, message_count, last_summary_at FROM channel_profiles WHERE channel_id = ?'
);
const upsertChannelProfileStmt = db.prepare(`
  INSERT INTO channel_profiles (channel_id, guild_id, summary, message_count, last_summary_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(channel_id) DO UPDATE SET
    guild_id = excluded.guild_id,
    summary = excluded.summary,
    message_count = excluded.message_count,
    last_summary_at = excluded.last_summary_at
`);
const getGuildProfileStmt = db.prepare(
  'SELECT guild_id, summary, message_count, last_summary_at FROM guild_profiles WHERE guild_id = ?'
);
const upsertGuildProfileStmt = db.prepare(`
  INSERT INTO guild_profiles (guild_id, summary, message_count, last_summary_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(guild_id) DO UPDATE SET
    summary = excluded.summary,
    message_count = excluded.message_count,
    last_summary_at = excluded.last_summary_at
`);
const upsertGuildUserStmt = db.prepare(`
  INSERT INTO guild_users (guild_id, user_id, display_name, last_seen_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(guild_id, user_id) DO UPDATE SET
    display_name = excluded.display_name,
    last_seen_at = excluded.last_seen_at
`);
const listGuildUsersStmt = db.prepare(
  'SELECT display_name FROM guild_users WHERE guild_id = ? ORDER BY last_seen_at DESC LIMIT ?'
);

const SUMMARY_HINTS = [
  { regex: /my name is ([^.!?]+)/i, label: 'Name' },
  { regex: /call me ([^.!?]+)/i, label: 'Preferred name' },
  { regex: /i (?:like|love) ([^.!?]+)/i, label: 'Likes' },
  { regex: /i (?:hate|dislike) ([^.!?]+)/i, label: 'Dislikes' },
  { regex: /my pronouns are ([^.!?]+)/i, label: 'Pronouns' },
];

function extractSummaryNotes(message) {
  const notes = [];
  for (const hint of SUMMARY_HINTS) {
    const match = message.match(hint.regex);
    if (match?.[1]) {
      notes.push(`${hint.label}: ${match[1].trim()}`);
    }
  }
  return notes;
}

function normalizeSummary(currentSummary, newNotes) {
  if (!newNotes.length) return currentSummary;
  const lines = currentSummary ? currentSummary.split('\n') : [];
  const set = new Set(lines.filter(Boolean));
  for (const note of newNotes) {
    set.add(note);
  }
  return Array.from(set).join('\n');
}

export function getUserSettings(userId) {
  const row = getSettingsStmt.get(userId);
  if (!row) {
    return {
      user_id: userId,
      memory_enabled: 1,
      profile_summary: '',
      message_count: 0,
      last_summary_at: 0,
    };
  }
  return row;
}

export function setUserMemory(userId, enabled) {
  const current = getUserSettings(userId);
  upsertSettingsStmt.run(
    userId,
    enabled ? 1 : 0,
    current.profile_summary || '',
    current.message_count || 0,
    current.last_summary_at || 0
  );
}

/**
 * Reset a user's conversation memory and personality profile.
 * This clears:
 * - All messages recorded from the user (across all channels/guilds)
 * - The user's profile summary (personality/preferences learned)
 * Note: This does NOT disable memory for the user, only clears their history.
 */
export function forgetUser(userId) {
  deleteUserMessagesStmt.run(userId);
  const current = getUserSettings(userId);
  upsertSettingsStmt.run(userId, current.memory_enabled, '', 0, 0);
}

export function viewMemory(userId) {
  const current = getUserSettings(userId);
  return current.profile_summary || 'No profile summary yet.';
}

/**
 * Reset all memory for a guild, including:
 * - All user messages in the guild
 * - Guild profile (summary and stats)
 * - All channel profiles in the guild
 * - Guild user cache (display names)
 */
export function resetGuildMemory(guildId) {
  deleteGuildMessagesStmt.run(guildId);
  deleteGuildProfileStmt.run(guildId);
  deleteGuildChannelProfilesStmt.run(guildId);
  deleteGuildUsersStmt.run(guildId);
}

/**
 * Reset memory for a specific channel, including:
 * - All messages in the channel
 * - Channel profile (summary and stats)
 */
export function resetChannelMemory(channelId) {
  deleteChannelMessagesStmt.run(channelId);
  deleteChannelProfileStmt.run(channelId);
}

export function allowChannel(channelId) {
  allowChannelStmt.run(channelId);
}

export function denyChannel(channelId) {
  denyChannelStmt.run(channelId);
}

export function listChannels() {
  return listChannelsStmt.all();
}

export function isChannelAllowed(channelId) {
  const row = isChannelAllowedStmt.get(channelId);
  return row?.enabled === 1;
}

export function recordUserMessage({ userId, channelId, guildId, content, displayName }) {
  insertMessageStmt.run(userId, channelId, guildId, content, Date.now());
  const notes = extractSummaryNotes(content);
  const current = getUserSettings(userId);
  const nextCount = (current.message_count || 0) + 1;
  const summaryDue =
    nextCount % 20 === 0 || Date.now() - (current.last_summary_at || 0) > 24 * 60 * 60 * 1000;
  const updatedSummary = summaryDue
    ? normalizeSummary(current.profile_summary || '', notes)
    : current.profile_summary || '';
  const updatedLastSummaryAt = summaryDue ? Date.now() : current.last_summary_at || 0;
  upsertSettingsStmt.run(
    userId,
    current.memory_enabled ?? 1,
    updatedSummary,
    nextCount,
    updatedLastSummaryAt
  );

  if (guildId && displayName) {
    upsertGuildUserStmt.run(guildId, userId, displayName, Date.now());
  }

  if (channelId) {
    const channelProfile =
      getChannelProfileStmt.get(channelId) || {
        channel_id: channelId,
        guild_id: guildId || null,
        summary: '',
        message_count: 0,
        last_summary_at: 0,
      };
    const channelCount = (channelProfile.message_count || 0) + 1;
    const channelSummaryDue =
      channelCount % 20 === 0 ||
      Date.now() - (channelProfile.last_summary_at || 0) > 24 * 60 * 60 * 1000;
    const channelSummary = channelSummaryDue
      ? normalizeSummary(channelProfile.summary || '', notes)
      : channelProfile.summary || '';
    const channelLastSummaryAt = channelSummaryDue
      ? Date.now()
      : channelProfile.last_summary_at || 0;
    upsertChannelProfileStmt.run(
      channelId,
      guildId || null,
      channelSummary,
      channelCount,
      channelLastSummaryAt
    );
  }

  if (guildId) {
    const guildProfile =
      getGuildProfileStmt.get(guildId) || {
        guild_id: guildId,
        summary: '',
        message_count: 0,
        last_summary_at: 0,
      };
    const guildCount = (guildProfile.message_count || 0) + 1;
    const guildSummaryDue =
      guildCount % 30 === 0 ||
      Date.now() - (guildProfile.last_summary_at || 0) > 24 * 60 * 60 * 1000;
    const guildSummary = guildSummaryDue
      ? normalizeSummary(guildProfile.summary || '', notes)
      : guildProfile.summary || '';
    const guildLastSummaryAt = guildSummaryDue
      ? Date.now()
      : guildProfile.last_summary_at || 0;
    upsertGuildProfileStmt.run(guildId, guildSummary, guildCount, guildLastSummaryAt);
  }
}

export function getProfileSummary(userId) {
  const current = getUserSettings(userId);
  return current.profile_summary || '';
}

export function getRecentMessages(userId, limit = 4) {
  return recentMessagesStmt
    .all(userId, limit)
    .map((row) => row.content)
    .filter(Boolean);
}

export function getRecentChannelMessages(channelId, limit = 4) {
  return recentChannelMessagesStmt
    .all(channelId, limit)
    .map((row) => row.content)
    .filter(Boolean);
}

export function getChannelSummary(channelId) {
  return getChannelProfileStmt.get(channelId)?.summary || '';
}

export function getGuildSummary(guildId) {
  return getGuildProfileStmt.get(guildId)?.summary || '';
}

export function getGuildUserNames(guildId, limit = 10) {
  return listGuildUsersStmt
    .all(guildId, limit)
    .map((row) => row.display_name)
    .filter(Boolean);
}
