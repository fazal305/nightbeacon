import crypto from 'node:crypto';

// Deterministic, language-agnostic text normalization for duplicate
// detection. It only removes things that differ between relays of the same
// post (links, @mentions, channel signatures, emoji, punctuation, letter
// variants) — words and numbers are kept, because those are what make two
// reports different stories.

const ARABIC_INDIC_DIGITS = /[٠-٩]/g;
const PERSIAN_DIGITS = /[۰-۹]/g;
const ARABIC_DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭ]/g; // harakat, Quranic marks
const TATWEEL = /ـ/g;
const URL_RE = /\b(?:https?:\/\/|www\.|t\.me\/)\S+/gi;
const MENTION_RE = /@[\p{L}\p{N}_]{3,}/gu;
const HASHTAG_MARK_RE = /#(?=[\p{L}\p{N}_])/gu;
// Anything that isn't a letter, number, or whitespace (emoji, punctuation,
// symbols, zero-width joiners) becomes a space.
const NON_WORD_RE = /[^\p{L}\p{N}\s]+/gu;

// Letter variants Arabic-script writers use interchangeably (Arabic vs
// Persian/Urdu keyboards, hamza forms). Folding them means the same Persian
// post typed on an Arabic keyboard still hashes identically.
const LETTER_FOLDS = [
  [/[ىیئ]/g, 'ي'], // alef maksura / farsi yeh / yeh-hamza -> yeh
  [/ک/g, 'ك'], // keheh -> kaf
  [/[آأإٱ]/g, 'ا'], // alef with madda/hamza/wasla -> alef
  [/[ةۀہھ]/g, 'ه'], // ta marbuta, heh variants (incl. Urdu) -> heh
  [/ؤ/g, 'و'], // waw-hamza -> waw
];

export function normalizeText(text) {
  if (!text) return '';
  let s = text.normalize('NFKC');
  s = s.replace(URL_RE, ' ').replace(MENTION_RE, ' ').replace(HASHTAG_MARK_RE, '');
  s = s
    .replace(ARABIC_INDIC_DIGITS, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(PERSIAN_DIGITS, (d) => String(d.charCodeAt(0) - 0x06f0));
  s = s.replace(ARABIC_DIACRITICS, '').replace(TATWEEL, '');
  for (const [re, to] of LETTER_FOLDS) s = s.replace(re, to);
  s = s.toLowerCase();
  // Thousands separators ("1,200" / "1.200" / "1٬200") would otherwise split
  // one number into two tokens once punctuation is stripped.
  s = s.replace(/(\d)[,.٬'](?=\d{3}\b)/g, '$1');
  s = s.replace(NON_WORD_RE, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

export function contentHash(normalized) {
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

// Numbers are the one piece of event detail that survives translation
// unchanged (casualty counts, dates, unit numbers), so they're used both as
// corroborating evidence for a cross-language match and to recognise a
// genuine update ("3 killed" -> "7 killed"). Extracted from the raw text so
// clock times ("14:30" — relays often restamp them) can be dropped before
// punctuation is lost. Single digits are ignored: too common ("2 sources
// say") to be evidence of anything.
export function extractNumbers(text) {
  if (!text) return [];
  let s = text.normalize('NFKC').replace(URL_RE, ' ').replace(MENTION_RE, ' ');
  s = s
    .replace(ARABIC_INDIC_DIGITS, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(PERSIAN_DIGITS, (d) => String(d.charCodeAt(0) - 0x06f0));
  s = s.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ');
  s = s.replace(/(\d)[,.٬'](?=\d{3}\b)/g, '$1');
  const found = new Set();
  for (const m of s.matchAll(/[0-9]+/g)) {
    const n = m[0].replace(/^0+(?=\d)/, '');
    if (n.length >= 2) found.add(n);
  }
  return [...found].sort();
}

// Posts that are just a few words ("Breaking", "Video", "🔴 Urgent") are too
// short for fuzzy or semantic matching to mean anything — only an exact
// hash match may dedup them.
export const MIN_FUZZY_LENGTH = 25;
