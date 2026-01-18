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

export const db = new Database('data.db');
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

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
    joined_at INTEGER DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS guild_roles (
    guild_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    role_name TEXT NOT NULL,
    color TEXT,
    position INTEGER DEFAULT 0,
    permissions TEXT,
    PRIMARY KEY (guild_id, role_id)
  );

  CREATE TABLE IF NOT EXISTS member_roles (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    PRIMARY KEY (guild_id, user_id, role_id)
  );

  CREATE TABLE IF NOT EXISTS guild_metadata (
    guild_id TEXT PRIMARY KEY,
    name TEXT,
    owner_id TEXT,
    member_count INTEGER DEFAULT 0,
    created_at INTEGER,
    updated_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS bot_messages (
    message_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    guild_id TEXT,
    created_at INTEGER NOT NULL
  );
`);

function isDuplicateColumnError(error) {
  return (
    error &&
    typeof error.message === 'string' &&
    error.message.includes('duplicate column name')
  );
}

try {
  db.exec('ALTER TABLE user_messages ADD COLUMN guild_id TEXT');
} catch (err) {
  if (!isDuplicateColumnError(err)) {
    console.error(
      'Failed to run migration: ALTER TABLE user_messages ADD COLUMN guild_id TEXT',
      err
    );
    throw err;
  }
}
try {
  db.exec('ALTER TABLE user_settings ADD COLUMN message_count INTEGER DEFAULT 0');
} catch (err) {
  if (!isDuplicateColumnError(err)) {
    console.error(
      'Failed to run migration: ALTER TABLE user_settings ADD COLUMN message_count INTEGER DEFAULT 0',
      err
    );
    throw err;
  }
}
try {
  db.exec('ALTER TABLE user_settings ADD COLUMN last_summary_at INTEGER DEFAULT 0');
} catch (err) {
  if (!isDuplicateColumnError(err)) {
    console.error(
      'Failed to run migration: ALTER TABLE user_settings ADD COLUMN last_summary_at INTEGER DEFAULT 0',
      err
    );
    throw err;
  }
}
try {
  db.exec('ALTER TABLE channel_profiles ADD COLUMN guild_id TEXT');
} catch (err) {
  if (!isDuplicateColumnError(err)) {
    console.error(
      'Failed to run migration: ALTER TABLE channel_profiles ADD COLUMN guild_id TEXT',
      err
    );
    throw err;
  }
}
try {
  db.exec('ALTER TABLE channel_profiles ADD COLUMN message_count INTEGER DEFAULT 0');
} catch (err) {
  if (!isDuplicateColumnError(err)) {
    console.error(
      'Failed to run migration: ALTER TABLE channel_profiles ADD COLUMN message_count INTEGER DEFAULT 0',
      err
    );
    throw err;
  }
}
try {
  db.exec('ALTER TABLE channel_profiles ADD COLUMN last_summary_at INTEGER DEFAULT 0');
} catch (err) {
  if (!isDuplicateColumnError(err)) {
    console.error(
      'Failed to run migration: ALTER TABLE channel_profiles ADD COLUMN last_summary_at INTEGER DEFAULT 0',
      err
    );
    throw err;
  }
}
try {
  db.exec('ALTER TABLE guild_profiles ADD COLUMN message_count INTEGER DEFAULT 0');
} catch (err) {
  if (!isDuplicateColumnError(err)) {
    console.error(
      'Failed to run migration: ALTER TABLE guild_profiles ADD COLUMN message_count INTEGER DEFAULT 0',
      err
    );
    throw err;
  }
}
try {
  db.exec('ALTER TABLE guild_profiles ADD COLUMN last_summary_at INTEGER DEFAULT 0');
} catch (err) {
  if (!isDuplicateColumnError(err)) {
    console.error(
      'Failed to run migration: ALTER TABLE guild_profiles ADD COLUMN last_summary_at INTEGER DEFAULT 0',
      err
    );
    throw err;
  }
}
try {
  db.exec('ALTER TABLE guild_users ADD COLUMN joined_at INTEGER DEFAULT 0');
} catch (err) {
  if (!isDuplicateColumnError(err)) {
    console.error(
      'Failed to run migration: ALTER TABLE guild_users ADD COLUMN joined_at INTEGER DEFAULT 0',
      err
    );
    throw err;
  }
}

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
  'SELECT content, created_at FROM user_messages WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
);
const recentChannelMessagesStmt = db.prepare(`
  SELECT um.content, um.user_id, um.created_at, gu.display_name
  FROM user_messages um
  LEFT JOIN guild_users gu ON um.guild_id = gu.guild_id AND um.user_id = gu.user_id
  WHERE um.channel_id = ? AND um.user_id != ?
  ORDER BY um.created_at DESC
  LIMIT ?
`);
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
  INSERT INTO guild_users (guild_id, user_id, display_name, last_seen_at, joined_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(guild_id, user_id) DO UPDATE SET
    display_name = excluded.display_name,
    last_seen_at = excluded.last_seen_at,
    joined_at = CASE WHEN joined_at = 0 THEN excluded.joined_at ELSE joined_at END
`);
const listGuildUsersStmt = db.prepare(
  "SELECT display_name FROM guild_users WHERE guild_id = ? AND last_seen_at > (strftime('%s', 'now') - 30 * 24 * 60 * 60) ORDER BY last_seen_at DESC LIMIT ?"
);
const insertBotMessageStmt = db.prepare(
  'INSERT INTO bot_messages (message_id, channel_id, guild_id, created_at) VALUES (?, ?, ?, ?)'
);
const getBotMessagesInChannelStmt = db.prepare(
  'SELECT message_id FROM bot_messages WHERE channel_id = ? AND guild_id = ? AND created_at >= ?'
);
const deleteBotMessageStmt = db.prepare(
  'DELETE FROM bot_messages WHERE message_id = ?'
);

const upsertGuildRoleStmt = db.prepare(`
  INSERT INTO guild_roles (guild_id, role_id, role_name, color, position, permissions)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(guild_id, role_id) DO UPDATE SET
    role_name = excluded.role_name,
    color = excluded.color,
    position = excluded.position,
    permissions = excluded.permissions
`);

const deleteGuildRoleStmt = db.prepare(
  'DELETE FROM guild_roles WHERE guild_id = ? AND role_id = ?'
);

const deleteAllGuildRolesStmt = db.prepare(
  'DELETE FROM guild_roles WHERE guild_id = ?'
);

const getGuildRolesStmt = db.prepare(
  'SELECT role_id, role_name, color, position, permissions FROM guild_roles WHERE guild_id = ? ORDER BY position DESC'
);

const upsertMemberRoleStmt = db.prepare(`
  INSERT INTO member_roles (guild_id, user_id, role_id)
  VALUES (?, ?, ?)
  ON CONFLICT(guild_id, user_id, role_id) DO NOTHING
`);

const deleteMemberRoleStmt = db.prepare(
  'DELETE FROM member_roles WHERE guild_id = ? AND user_id = ? AND role_id = ?'
);

const deleteAllMemberRolesStmt = db.prepare(
  'DELETE FROM member_roles WHERE guild_id = ? AND user_id = ?'
);

const getMemberRolesStmt = db.prepare(
  'SELECT role_id FROM member_roles WHERE guild_id = ? AND user_id = ?'
);

// List members for a given role (with display names)
const listRoleMembersStmt = db.prepare(`
  SELECT gu.display_name, mr.user_id
  FROM member_roles mr
  LEFT JOIN guild_users gu
    ON mr.guild_id = gu.guild_id AND mr.user_id = gu.user_id
  WHERE mr.guild_id = ? AND mr.role_id = ?
  ORDER BY gu.display_name ASC
  LIMIT ?
`);

// Count members in a given role
const countRoleMembersStmt = db.prepare(
  'SELECT COUNT(*) AS cnt FROM member_roles WHERE guild_id = ? AND role_id = ?'
);

const upsertGuildMetadataStmt = db.prepare(`
  INSERT INTO guild_metadata (guild_id, name, owner_id, member_count, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(guild_id) DO UPDATE SET
    name = excluded.name,
    owner_id = excluded.owner_id,
    member_count = excluded.member_count,
    updated_at = excluded.updated_at
`);

const getGuildMetadataStmt = db.prepare(
  'SELECT * FROM guild_metadata WHERE guild_id = ?'
);

const getGuildUserStmt = db.prepare(
  'SELECT * FROM guild_users WHERE guild_id = ? AND user_id = ?'
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

export const recordUserMessage = db.transaction(({ userId, channelId, guildId, content, displayName }) => {
  insertMessageStmt.run(userId, channelId, guildId, content, Date.now());
  const notes = extractSummaryNotes(content);
  const current = getUserSettings(userId);
  const nextCount = (current.message_count || 0) + 1;
  const timeSinceLastSummary = Date.now() - (current.last_summary_at || 0);
  const shouldUpdateSummary = notes.length > 0 || timeSinceLastSummary > TWENTY_FOUR_HOURS_MS;
  const summaryDue = (notes.length > 0 && nextCount % 20 === 0) || timeSinceLastSummary > TWENTY_FOUR_HOURS_MS;
  const updatedSummary = summaryDue && shouldUpdateSummary
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
    upsertGuildUserStmt.run(guildId, userId, displayName, Date.now(), 0);
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
    const channelTimeSinceLastSummary = Date.now() - (channelProfile.last_summary_at || 0);
    const channelShouldUpdateSummary = notes.length > 0 || channelTimeSinceLastSummary > TWENTY_FOUR_HOURS_MS;
    const channelSummaryDue =
      (notes.length > 0 && channelCount % 20 === 0) ||
      channelTimeSinceLastSummary > TWENTY_FOUR_HOURS_MS;
    const channelSummary = channelSummaryDue && channelShouldUpdateSummary
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
    const guildTimeSinceLastSummary = Date.now() - (guildProfile.last_summary_at || 0);
    const guildShouldUpdateSummary = notes.length > 0 || guildTimeSinceLastSummary > TWENTY_FOUR_HOURS_MS;
    const guildSummaryDue =
      (notes.length > 0 && guildCount % 30 === 0) ||
      guildTimeSinceLastSummary > TWENTY_FOUR_HOURS_MS;
    const guildSummary = guildSummaryDue && guildShouldUpdateSummary
      ? normalizeSummary(guildProfile.summary || '', notes)
      : guildProfile.summary || '';
    const guildLastSummaryAt = guildSummaryDue
      ? Date.now()
      : guildProfile.last_summary_at || 0;
    upsertGuildProfileStmt.run(guildId, guildSummary, guildCount, guildLastSummaryAt);
  }
});

export function getProfileSummary(userId) {
  const current = getUserSettings(userId);
  return current.profile_summary || '';
}

export function getRecentMessages(userId, limit = 4) {
  return recentMessagesStmt
    .all(userId, limit)
    .map((row) => {
      const timestamp = new Date(row.created_at).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      });
      return `[${timestamp}] ${row.content}`;
    })
    .filter(Boolean);
}

export function getRecentChannelMessages(channelId, excludeUserId, limit = 4) {
  return recentChannelMessagesStmt
    .all(channelId, excludeUserId, limit)
    .map((row) => {
      const name = row.display_name || `User${row.user_id.slice(-4)}`;
      const timestamp = new Date(row.created_at).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      });
      return `[${timestamp}] @${name}: ${row.content}`;
    })
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

/**
 * Track a bot message in the database for future purge operations.
 * @param {string} messageId - Discord message ID
 * @param {string} channelId - Discord channel ID
 * @param {string|null} guildId - Discord guild ID (null for DMs)
 */
export function trackBotMessage(messageId, channelId, guildId) {
  insertBotMessageStmt.run(messageId, channelId, guildId || null, Date.now());
}

/**
 * Get bot messages in a channel within a time period.
 * @param {string} channelId - Discord channel ID
 * @param {string} guildId - Discord guild ID
 * @param {number} sinceTimestamp - Unix timestamp in milliseconds
 * @returns {Array<string>} Array of message IDs
 */
export function getBotMessagesInChannel(channelId, guildId, sinceTimestamp) {
  return getBotMessagesInChannelStmt
    .all(channelId, guildId, sinceTimestamp)
    .map((row) => row.message_id);
}

/**
 * Delete a bot message record from the database.
 * @param {string} messageId - Discord message ID
 */
export function deleteBotMessageRecord(messageId) {
  deleteBotMessageStmt.run(messageId);
}

// ===== GUILD METADATA =====

export function upsertGuildMetadata({ guildId, name, ownerId, memberCount, createdAt }) {
  upsertGuildMetadataStmt.run(
    guildId,
    name,
    ownerId,
    memberCount,
    createdAt || Date.now(),
    Date.now()
  );
}

export function getGuildMetadata(guildId) {
  return getGuildMetadataStmt.get(guildId) || null;
}

// ===== ROLE MANAGEMENT =====

export function upsertGuildRole({ guildId, roleId, roleName, color, position, permissions }) {
  upsertGuildRoleStmt.run(guildId, roleId, roleName, color || null, position || 0, permissions || null);
}

export function deleteGuildRole(guildId, roleId) {
  deleteGuildRoleStmt.run(guildId, roleId);
  // Also clean up member_roles
  db.prepare('DELETE FROM member_roles WHERE guild_id = ? AND role_id = ?').run(guildId, roleId);
}

export function deleteAllGuildRoles(guildId) {
  deleteAllGuildRolesStmt.run(guildId);
}

export function getGuildRoles(guildId) {
  return getGuildRolesStmt.all(guildId);
}

// ===== MEMBER ROLE MANAGEMENT =====

export function upsertMemberRole(guildId, userId, roleId) {
  upsertMemberRoleStmt.run(guildId, userId, roleId);
}

export function deleteMemberRole(guildId, userId, roleId) {
  deleteMemberRoleStmt.run(guildId, userId, roleId);
}

export function deleteAllMemberRoles(guildId, userId) {
  deleteAllMemberRolesStmt.run(guildId, userId);
}

export function getMemberRoles(guildId, userId) {
  return getMemberRolesStmt.all(guildId, userId).map(r => r.role_id);
}

export function getRoleMemberNames(guildId, roleId, limit = 8) {
  return listRoleMembersStmt
    .all(guildId, roleId, limit)
    .map(r => r.display_name || `User${String(r.user_id).slice(-4)}`);
}

export function getRoleMemberCount(guildId, roleId) {
  const row = countRoleMembersStmt.get(guildId, roleId);
  return row?.cnt || 0;
}

// ===== USER MANAGEMENT =====

export function upsertGuildUser({ guildId, userId, displayName, joinedAt }) {
  const now = Date.now();
  upsertGuildUserStmt.run(guildId, userId, displayName, now, joinedAt || now);
}

export function getGuildUser(guildId, userId) {
  return getGuildUserStmt.get(guildId, userId) || null;
}

// ===== CONTEXT BUILDERS FOR LLM =====

export function getServerContext(guildId) {
  const metadata = getGuildMetadata(guildId);
  const roles = getGuildRoles(guildId);
  const recentUsers = listGuildUsersStmt.all(guildId, 15);
  
  if (!metadata && !roles.length && !recentUsers.length) {
    return null;
  }
  
  let context = '';
  
  if (metadata) {
    context += `Server: ${metadata.name || 'Unknown'}\n`;
    context += `Members: ${metadata.member_count || 0}\n`;
    if (metadata.owner_id) {
      const owner = getGuildUser(guildId, metadata.owner_id);
      if (owner) {
        context += `Owner: ${owner.display_name} (${metadata.owner_id})\n`;
      }
    }
  }
  
  if (roles.length > 0) {
    const topRoles = roles.slice(0, 8).map(r => r.role_name).join(', ');
    context += `Roles: ${topRoles}\n`;

    // Include member counts and sample names for the top few roles
    const sampleRoles = roles.slice(0, 3);
    for (const role of sampleRoles) {
      const count = getRoleMemberCount(guildId, role.role_id);
      const names = getRoleMemberNames(guildId, role.role_id, 6);
      const namesStr = names.join(', ');
      context += `Role ${role.role_name}: ${count} members${namesStr ? ` (e.g., ${namesStr})` : ''}\n`;
    }
  }
  
  if (recentUsers.length > 0) {
    const userNames = recentUsers.map(u => u.display_name).join(', ');
    context += `Active members: ${userNames}`;
  }
  
  return context.trim() || null;
}

export function getUserContext(guildId, userId) {
  const user = getGuildUser(guildId, userId);
  if (!user) return null;
  
  const roleIds = getMemberRoles(guildId, userId);
  const roles = getGuildRoles(guildId).filter(r => roleIds.includes(r.role_id));
  
  let context = `User: ${user.display_name}\n`;
  
  if (user.joined_at > 0) {
    const joinDate = new Date(user.joined_at);
    context += `Joined: ${joinDate.toLocaleDateString()}\n`;
  }
  
  if (roles.length > 0) {
    const roleNames = roles.map(r => r.role_name).join(', ');
    context += `Roles: ${roleNames}`;
  }
  
  return context.trim() || null;
}
