const COOLDOWN_MS = 3000;
const STATE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_STATE_SIZE = 10000;

const state = new Map();

function cleanupState(now) {
  // Remove entries that have been inactive for longer than STATE_TTL_MS
  for (const [userId, entry] of state) {
    if (now - entry.lastAt > STATE_TTL_MS) {
      state.delete(userId);
    }
  }

  // If the map is still too large, evict oldest entries until under the limit
  if (state.size > MAX_STATE_SIZE) {
    const sorted = Array.from(state.entries()).sort((a, b) => a[1].lastAt - b[1].lastAt);
    const toDelete = sorted.slice(0, state.size - MAX_STATE_SIZE);
    for (const [userId] of toDelete) {
      state.delete(userId);
    }
  }
}

export function checkRateLimit(userId, prompt) {
  const now = Date.now();
  cleanupState(now);
  const entry = state.get(userId) || {
    lastAt: 0,
    lastPrompt: '',
    duplicateCount: 0,
  };

  if (now - entry.lastAt < COOLDOWN_MS) {
    if (prompt === entry.lastPrompt) {
      if (entry.duplicateCount >= 1) {
        entry.duplicateCount += 1;
        state.set(userId, entry);
        return { allow: false, message: '-# stop spamming twin im only replying once' };
      }
      entry.duplicateCount += 1;
      entry.lastAt = now;
      state.set(userId, entry);
      return { allow: true };
    }
    state.set(userId, entry);
    return { allow: false, message: '-# chill for 3s then try again' };
  }

  entry.lastAt = now;
  entry.lastPrompt = prompt;
  entry.duplicateCount = 0;
  state.set(userId, entry);
  return { allow: true };
}

export function resetRateLimit(userId) {
  state.delete(userId);
}
