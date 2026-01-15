const EDIT_WINDOW_MS = 60_000;
const EDIT_THROTTLE_MS = 2000;

const editState = new Map();

export function trackReply({ userMessageId, botReplyId }) {
  editState.set(userMessageId, {
    botReplyId,
    createdAt: Date.now(),
    lastEditAt: 0,
  });
}

export function shouldHandleEdit(userMessageId) {
  const entry = editState.get(userMessageId);
  if (!entry) return false;
  const now = Date.now();
  if (now - entry.createdAt > EDIT_WINDOW_MS) return false;
  if (now - entry.lastEditAt < EDIT_THROTTLE_MS) return false;
  entry.lastEditAt = now;
  editState.set(userMessageId, entry);
  return true;
}

export function getReplyId(userMessageId) {
  return editState.get(userMessageId)?.botReplyId || null;
}
