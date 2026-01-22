import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MODEL = process.env.GROK_MODEL || 'grok-4-1-fast-reasoning-latest';
const DEFAULT_VISION_MODEL = process.env.GROK_VISION_MODEL || 'grok-4-1-fast-reasoning-latest';

// Configurable LLM parameters for enhanced intelligence
// Helper to parse and validate numeric parameters
function parseEnvFloat(envVar, defaultValue, min = -Infinity, max = Infinity) {
  if (envVar === undefined) return defaultValue;
  const parsed = parseFloat(envVar);
  if (isNaN(parsed)) {
    console.warn(`Invalid numeric value for parameter: "${envVar}". Using default: ${defaultValue}`);
    return defaultValue;
  }
  if (parsed < min || parsed > max) {
    console.warn(`Value ${parsed} out of range [${min}, ${max}]. Using default: ${defaultValue}`);
    return defaultValue;
  }
  return parsed;
}

function parseEnvInt(envVar, defaultValue, min = -Infinity, max = Infinity) {
  if (envVar === undefined) return defaultValue;
  const parsed = parseInt(envVar, 10);
  if (isNaN(parsed)) {
    console.warn(`Invalid integer value for parameter: "${envVar}". Using default: ${defaultValue}`);
    return defaultValue;
  }
  if (parsed < min || parsed > max) {
    console.warn(`Value ${parsed} out of range [${min}, ${max}]. Using default: ${defaultValue}`);
    return defaultValue;
  }
  return parsed;
}

const LLM_TEMPERATURE = parseEnvFloat(process.env.LLM_TEMPERATURE, 0.3, 0.0, 2.0);
const LLM_TOP_P = parseEnvFloat(process.env.LLM_TOP_P, 0.9, 0.0, 1.0);
const LLM_PRESENCE_PENALTY = parseEnvFloat(process.env.LLM_PRESENCE_PENALTY, 0.1, -2.0, 2.0);
const LLM_FREQUENCY_PENALTY = parseEnvFloat(process.env.LLM_FREQUENCY_PENALTY, 0.2, -2.0, 2.0);
const LLM_MAX_TOKENS = parseEnvInt(process.env.LLM_MAX_TOKENS, 4096, 1, 131072);

function normalizeBaseUrl(baseUrl) {
  if (!baseUrl) return '';
  let url = baseUrl.replace(/\/+$/, '');
  while (url.endsWith('/v1')) {
    url = url.slice(0, -3);
  }
  return url;
}

// Load the system prompt from env text or file; fall back to a baked-in default.
const systemPrompt = (() => {
  if (process.env.SYSTEM_PROMPT) return process.env.SYSTEM_PROMPT;

  const promptPath = process.env.SYSTEM_PROMPT_FILE || './prompts/system_prompt.txt';
  const resolved = path.resolve(process.cwd(), promptPath);

  try {
    const raw = fs.readFileSync(resolved, 'utf8');
    return raw;
  } catch (err) {
    console.warn(`Falling back to default system prompt; failed to load ${resolved}: ${err.message}`);
    return (
      'You are {BOT_NAME}, an advanced AI assistant integrated into a Discord server. ' +
      'Provide helpful, concise, and friendly responses to user queries. ' +
      'When appropriate, use markdown formatting for code snippets and lists. ' +
      'If you do not know the answer, respond with "idk tbh".'
    );
  }
})();

const fallbackErrorLine =
  'cant answer rn bro too busy gooning (grok api error)';

function buildMessages({
  botName,
  profileSummary,
  recentTurns,
  userContent,
  replyContext,
  imageInputs,
  recentUserMessages,
  recentChannelMessages,
  channelSummary,
  guildSummary,
  knownUsers,
  serverContext,
  userContext,
}) {
  const messages = [
    {
      role: 'system',
      content: systemPrompt.replace('{BOT_NAME}', botName),
    },
  ];

  if (serverContext) {
    messages.push({
      role: 'system',
      content: `Server info:\n${serverContext}`,
    });
  }

  if (userContext) {
    messages.push({
      role: 'system',
      content: `User info:\n${userContext}`,
    });
  }

  if (replyContext) {
    messages.push({
      role: 'system',
      content: replyContext,
    });
  }

  if (profileSummary) {
    messages.push({
      role: 'system',
      content: `User profile summary: ${profileSummary}`,
    });
  }

  if (recentUserMessages?.length) {
    const formatted = recentUserMessages.map((msg) => `- ${msg}`).join('\n');
    messages.push({
      role: 'system',
      content: `Recent user messages:\n${formatted}`,
    });
  }

  if (channelSummary) {
    messages.push({
      role: 'system',
      content: `Channel summary: ${channelSummary}`,
    });
  }

  if (guildSummary) {
    messages.push({
      role: 'system',
      content: `Server summary: ${guildSummary}`,
    });
  }

  if (knownUsers?.length) {
    messages.push({
      role: 'system',
      content: `Known users in this server: ${knownUsers.join(', ')}`,
    });
  }

  if (recentChannelMessages?.length) {
    const formatted = recentChannelMessages.map((msg) => `- ${msg}`).join('\n');
    messages.push({
      role: 'system',
      content: `Recent channel messages:\n${formatted}`,
    });
  }

  for (const turn of recentTurns) {
    messages.push({ role: turn.role, content: turn.content });
  }

  if (imageInputs?.length) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: userContent },
        ...imageInputs.map((url) => ({
          type: 'image_url',
          image_url: { url, detail: 'high' },
        })),
      ],
    });
  } else {
    messages.push({ role: 'user', content: userContent });
  }
  return messages;
}

async function callOnce({
  botName,
  profileSummary,
  recentTurns,
  userContent,
  replyContext,
  imageInputs,
  recentUserMessages,
  recentChannelMessages,
  channelSummary,
  guildSummary,
  knownUsers,
  serverContext,
  userContext,
}) {
  const model = imageInputs?.length ? DEFAULT_VISION_MODEL || DEFAULT_MODEL : DEFAULT_MODEL;
  const baseUrl = normalizeBaseUrl(process.env.GROK_BASE_URL);
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GROK_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      // Enhanced parameters for more intelligent responses
      temperature: LLM_TEMPERATURE,
      top_p: LLM_TOP_P,
      presence_penalty: LLM_PRESENCE_PENALTY,
      frequency_penalty: LLM_FREQUENCY_PENALTY,
      max_tokens: LLM_MAX_TOKENS,
      messages: buildMessages({
        botName,
        profileSummary,
        recentTurns,
        userContent,
        replyContext,
        imageInputs,
        recentUserMessages,
        recentChannelMessages,
        channelSummary,
        guildSummary,
        knownUsers,
        serverContext,
        userContext,
      }),
    }),
  });

  if (!res.ok) {
    const bodyText = await res.text();
    if (
      imageInputs?.length &&
      /image|vision|multimodal|unsupported|not\s+enabled/i.test(bodyText)
    ) {
      const err = new Error('VISION_UNSUPPORTED');
      err.code = 'VISION_UNSUPPORTED';
      throw err;
    }
    throw new Error(`LLM error: ${res.status} ${bodyText}`);
  }

  const data = await res.json();
  return data?.choices?.[0]?.message?.content?.trim() || 'idk tbh';
}

export async function getLLMResponse({
  botName,
  profileSummary,
  recentTurns,
  userContent,
  replyContext,
  imageInputs,
  recentUserMessages,
  recentChannelMessages,
  channelSummary,
  guildSummary,
  knownUsers,
  serverContext,
  userContext,
}) {
  try {
    return await callOnce({
      botName,
      profileSummary,
      recentTurns,
      userContent,
      replyContext,
      imageInputs,
      recentUserMessages,
      recentChannelMessages,
      channelSummary,
      guildSummary,
      knownUsers,
      serverContext,
      userContext,
    });
  } catch (err) {
    if (err?.code === 'VISION_UNSUPPORTED') {
      return 'image input needs a vision-capable model. set GROK_VISION_MODEL or use a multimodal GROK_MODEL.';
    }
    console.error('LLM request failed (first attempt):', err);
    await delay(300);
    try {
      return await callOnce({
        botName,
        profileSummary,
        recentTurns,
        userContent,
        replyContext,
        imageInputs,
        recentUserMessages,
        recentChannelMessages,
        channelSummary,
        guildSummary,
        knownUsers,
        serverContext,
        userContext,
      });
    } catch (retryErr) {
      if (retryErr?.code === 'VISION_UNSUPPORTED') {
        return 'image input needs a vision-capable model. set GROK_VISION_MODEL or use a multimodal GROK_MODEL.';
      }
      console.error('LLM request failed (retry):', retryErr);
      return fallbackErrorLine;
    }
  }
}
