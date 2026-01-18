import {
  getGuildMetadata,
  getGuildUser,
  getGuildRoles,
  getRoleMemberNames,
  getRoleMemberCount,
  getGuildUserNames,
} from '../memory.js';

/**
 * Normalize a string for fuzzy matching (lowercase, trim, remove diacritics)
 */
function normalize(str) {
  return (str || '')
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Simple fuzzy score: count matching characters in order, case-insensitive
 */
function fuzzyScore(search, target) {
  const s = normalize(search);
  const t = normalize(target);
  if (t.includes(s)) return 100; // Exact substring match
  let score = 0;
  let sIdx = 0;
  for (let i = 0; i < t.length && sIdx < s.length; i++) {
    if (t[i] === s[sIdx]) {
      score++;
      sIdx++;
    }
  }
  return sIdx === s.length ? score : -1; // -1 if not all chars matched
}

/**
 * Lookup user ID by display name
 */
export function getUserIdByName(guildId, displayName) {
  const allUsers = getGuildUserNames(guildId, 500) || [];
  const norm = normalize(displayName);
  const match = allUsers.find((name) => normalize(name) === norm);
  if (!match) return null;
  // Since we only have names, we need to search the guild_users table directly
  // For now, return the name as placeholder; caller must handle
  return match;
}
  if (!roleName) return null;
  const norm = normalize(roleName);

  // Exact match first
  let exact = roles.find((r) => normalize(r.role_name) === norm);
  if (exact) return exact;

  // Fuzzy match
  let best = null;
  let bestScore = 0;
  for (const role of roles) {
    const score = fuzzyScore(norm, normalize(role.role_name));
    if (score > bestScore) {
      bestScore = score;
      best = role;
    }
  }
  return bestScore >= 2 ? best : null; // Require at least 2 matching chars
}

/**
 * Find a user by display name (case-insensitive, fuzzy)
 */
function findUserByName(users, userName) {
  if (!userName) return null;
  const norm = normalize(userName);

  // Exact match first
  let exact = users.find((u) => normalize(u.display_name) === norm);
  if (exact) return exact;

  // Fuzzy match
  let best = null;
  let bestScore = 0;
  for (const user of users) {
    const score = fuzzyScore(norm, normalize(user.display_name));
    if (score > bestScore) {
      bestScore = score;
      best = user;
    }
  }
  return bestScore >= 2 ? best : null;
}

/**
 * Detect and execute simple, cache-backed intents
 * Returns a reply string or null if no intent matched
 */
export async function routeIntent(prompt, { guildId, userId, client }) {
  if (!prompt || !guildId) return null;

  const lower = prompt.toLowerCase().trim();

  // PING intent: "ping X people", "ping random", "ping someone", etc.
  const pingMatch = lower.match(/^ping\s+(?:(\d+)\s+)?(?:random\s+)?(?:people|person|users?|members?)?$/i);
  if (pingMatch) {
    const count = parseInt(pingMatch[1], 10) || 1;
    const recentUsers = getGuildUserNames(guildId, 150) || [];
    if (recentUsers.length === 0) return null;

    // Pick N random users without replacement
    const picked = [];
    const available = [...recentUsers];
    for (let i = 0; i < Math.min(count, available.length); i++) {
      const idx = Math.floor(Math.random() * available.length);
      picked.push(available[idx]);
      available.splice(idx, 1);
    }

    // For each picked name, we need to get their user ID for mentioning
    // Since the memory API returns display names but we need IDs, use client to resolve
    const mentions = [];
    for (const name of picked) {
      // Try to find by username or display name via guild members
      try {
        const members = await client.guilds.cache.get(guildId)?.members.search({ query: name });
        if (members?.first()) {
          mentions.push(`<@${members.first().user.id}>`);
        } else {
          mentions.push(`**${name}**`);
        }
      } catch {
        mentions.push(`**${name}**`);
      }
    }

    return `\ud83c\udfb2 Pinged: ${mentions.join(' ')}`;
  }

  // OWNER intent: "who is the owner", "server owner", "owner", etc.
  if (/^(who is the )?owner\??$/.test(lower) || /^owner$/.test(lower)) {
    const metadata = getGuildMetadata(guildId);
    if (metadata?.owner_id) {
      const owner = getGuildUser(guildId, metadata.owner_id);
      const ownerName = owner?.display_name || `User${metadata.owner_id.slice(-4)}`;
      return `Server owner: **${ownerName}** (${metadata.owner_id})`;
    }
    return null;
  }

  // FIND USER intent: "find user X", "who is X", "locate X", etc.
  const findUserMatch = lower.match(
    /^(?:find|who is|locate|search for|get) (?:user )?([\w\s'-]+)\??$/i
  );
  if (findUserMatch) {
    const userName = findUserMatch[1]?.trim();
    if (userName && userName.length > 1) {
      const allUsers = getGuildUserNames(guildId, 100) || [];
      const matches = allUsers.filter((name) =>
        normalize(name).includes(normalize(userName))
      );
      if (matches.length > 0) {
        const best = matches[0];
        return `Found: **${best}**`;
      }
    }
    return null;
  }

  // LIST ROLE MEMBERS intent: "who has role X", "list X members", "users with X", etc.
  const roleMatch = lower.match(
    /^(?:who has|list|show|users with|members with|members in) (?:the )?(?:role )?([^?]+)\??$/i
  );
  if (roleMatch) {
    const roleName = roleMatch[1]?.trim();
    if (roleName && roleName.length > 1) {
      const roles = getGuildRoles(guildId) || [];
      const role = findRoleByName(roles, roleName);
      if (role) {
        const count = getRoleMemberCount(guildId, role.role_id);
        const names = getRoleMemberNames(guildId, role.role_id, 8);
        const namesStr = names && names.length > 0 ? ` (e.g., ${names.join(', ')})` : '';
        return `**${role.role_name}**: ${count} member${count === 1 ? '' : 's'}${namesStr}`;
      }
    }
    return null;
  }

  // RANDOM MEMBER intent: "random", "pick someone", "who should i", etc. (but NOT "ping")
  if (/^(?:random|who should i|choose someone|pick someone)\??$/i.test(lower)) {
    const recentUsers = getGuildUserNames(guildId, 50) || [];
    if (recentUsers.length > 0) {
      const chosen = recentUsers[Math.floor(Math.random() * recentUsers.length)];
      return `\ud83c\udfb2 Picked: **${chosen}**`;
    }
    return null;
  }

  // No intent matched
  return null;
}
