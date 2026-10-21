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
//   bing            Microsoft's free endpoint behind the Edge browser's
//                   translate button (short-lived token, no key). Unofficial.
//   yandex          Yandex Translate's free app endpoint (no key). Unofficial;
//                   strong for Russian/Ukrainian.
//   microsoft       Microsoft Translator (Azure), official: free F0 tier,
//                   ~2M characters a month. MS_TRANSLATOR_KEY (+ _REGION).
//   mymemory        MyMemory (no key; MYMEMORY_EMAIL raises the daily cap to
//                   ~50k characters). Small, a last resort.
//   deepl           DeepL API Free, ~500k characters a month (DEEPL_API_KEY).
//   cloudflare      Cloudflare Workers AI m2m100 translation model, free daily
//                   allowance (CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN).
//   huggingface     a chat model on Hugging Face's inference router (HF_TOKEN).
//   nllb            Meta's NLLB-200 translation model running locally
//                   (tools/nllb, NLLB_URL). Free, unlimited, offline; needs
//                   the source language, guessed by guessNllbLanguage().
//
// Each returns { text, lang } or throws. err.systemic = true means "this
// provider is unavailable / rate-limited right now" (try another provider and
// rest this one); otherwise the error is about this one post.

import crypto from 'node:crypto';

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
    // 429 / 403 (blocked, quota) / 5xx: the provider, not the post. 401 (bad
    // or missing key): rest an hour. 4xx otherwise: something about this post.
    if (res.status === 401) throw providerError(name, `HTTP 401 ${body.slice(0, 120)}`, true, 3600_000);
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
  return { text: decodeEntities(json.translatedText), lang: json.detectedLanguage?.language || null };
}

// Microsoft Translator reply (official API and the Edge endpoint alike):
// [{ detectedLanguage: { language }, translations: [{ text, to }] }]
export function parseMicrosoftReply(name, json) {
  const t = Array.isArray(json) ? json[0]?.translations?.[0]?.text : null;
  if (typeof t !== 'string') throw providerError(name, 'unexpected reply', true);
  return { text: t, lang: json[0]?.detectedLanguage?.language || null };
}

let edgeToken = { value: null, expires: 0 };
async function bing(text) {
  if (!edgeToken.value || Date.now() > edgeToken.expires) {
    let res;
    try {
      res = await fetch('https://edge.microsoft.com/translate/auth', { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw providerError('bing', err.cause?.code || err.message, true);
    }
    if (!res.ok) throw providerError('bing', `token HTTP ${res.status}`, true);
    // The token lasts ~10 minutes; renew a little early.
    edgeToken = { value: (await res.text()).trim(), expires: Date.now() + 8 * 60_000 };
  }
  const parts = [];
  let lang = null;
  for (const piece of splitText(text, 4500)) {
    const json = await request('bing', 'https://api-edge.cognitive.microsofttranslator.com/translate?api-version=3.0&to=en', {
      method: 'POST',
      headers: { Authorization: `Bearer ${edgeToken.value}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ Text: piece }]),
    }).catch((err) => {
      if (/HTTP 401/.test(err.message)) edgeToken = { value: null, expires: 0 };
      throw err;
    });
    const r = parseMicrosoftReply('bing', json);
    parts.push(r.text);
    lang = lang || r.lang;
  }
  return { text: parts.join(''), lang };
}

async function microsoft(text) {
  const key = process.env.MS_TRANSLATOR_KEY;
  if (!key) throw providerError('microsoft', 'MS_TRANSLATOR_KEY is not set', true, 3600_000);
  const parts = [];
  let lang = null;
  for (const piece of splitText(text, 4500)) {
    const json = await request('microsoft', 'https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=en', {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        ...(process.env.MS_TRANSLATOR_REGION ? { 'Ocp-Apim-Subscription-Region': process.env.MS_TRANSLATOR_REGION } : {}),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([{ Text: piece }]),
    });
    const r = parseMicrosoftReply('microsoft', json);
    parts.push(r.text);
    lang = lang || r.lang;
  }
  return { text: parts.join(''), lang };
}

// Yandex's app endpoint: target language only, source auto-detected.
// Reply: { code: 200, lang: "ar-en", text: ["…"] }
export function parseYandexReply(json) {
  if (json?.code !== 200 || !Array.isArray(json.text)) throw providerError('yandex', `unexpected reply ${JSON.stringify(json).slice(0, 80)}`, true);
  return { text: json.text.join(''), lang: typeof json.lang === 'string' ? json.lang.split('-')[0] : null };
}

const yandexId = crypto.randomUUID().replace(/-/g, '');
async function yandex(text) {
  const parts = [];
  let lang = null;
  for (const piece of splitText(text, 4500)) {
    const json = await request('yandex', `https://translate.yandex.net/api/v1/tr.json/translate?ucid=${yandexId}&srv=android&format=text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({ text: piece, lang: 'en' }).toString(),
    });
    const r = parseYandexReply(json);
    parts.push(r.text);
    lang = lang || r.lang;
  }
  return { text: parts.join(''), lang };
}

// NLLB needs the source language. Guessed from the script, then from letters
// only some languages use: Persian/Urdu/Kurdish vs Arabic, Ukrainian vs
// Russian, Turkish/Azerbaijani vs other Latin-script text. null = not sure:
// the post is left to the next provider rather than mistranslated.
export function guessNllbLanguage(text) {
  const t = String(text || '');
  const count = (re) => (t.match(re) || []).length;
  const scripts = {
    arabic: count(/[\u0600-\u06FF]/g),
    cyrillic: count(/[\u0400-\u04FF]/g),
    hebrew: count(/[\u0590-\u05FF]/g),
    devanagari: count(/[\u0900-\u097F]/g),
    cjk: count(/[\u4E00-\u9FFF]/g),
    latin: count(/[A-Za-z\u00C0-\u024F\u0259]/g),
  };
  const [script, n] = Object.entries(scripts).sort((a, b) => b[1] - a[1])[0];
  if (!n) return null;
  if (script === 'arabic') {
    if (/[ڵڕێۆ]/.test(t)) return 'ckb_Arab';
    if (/[ٹڈڑںے]/.test(t)) return 'urd_Arab';
    const persian = count(/[پچژگکی]/g);
    const arabic = count(/[يكةى]/g);
    return persian > arabic ? 'pes_Arab' : 'arb_Arab';
  }
  if (script === 'cyrillic') return /[іїєґ]/i.test(t) ? 'ukr_Cyrl' : 'rus_Cyrl';
  if (script === 'hebrew') return 'heb_Hebr';
  if (script === 'devanagari') return 'hin_Deva';
  if (script === 'cjk') return 'zho_Hans';
  if (/ə/i.test(t)) return 'azj_Latn';
  if (/[ğışİ]/i.test(t)) return 'tur_Latn';
  const words = t.toLowerCase().split(/[^a-zà-ÿ]+/);
  const hits = (list) => words.filter((w) => list.includes(w)).length;
  const fr = hits(['le', 'la', 'les', 'des', 'est', 'une', 'dans', 'sur', 'pour', 'avec']);
  const es = hits(['el', 'los', 'las', 'del', 'que', 'una', 'por', 'para', 'con', 'en']);
  const de = hits(['der', 'die', 'das', 'und', 'nicht', 'mit', 'von', 'ist', 'ein', 'eine']);
  const best = Math.max(fr, es, de);
  if (best < 2) return null;
  return best === fr ? 'fra_Latn' : best === es ? 'spa_Latn' : 'deu_Latn';
}

// NLLB code -> ISO 639-1, for the services that want a plain source code.
const ISO = { arb: 'ar', pes: 'fa', urd: 'ur', ckb: 'ckb', rus: 'ru', ukr: 'uk', heb: 'he', hin: 'hi', zho: 'zh', tur: 'tr', azj: 'az', fra: 'fr', spa: 'es', deu: 'de' };
export const isoLanguage = (text) => {
  const g = guessNllbLanguage(text);
  return g ? ISO[g.slice(0, 3)] : null;
};

// MyMemory: max 500 bytes per request (Arabic is 2 bytes a letter), so
// posts go in small pieces. A daily cap reached shows up as a warning text.
async function mymemory(text) {
  const src = isoLanguage(text);
  if (!src) throw providerError('mymemory', 'could not tell the source language', false);
  const parts = [];
  for (const piece of splitText(text, 220)) {
    const params = new URLSearchParams({ q: piece, langpair: `${src}|en` });
    if (process.env.MYMEMORY_EMAIL) params.set('de', process.env.MYMEMORY_EMAIL);
    const json = await request('mymemory', `https://api.mymemory.translated.net/get?${params}`, { method: 'GET' });
    const out = json?.responseData?.translatedText;
    if (Number(json?.responseStatus) === 429 || /MYMEMORY WARNING|QUOTA/i.test(out || '')) {
      throw providerError('mymemory', 'daily free allowance used up', true, 3600_000);
    }
    if (typeof out !== 'string') throw providerError('mymemory', 'unexpected reply', true);
    parts.push(out);
  }
  return { text: parts.join(' '), lang: src };
}

async function deepl(text) {
  const key = process.env.DEEPL_API_KEY;
  if (!key) throw providerError('deepl', 'DEEPL_API_KEY is not set', true, 3600_000);
  const host = key.endsWith(':fx') ? 'api-free.deepl.com' : 'api.deepl.com';
  let json;
  try {
    json = await request('deepl', `https://${host}/v2/translate`, {
      method: 'POST',
      headers: { Authorization: `DeepL-Auth-Key ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: [text], target_lang: 'EN-US' }),
    });
  } catch (err) {
    // 456: the month's free characters are used up.
    if (/HTTP 456/.test(err.message)) throw providerError('deepl', 'monthly free allowance used up', true, 6 * 3600_000);
    throw err;
  }
  const t = json?.translations?.[0];
  if (typeof t?.text !== 'string') throw providerError('deepl', 'unexpected reply', true);
  return { text: t.text, lang: t.detected_source_language ? t.detected_source_language.toLowerCase() : null };
}

async function cloudflare(text) {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) throw providerError('cloudflare', 'CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN are not set', true, 3600_000);
  const src = isoLanguage(text);
  if (!src) throw providerError('cloudflare', 'could not tell the source language', false);
  const parts = [];
  for (const piece of splitText(text, 1500)) {
    const json = await request('cloudflare', `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/meta/m2m100-1.2b`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: piece, source_lang: src, target_lang: 'en' }),
    });
    const out = json?.result?.translated_text;
    if (typeof out !== 'string') throw providerError('cloudflare', `unexpected reply ${JSON.stringify(json?.errors || json).slice(0, 80)}`, true);
    parts.push(out);
  }
  return { text: parts.join(' '), lang: src };
}

async function huggingface(text) {
  if (!process.env.HF_TOKEN) throw providerError('huggingface', 'HF_TOKEN is not set', true, 3600_000);
  // Hugging Face no longer serves NLLB on its free router, so this uses a
  // chat model there (HF_LLM_MODEL) with a plain translation instruction.
  const { callLLM } = await import('./llmClient.js');
  let content;
  try {
    ({ content } = await callLLM(
      [
        { role: 'system', content: 'Translate the user\'s text into fluent English. Keep every number, name and place exactly; keep line breaks. Reply with ONLY the translation.' },
        { role: 'user', content: text },
      ],
      { providerName: 'huggingface', temperature: 0.1 }
    ));
  } catch (err) {
    const status = Number(err.message.match(/\((\d{3})\)/)?.[1]);
    throw providerError('huggingface', err.message.slice(0, 200), !status || status === 429 || status === 402 || status >= 500 || status === 401 || status === 403, status === 402 ? 6 * 3600_000 : null);
  }
  const lang = guessNllbLanguage(text);
  return { text: content.trim(), lang: lang ? lang.slice(0, 3) : null };
}

async function nllb(text) {
  const base = (process.env.NLLB_URL || '').replace(/\/$/, '');
  if (!base) throw providerError('nllb', 'NLLB_URL is not set', true, 3600_000);
  const src = guessNllbLanguage(text);
  if (!src) throw providerError('nllb', 'could not tell the source language', false);
  const json = await request('nllb', `${base}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, src }),
  });
  if (typeof json?.text !== 'string') throw providerError('nllb', 'unexpected reply', true);
  return { text: json.text, lang: src.slice(0, 3) };
}

// Some engines (LibreTranslate/Argos especially) return HTML entities.
export function decodeEntities(text) {
  return String(text)
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// A broken machine translation must not be stored as if it were one: the
// post is then offered to the next translator instead. Catches the failure
// modes seen from weaker engines: empty output for real text, a token
// repeated over and over ("| | | |", "ter ter ter", "People's People's"),
// runs of underscores, and output that is mostly symbols.
export function looksDegenerate(source, translated) {
  const out = String(translated || '').trim();
  const src = String(source || '').trim();
  const srcLetters = (src.match(/\p{L}/gu) || []).length;
  if (!out) return srcLetters > 3;
  if (/_{5,}/.test(out)) return true;
  const tokens = out.toLowerCase().split(/\s+/).filter(Boolean);
  let run = 1;
  for (let i = 1; i < tokens.length; i++) {
    run = tokens[i] === tokens[i - 1] ? run + 1 : 1;
    if (run >= 5) return true;
  }
  if (tokens.length >= 12) {
    const counts = new Map();
    for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
    if (Math.max(...counts.values()) / tokens.length > 0.35) return true;
  }
  const outLetters = (out.match(/\p{L}/gu) || []).length;
  if (srcLetters >= 20 && outLetters < srcLetters * 0.2) return true;
  return false;
}

export const WEB_TRANSLATORS = {
  google, lingva, libretranslate, bing, yandex, microsoft, nllb, mymemory, deepl, cloudflare, huggingface,
};

// Requests per minute each one is allowed by default (one request per post).
export const WEB_TRANSLATOR_RATES = {
  google: Number(process.env.GOOGLE_TRANSLATE_PER_MINUTE || 60),
  lingva: Number(process.env.LINGVA_TRANSLATE_PER_MINUTE || 30),
  libretranslate: Number(process.env.LIBRETRANSLATE_PER_MINUTE || 120),
  bing: Number(process.env.BING_TRANSLATE_PER_MINUTE || 60),
  yandex: Number(process.env.YANDEX_TRANSLATE_PER_MINUTE || 30),
  microsoft: Number(process.env.MS_TRANSLATOR_PER_MINUTE || 60),
  nllb: Number(process.env.NLLB_PER_MINUTE || 120),
  mymemory: Number(process.env.MYMEMORY_PER_MINUTE || 10),
  deepl: Number(process.env.DEEPL_PER_MINUTE || 30),
  cloudflare: Number(process.env.CLOUDFLARE_PER_MINUTE || 30),
  huggingface: Number(process.env.HF_TRANSLATE_PER_MINUTE || 10),
};
