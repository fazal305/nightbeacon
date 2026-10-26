import { pool } from '../db/pool.js';
import { callLLM } from '../processing/llmClient.js';
import { publishConfig, tzOf } from './config.js';
import { getStyleContext } from './style.js';
import { buildDigestMessages, parseDraft, applyTerminology, removeBannedFlags } from './prompt.js';

// Scheduled summary posts: at each of a channel's digest times (local time
// in PUBLISH_TIMEZONE), a roundup of the most important stories since the
// previous slot, written in the channel's style with the same rules as
// ordinary posts. Configured per channel in channels.json:
//   "digest": { "times": ["09:00", "21:00"], "maxStories": 10 }
// A slot missed by more than LATE_LIMIT (laptop off) is skipped rather than
// posted late. Bot channels in PUBLISH_MODE=auto post it automatically; in
// review mode it waits for approval; manual channels get it as a draft.
const LATE_LIMIT_MS = 60 * 60 * 1000;
const MIN_STORIES = 3;
const MAX_ATTEMPTS = 3;
const attempts = new Map(); // "channel|slot" -> failed attempts

// Milliseconds the zone is ahead of UTC at `date`.
export function tzOffsetMs(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// The most recent scheduled slot at or before `now`, and the one before it.
export function digestSlots(times, timeZone, now = new Date()) {
  const local = new Date(now.getTime() + tzOffsetMs(now, timeZone));
  const slots = [];
  for (const dayShift of [0, -1, -2]) {
    for (const t of times) {
      const [h, m] = t.split(':').map(Number);
      const wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + dayShift, h, m);
      slots.push(wall - tzOffsetMs(new Date(wall), timeZone));
    }
  }
  const past = slots.filter((s) => s <= now.getTime()).sort((a, b) => b - a);
  return { current: new Date(past[0]), previous: new Date(past[1]) };
}

// The biggest distinct stories in the window: priority × corroboration
// (× update), one report per story.
async function digestStories(since, limit) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (coalesce(ri.story_id, -ri.id))
            ri.id, ri.raw_text, ri.telegram_date, ri.category, ri.priority, ri.dedup_status,
            s.channel_username, t.translated_text, coalesce(st.item_count, 1) AS reports,
            (CASE ri.priority WHEN 'high' THEN 10 ELSE 4 END)
              * (1 + ln(greatest(coalesce(st.item_count, 1), 1)) / ln(2))
              * (CASE WHEN ri.dedup_status = 'update' THEN 1.3 ELSE 1 END) AS importance
     FROM raw_items ri
     JOIN sources s ON s.id = ri.source_id
     LEFT JOIN translations t ON t.raw_item_id = ri.id
     LEFT JOIN stories st ON st.id = ri.story_id
     WHERE ri.status = 'ready' AND ri.dedup_status IN ('unique', 'update')
       AND ri.priority IN ('high', 'medium') AND ri.telegram_date >= $1
     ORDER BY coalesce(ri.story_id, -ri.id), importance DESC, ri.telegram_date DESC`,
    [since]
  );
  return rows.sort((a, b) => b.importance - a.importance).slice(0, limit);
}

async function recordSlot(channel, slot, fields) {
  await pool.query(
    `INSERT INTO publications (kind, digest_slot, channel_key, origin, status, draft_text, final_text, model,
                               score_detail, last_error, drafted_at, approved_at)
     VALUES ('digest', $1, $2, 'auto', $3, $4, $4, $5, $6, $7, now(), CASE WHEN $3 = 'approved' THEN now() END)
     ON CONFLICT (channel_key, digest_slot) WHERE kind = 'digest' DO NOTHING`,
    [slot, channel.key, fields.status, fields.text ?? null, fields.model ?? null, fields.detail ?? null, fields.error ?? null]
  );
}

// `llm`, `styleFn` and `now` are injectable for tests.
export async function runDigestTick({ llm = callLLM, styleFn = getStyleContext, now = new Date() } = {}) {
  const config = publishConfig();
  if (config.mode === 'off') return [];
  const results = [];
  for (const channel of config.channels.filter((c) => c.digest)) {
    const { current, previous } = digestSlots(channel.digest.times, tzOf(channel, config), now);
    if (now - current > LATE_LIMIT_MS) continue;
    const { rows: done } = await pool.query(
      `SELECT 1 FROM publications WHERE kind = 'digest' AND channel_key = $1 AND digest_slot = $2`,
      [channel.key, current]
    );
    if (done.length) continue;

    const stories = await digestStories(previous, channel.digest.maxStories);
    if (stories.length < MIN_STORIES) {
      await recordSlot(channel, current, { status: 'rejected', error: `only ${stories.length} notable stories since the last summary` });
      results.push({ id: channel.key, outcome: 'skipped' });
      continue;
    }

    const key = `${channel.key}|${current.toISOString()}`;
    try {
      const style = await styleFn(channel);
      const { content, model } = await llm(
        buildDigestMessages({ channel, style, stories, since: previous, timeZone: tzOf(channel, config),
          terminology: config.terminology, officialSources: config.officialSources, houseRules: config.houseRules, bannedEmoji: config.bannedEmoji }),
        { providerName: config.draftProvider, model: config.draftModel || undefined, temperature: 0.3 }
      );
      const draft = parseDraft(content);
      if (draft.skip) {
        await recordSlot(channel, current, { status: 'rejected', model, error: 'model judged there was not enough news for a summary' });
        results.push({ id: channel.key, outcome: 'skipped' });
        continue;
      }
      const autoApprove = config.mode === 'auto' && channel.delivery === 'bot';
      await recordSlot(channel, current, {
        status: autoApprove ? 'approved' : 'draft',
        text: removeBannedFlags(applyTerminology(draft.text, config.terminology), config.bannedEmoji),
        model,
        detail: `summary of ${stories.length} stories`,
      });
      attempts.delete(key);
      results.push({ id: channel.key, outcome: autoApprove ? 'approved' : 'drafted' });
    } catch (err) {
      // Provider out of quota/unreachable: try again next tick (within the
      // hour). Other errors: give up on this slot after a few tries.
      const n = (attempts.get(key) || 0) + 1;
      attempts.set(key, n);
      const systemic = /rate limit|429|quota|not configured|fetch failed|timeout|aborted/i.test(err.message);
      if (!systemic && n >= MAX_ATTEMPTS) {
        await recordSlot(channel, current, { status: 'failed', error: err.message });
        attempts.delete(key);
      }
      results.push({ id: channel.key, outcome: 'failed', error: err.message, systemic });
    }
  }
  return results;
}
