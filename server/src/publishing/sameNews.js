import { pool } from '../db/pool.js';

// Second duplicate check, on the finished English posts: the same event can
// reach the queue twice when two reports weren't matched as one story (other
// wording, other language, a different first detail). Before a post is
// queued or sent, it is compared with what that channel — and the channels
// sharing its exclusiveGroup — posted or queued recently: the same set of
// words, or a good overlap plus the same specific figures, means the same news.
const WINDOW_HOURS = Number(process.env.SAME_NEWS_WINDOW_HOURS || 12);
const SAME = Number(process.env.SAME_NEWS_SIMILARITY || 0.5);
const SAME_WITH_NUMBERS = Number(process.env.SAME_NEWS_SIMILARITY_WITH_NUMBERS || 0.3);

const STOP = new Set(
  'the and for that with from this have has had was were are been will would said says say after over into about their they them than then there which while also more most other some such only just what when where who whom whose why how its his her our out not but can could should may might all any each both few new now one two three per via amid near under upon against between during without within'.split(' ')
);

// Content words: no @handles, #hashtags, links, emoji, footers or stop words.
export function contentWords(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/https?:\/\/\S+|t\.me\/\S+/g, ' ')
      .replace(/[@#][\p{L}\p{N}_]+/gu, ' ')
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w))
  );
}

export function figures(text) {
  return new Set((String(text || '').match(/\d[\d,.]*/g) || []).map((n) => n.replace(/[,.](?=\d{3}\b)/g, '')).filter((n) => n.replace(/\D/g, '').length >= 2));
}

export function similarity(a, b) {
  const A = contentWords(a);
  const B = contentWords(b);
  if (A.size < 4 || B.size < 4) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  // Share of the shorter post's words found in the other: a short and a long
  // version of the same report still match.
  return inter / Math.min(A.size, B.size);
}

export function isSameNews(a, b) {
  const s = similarity(a, b);
  if (s >= SAME) return true;
  if (s >= SAME_WITH_NUMBERS) {
    const fa = figures(a);
    for (const n of figures(b)) if (fa.has(n)) return true;
  }
  return false;
}

// The recent post on `channelKeys` that carries the same news as `text`
// (excluding publication `exceptId`), or null.
export async function findSameNews(text, channelKeys, { exceptId = null } = {}) {
  if (!text || channelKeys.length === 0) return null;
  const { rows } = await pool.query(
    `SELECT id, channel_key, final_text FROM publications
     WHERE channel_key = ANY($1) AND kind = 'post' AND id <> coalesce($2::bigint, -1)
       AND status IN ('published', 'sending', 'approved', 'sent_manually')
       AND coalesce(published_at, approved_at, updated_at) > now() - make_interval(hours => $3)`,
    [channelKeys, exceptId, WINDOW_HOURS]
  );
  return rows.find((r) => isSameNews(text, r.final_text)) || null;
}

// Channels a post must not repeat: its own and the others in its exclusiveGroup.
export function sameNewsChannels(config, channel) {
  return config.channels
    .filter((c) => c.key === channel.key || (channel.exclusiveGroup && c.exclusiveGroup === channel.exclusiveGroup))
    .map((c) => c.key);
}
