import Database from 'better-sqlite3';

const db = new Database('data.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS user_settings (
    user_id TEXT PRIMARY KEY,
    memory_enabled INTEGER DEFAULT 1,
    profile_summary TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS channel_allowlist (
    channel_id TEXT PRIMARY KEY,
    enabled INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS user_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_user_messages_user_id
    ON user_messages(user_id);

  CREATE INDEX IF NOT EXISTS idx_user_messages_created_at
    ON user_messages(created_at);
`);

const insertMessageStmt = db.prepare(
  'INSERT INTO user_messages (user_id, channel_id, content, created_at) VALUES (?, ?, ?, ?)'
);
const getSettingsStmt = db.prepare(
  'SELECT user_id, memory_enabled, profile_summary FROM user_settings WHERE user_id = ?'
);
const upsertSettingsStmt = db.prepare(`
  INSERT INTO user_settings (user_id, memory_enabled, profile_summary)
  VALUES (?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET
    memory_enabled = excluded.memory_enabled,
    profile_summary = excluded.profile_summary
`);
const updateSummaryStmt = db.prepare(
  'UPDATE user_settings SET profile_summary = ? WHERE user_id = ?'
);
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
  
  const existingLines = currentSummary ? currentSummary.split('\n').filter(Boolean) : [];

  // Build a map of label -> line, preserving the order of first appearance.
  const labelOrder = [];
  const lineByLabel = new Map();

  const extractLabel = (line) => {
    const idx = line.indexOf(':');
    if (idx === -1) {
      return line.trim();
    }
    return line.slice(0, idx).trim();
  };

  // Load existing summary lines.
  for (const line of existingLines) {
    const label = extractLabel(line);
    if (!lineByLabel.has(label)) {
      labelOrder.push(label);
    }
    lineByLabel.set(label, line);
  }

  // Apply new notes, replacing any existing entry with the same label.
  for (const note of newNotes) {
    const label = extractLabel(note);
    if (!lineByLabel.has(label)) {
      labelOrder.push(label);
    }
    lineByLabel.set(label, note);
  }

  return labelOrder.map((label) => lineByLabel.get(label)).join('\n');
}

export function getUserSettings(userId) {
  const row = getSettingsStmt.get(userId);
  if (!row) {
    return { user_id: userId, memory_enabled: 1, profile_summary: '' };
  }
  return row;
}

export function setUserMemory(userId, enabled) {
  const current = getUserSettings(userId);
  upsertSettingsStmt.run(userId, enabled ? 1 : 0, current.profile_summary || '');
}

export function forgetUser(userId) {
  deleteUserMessagesStmt.run(userId);
  const current = getUserSettings(userId);
  upsertSettingsStmt.run(userId, current.memory_enabled, '');
}

export function viewMemory(userId) {
  const current = getUserSettings(userId);
  return current.profile_summary || 'No profile summary yet.';
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

export function recordUserMessage({ userId, channelId, content }) {
  insertMessageStmt.run(userId, channelId, content, Date.now());
  const notes = extractSummaryNotes(content);
  if (notes.length) {
    const current = getUserSettings(userId);
    const updated = normalizeSummary(current.profile_summary || '', notes);
    updateSummaryStmt.run(updated, userId);
  }
}

export function getProfileSummary(userId) {
  const current = getUserSettings(userId);
  return current.profile_summary || '';
}
