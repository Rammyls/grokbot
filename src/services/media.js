import { isSafeHttpsUrl } from '../utils/validators.js';
import { MAX_IMAGE_BYTES, IMAGE_MIME } from '../utils/constants.js';
import { isGif, gifToPngSequence } from './gifProcessor.js';

export async function fetchImageAsDataUrl(url, resolveDirectMediaUrl) {
  const resolved = await resolveDirectMediaUrl(url);
  const finalUrl = resolved || url;
  const safe = await isSafeHttpsUrl(finalUrl);
  if (!safe) {
    console.warn('Image fetch blocked (unsafe URL):', finalUrl);
    return null;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(finalUrl, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) {
      console.warn('Image fetch failed:', finalUrl, response.status);
      return null;
    }
    if (response.url && response.url !== finalUrl) {
      const redirectSafe = await isSafeHttpsUrl(response.url);
      if (!redirectSafe) {
        console.warn('Image fetch blocked (unsafe redirect):', response.url);
        return null;
      }
    }
    const contentType = response.headers.get('content-type')?.split(';')[0] || '';

    const isGif = contentType === 'image/gif' || finalUrl.toLowerCase().endsWith('.gif');

    // For GIFs, skip inlining to avoid size limits; let the model fetch directly.
    if (isGif) {
      console.info('GIF passthrough for vision:', response.url || finalUrl);
      return response.url || finalUrl;
    }

    const validMimeTypes = [...IMAGE_MIME];

    if (!validMimeTypes.includes(contentType)) {
      console.warn('Image fetch rejected (invalid content-type):', contentType, finalUrl);
      return null;
    }

    const lengthHeader = response.headers.get('content-length');
    if (lengthHeader && Number(lengthHeader) > MAX_IMAGE_BYTES) {
      console.warn('Image fetch rejected (too large):', lengthHeader, finalUrl);
      return null;
    }
    if (!response.body) {
      console.warn('Image fetch failed (empty body):', finalUrl);
      return null;
    }
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > MAX_IMAGE_BYTES) {
        console.warn('Image fetch rejected (stream too large):', total, finalUrl);
        return null;
      }
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    const base64 = buffer.toString('base64');
    const mimeType = contentType || 'image/png';
    return `data:${mimeType};base64,${base64}`;
  } catch (err) {
    console.error('Image fetch threw error:', finalUrl, err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function parseGiphyIdFromUrl(u) {
  try {
    const url = new URL(u);
    if (!/giphy\.com$/i.test(url.hostname) && !/media\.giphy\.com$/i.test(url.hostname)) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'media' && parts[1]) return parts[1];
    if (parts[0] === 'gifs' && parts[1]) {
      const m = parts[1].match(/-([A-Za-z0-9]+)$/);
      if (m) return m[1];
    }
    return null;
  } catch {
    return null;
  }
}

function buildGiphyDirectUrl(id) {
  return `https://media.giphy.com/media/${id}/giphy.gif`;
}

async function resolveGiphyDirect(u, giphyApiKey) {
  try {
    const url = new URL(u);
    if (!/giphy\.com$/i.test(url.hostname) && !/media\.giphy\.com$/i.test(url.hostname)) return null;
  } catch {
    return null;
  }
  if (!giphyApiKey) {
    console.warn('GIPHY_API_KEY not set — Giphy URL resolution disabled');
    return null;
  }
  try {
    const giphyId = parseGiphyIdFromUrl(u);
    if (!giphyId) return null;
    return buildGiphyDirectUrl(giphyId);
  } catch (err) {
    console.error('Giphy direct resolution failed:', err);
    return null;
  }
}

export async function resolveDirectMediaUrl(u, giphyApiKey) {
  const imageExt = /\.(png|jpe?g|webp|gif)(\?.*)?$/i;
  if (imageExt.test(u)) return u;
  const giphyId = parseGiphyIdFromUrl(u);
  if (giphyId) return buildGiphyDirectUrl(giphyId);
  const giphy = await resolveGiphyDirect(u, giphyApiKey);
  if (giphy) return giphy;
  return null;
}

export async function searchGiphyGif(query, giphyApiKey) {
  if (!giphyApiKey) {
    console.warn('GIPHY_API_KEY not set — Giphy GIFs disabled');
    return null;
  }
  try {
    const url = new URL('https://api.giphy.com/v1/gifs/search');
    url.searchParams.set('q', query);
    url.searchParams.set('api_key', giphyApiKey);
    url.searchParams.set('limit', '1');
    url.searchParams.set('rating', 'g');
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) return null;
    const data = await res.json();
    const item = data?.data?.[0];
    const directUrl = item?.url || null;
    if (!directUrl) return null;
    const giphyId = directUrl.split('-').pop();
    return buildGiphyDirectUrl(giphyId);
  } catch (err) {
    console.error('Giphy API search failed:', err);
    return null;
  }
}

export async function getReplyContext(message) {
  const replyId = message.reference?.messageId;
  if (!replyId) return null;
  try {
    const referenced = await message.channel.messages.fetch(replyId);
    const text = referenced.content?.trim() || '';
    const { getMessageImageUrls, getMessageVideoUrls } = await import('../utils/validators.js');
    const images = getMessageImageUrls(referenced);
    const videos = getMessageVideoUrls(referenced);
    return {
      author: referenced.author?.username || 'Unknown',
      text,
      images,
      videos,
    };
  } catch {
    return null;
  }
}

export async function processGifUrl(url) {
  const isGifUrl = await isGif(url);
  if (!isGifUrl) return null;
  try {
    const frames = await gifToPngSequence(url);
    return frames.length > 0 ? frames : null;
  } catch (err) {
    console.error('Failed to process GIF:', err);
    return null;
  }
}
