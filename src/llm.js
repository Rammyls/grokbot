import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_MODEL = process.env.GROK_MODEL || 'grok-4';
const DEFAULT_VISION_MODEL = process.env.GROK_VISION_MODEL || '';

function normalizeBaseUrl(baseUrl) {
  if (!baseUrl) return '';
  let url = baseUrl.replace(/\/+$/, '');
  while (url.endsWith('/v1')) {
    url = url.slice(0, -3); // remove the trailing "/v1"
  }
  return url;
}

const systemPrompt = `system prompt here`;

const fallbackErrorLine =
  'cant answer rn bro too busy gooning (grok servers left like my dad)';

function buildMessages({
  botName,
  profileSummary,
  recentTurns,
  userContent,
  replyContext,
  imageInputs,
}) {
  const messages = [
    {
      role: 'system',
      content: systemPrompt.replace('{BOT_NAME}', botName),
    },
  ];

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
      temperature: 0.8,
      max_tokens: 250,
      messages: buildMessages({
        botName,
        profileSummary,
        recentTurns,
        userContent,
        replyContext,
        imageInputs,
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
}) {
  try {
    return await callOnce({
      botName,
      profileSummary,
      recentTurns,
      userContent,
      replyContext,
      imageInputs,
    });
  } catch (err) {
    if (err?.code === 'VISION_UNSUPPORTED') {
      return 'image input needs a vision-capable model. set GROK_VISION_MODEL or use a multimodal GROK_MODEL.';
    }
    await delay(300);
    try {
      return await callOnce({
        botName,
        profileSummary,
        recentTurns,
        userContent,
        replyContext,
        imageInputs,
      });
    } catch (retryErr) {
      if (retryErr?.code === 'VISION_UNSUPPORTED') {
        return 'image input needs a vision-capable model. set GROK_VISION_MODEL or use a multimodal GROK_MODEL.';
      }
      return fallbackErrorLine;
    }
  }
}
