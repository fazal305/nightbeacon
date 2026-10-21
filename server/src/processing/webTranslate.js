// Free web translators, used in rotation with Telegram's own translation
// (TRANSLATION_PROVIDER=telegram,google,lingva,…, see translate.js):
//
//   google          Google Translate's free web endpoint (translate.googleapis.com,
//                   client=gtx — the one the browser widget and translate-shell
//                   use). No key. Unofficial: heavy use gets a temporary 429.
//   lingva          Lingva Translate (github.com/thedaviddelta/lingva-translate),
//                   open-source front-end for Google Translate. Public
//                   instances in LINGVA_URLS; you can also self-host one.
//   libretranslate  LibreTranslate (github.com/LibreTranslate/LibreTranslate),
//                   fully open-source and offline, self-hosted:
//                   `pip install libretranslate` then `libretranslate`, and
//                   LIBRETRANSLATE_URL=http://localhost:5000. No limits at all.
//
// Each returns { text, lang } or throws. err.systemic = true means "this
// provider is unavailable / rate-limited right now" (try another provider and
// rest this one); otherwise the error is about this one post.

const TIMEOUT_MS = Number(process.env.WEB_TRANSLATE_TIMEOUT_MS || 20000);

function providerError(name, message, systemic, retryAfterMs = null) {
  const err = new Error(`${name}: ${message}`);
  err.systemic = systemic;
  err.retryAfterMs = retryAfterMs;
  return err;
}

async function request(name, url, init) {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    // Network down, DNS, blocked, timeout: not the post's fault.
    throw providerError(name, err.cause?.code || err.message, true);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const retryAfter = Number(res.headers?.get?.('retry-after'));
    // 429 / 403 (blocked) / 5xx: the provider, not the post. 4xx otherwise:
    // something about this post (e.g. too long).
    const systemic = res.status === 429 || res.status === 403 || res.status >= 500;
    throw providerError(name, `HTTP ${res.status} ${body.slice(0, 120)}`, systemic, retryAfter > 0 ? retryAfter * 1000 : null);
  }
  try {
    return await res.json();
  } catch {
    throw providerError(name, 'reply is not JSON', true);
  }
}

// Long posts are split on paragraph/sentence boundaries so each request
// stays under the endpoint's size limit.
export function splitText(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const pieces = [];
  let rest = text;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    let cut = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('. '), window.lastIndexOf('。'));
    if (cut < maxChars / 2) cut = window.lastIndexOf(' ');
    if (cut < maxChars / 2) cut = maxChars - 1;
    pieces.push(rest.slice(0, cut + 1));
    rest = rest.slice(cut + 1);
  }
  if (rest) pieces.push(rest);
  return pieces;
}

// translate.googleapis.com reply: [[["translated", "original", …], …], null, "ar", …]
export function parseGoogleReply(json) {
  if (!Array.isArray(json) || !Array.isArray(json[0])) throw providerError('google', 'unexpected reply', true);
  const text = json[0].map((seg) => (Array.isArray(seg) && typeof seg[0] === 'string' ? seg[0] : '')).join('');
  return { text, lang: typeof json[2] === 'string' ? json[2].toLowerCase() : null };
}

async function google(text) {
  const parts = [];
  let lang = null;
  for (const piece of splitText(text, 4500)) {
    const json = await request('google', 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({ q: piece }).toString(),
    });
    const r = parseGoogleReply(json);
    parts.push(r.text);
    lang = lang || r.lang;
  }
  return { text: parts.join(''), lang };
}

const lingvaUrls = () =>
  (process.env.LINGVA_URLS || 'https://lingva.ml,https://lingva.lunar.icu,https://lingva.garudalinux.org,https://translate.plausibility.cloud')
    .split(',')
    .map((u) => u.trim().replace(/\/$/, ''))
    .filter(Boolean);
let lingvaIndex = 0;

async function lingva(text) {
  const urls = lingvaUrls();
  let lastErr = null;
  // Instances come and go: try each once, starting from the last one that worked.
  for (let n = 0; n < urls.length; n++) {
    const base = urls[(lingvaIndex + n) % urls.length];
    try {
      const parts = [];
      let lang = null;
      // The text travels in the URL path, so pieces stay small.
      for (const piece of splitText(text, 1500)) {
        const json = await request('lingva', `${base}/api/v1/auto/en/${encodeURIComponent(piece)}`, { method: 'GET' });
        if (typeof json?.translation !== 'string') throw providerError('lingva', 'unexpected reply', true);
        parts.push(json.translation);
        lang = lang || json.info?.detectedSource || null;
      }
      lingvaIndex = (lingvaIndex + n) % urls.length;
      return { text: parts.join(' '), lang };
    } catch (err) {
      lastErr = err;
      if (!err.systemic) throw err;
    }
  }
  throw lastErr;
}

async function libretranslate(text) {
  const base = (process.env.LIBRETRANSLATE_URL || '').replace(/\/$/, '');
  if (!base) throw providerError('libretranslate', 'LIBRETRANSLATE_URL is not set', true, 3600_000);
  const json = await request('libretranslate', `${base}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      q: text,
      source: 'auto',
      target: 'en',
      format: 'text',
      ...(process.env.LIBRETRANSLATE_API_KEY ? { api_key: process.env.LIBRETRANSLATE_API_KEY } : {}),
    }),
  });
  if (typeof json?.translatedText !== 'string') throw providerError('libretranslate', 'unexpected reply', true);
  return { text: json.translatedText, lang: json.detectedLanguage?.language || null };
}

export const WEB_TRANSLATORS = { google, lingva, libretranslate };

// Requests per minute each one is allowed by default (one request per post).
export const WEB_TRANSLATOR_RATES = {
  google: Number(process.env.GOOGLE_TRANSLATE_PER_MINUTE || 60),
  lingva: Number(process.env.LINGVA_TRANSLATE_PER_MINUTE || 30),
  libretranslate: Number(process.env.LIBRETRANSLATE_PER_MINUTE || 120),
};
