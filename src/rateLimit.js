const COOLDOWN_MS = 3000;

const state = new Map();

export function checkRateLimit(userId, prompt) {
  const now = Date.now();
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
