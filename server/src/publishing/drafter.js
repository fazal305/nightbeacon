import { pool } from '../db/pool.js';
import { callLLM, isProviderUnavailable } from '../processing/llmClient.js';
import { RateGate } from '../pipeline/rateGate.js';
import { publishConfig, channelByKey } from './config.js';
import { getStyleContext } from './style.js';
import { runDigestTick } from './digest.js';
import {
  buildDraftMessages, parseDraft, parseMultiDraft, applyTerminology, removeBannedFlags,
  keepsStatementVerbatim, statementText, officialOrganisation,
} from './prompt.js';

// Drafting stage, after classification. Work comes from:
//   - automatic (PUBLISH_MODE review/auto): fresh, fully processed unique
//     stories and story updates, per channel, at that channel's draftPriorities;
//   - manual: any post the operator asks to draft from the dashboard.
// Duplicates are never drafted — the story's first report already was.
// All pending channels for the same post are drafted in ONE LLM call.
const CLAIM_LIMIT = 15;
const MAX_ATTEMPTS = 3;
let gate = null;

export function isSystemic(message) {
  return (
    /rate limit|too many requests|429|quota|free-models-per-day|not configured|fetch failed|ECONNREFUSED|timeout|aborted/i.test(message || '') ||
    isProviderUnavailable({ message })
  );
}

// Automatic drafts for news that got too old while waiting (e.g. the LLM
// was out of quota) are dropped instead of spending tokens on stale news.
export async function expireStaleRequests(config) {
  // Automatic drafts for manual channels left uncopied: stale after a few
  // hours. Drafts you asked for yourself stay.
  const manual = config.channels.filter((c) => c.delivery !== 'bot').map((c) => c.key);
  if (config.manualDraftMaxHours > 0 && manual.length) {
    await pool.query(
      `UPDATE publications SET status = 'expired', last_error = 'not copied within ' || $3 || ' hours; news too old', updated_at = now()
       WHERE status = 'draft' AND origin = 'auto' AND kind = 'post' AND channel_key = ANY($1)
         AND coalesce(drafted_at, created_at) < now() - make_interval(hours => $2)`,
      [manual, config.manualDraftMaxHours, String(config.manualDraftMaxHours)]
    );
  }
  // Queued before scored selection existed (no score): drop rather than
  // draft and post that whole backlog.
  await pool.query(
    `UPDATE publications SET status = 'expired', last_error = 'queued before story selection; not drafted', updated_at = now()
     WHERE status IN ('requested', 'approved') AND origin = 'auto' AND score IS NULL`
  );
  await pool.query(
    `UPDATE publications p SET status = 'expired', last_error = 'news too old by the time it could be drafted', updated_at = now()
     FROM raw_items ri
     WHERE p.raw_item_id = ri.id AND p.status = 'requested' AND p.origin = 'auto'
       AND ri.telegram_date < now() - make_interval(mins => $1)`,
    [config.maxAgeMinutes]
  );
}

// Story selection. Instead of drafting every fresh high/medium story the
// moment it appears, each channel gets at most maxPerHour automatic drafts,
// spread out (at least minGapMinutes apart), and each slot goes to the
// best-scoring candidate:
//
//   score = priority (high 10, medium 4)
//         × corroboration (1 + log2 of how many channels reported the story)
//         × 1.3 if it's an update with new figures
//         × 1.2 if the story has a photo/video the channel can post (from
//           this report or another channel's copy of the story)
//         × 2 if it comes from an official channel (official-sources.md) —
//           a statement is published once, by one channel, so it would
//           otherwise never win on corroboration
//         × freshness (halves every hour)
//
// A story waits settleMinutes before it can be picked (unless 3+ channels
// already report it), so corroboration has time to show. A story already
// drafted for the channel isn't picked again within 6 hours, except an
// update, 30+ minutes later.
const SKIPPED_BY_MODEL = 'model judged it not worth posting on this channel';

const HAS_MEDIA_SQL = `(ri.has_media OR (ri.story_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM raw_items m WHERE m.story_id = ri.story_id AND m.has_media)))`;

export const SCORE_SQL = `
  (CASE ri.priority WHEN 'high' THEN 10 WHEN 'medium' THEN 4 ELSE 1 END)
  * (1 + ln(greatest(coalesce(st.item_count, 1), 1)) / ln(2))
  * (CASE WHEN ri.dedup_status = 'update' THEN 1.3 ELSE 1 END)
  * (CASE WHEN lower(src.channel_username) = ANY($5::text[]) THEN 2 ELSE 1 END)
  * (CASE WHEN $6::boolean AND ${HAS_MEDIA_SQL} THEN 1.2 ELSE 1 END)
  * power(0.5, greatest(extract(epoch FROM now() - ri.telegram_date), 0) / 3600.0)`;

async function queueAutomaticDrafts(config) {
  if (config.mode === 'off') return 0;
  let queued = 0;
  for (const channel of config.channels) {
    // In auto mode a bot channel's slots go only to stories it will post by
    // itself (autoPriorities): a slot spent on a draft that then waits for a
    // review the operator never does is an hour's post lost.
    const priorities =
      config.mode === 'auto' && channel.delivery === 'bot'
        ? channel.draftPriorities.filter((p) => channel.autoPriorities.includes(p))
        : channel.draftPriorities;
    if (priorities.length === 0 || channel.maxPerHour <= 0) continue;
    // Drafts the model rejected as not worth posting don't use up a slot.
    const { rows: [recent] } = await pool.query(
      `SELECT count(*)::int AS n, max(created_at) AS last_at FROM publications
       WHERE channel_key = $1 AND origin = 'auto' AND kind = 'post' AND created_at > now() - interval '1 hour'
         AND NOT (status = 'rejected' AND last_error IS NOT DISTINCT FROM $2)`,
      [channel.key, SKIPPED_BY_MODEL]
    );
    if (recent.n >= channel.maxPerHour) continue;
    if (recent.last_at && Date.now() - new Date(recent.last_at).getTime() < channel.minGapMinutes * 60_000) continue;

    const { rowCount } = await pool.query(
      `WITH candidate AS (
         SELECT ri.id, ri.story_id, ri.priority, ${SCORE_SQL} AS score,
                coalesce(st.item_count, 1) AS reports, ri.dedup_status,
                lower(src.channel_username) = ANY($5::text[]) AS official,
                $6::boolean AND ${HAS_MEDIA_SQL} AS with_media,
                extract(epoch FROM now() - ri.telegram_date)::int / 60 AS age_min
         FROM raw_items ri
         JOIN sources src ON src.id = ri.source_id
         LEFT JOIN stories st ON st.id = ri.story_id
         WHERE ri.status = 'ready'
           AND ri.dedup_status IN ('unique', 'update')
           AND ri.priority = ANY($1)
           AND ri.telegram_date >= now() - make_interval(mins => $2)
           AND (ri.telegram_date <= now() - make_interval(mins => $4) OR coalesce(st.item_count, 1) >= 3)
           AND NOT EXISTS (SELECT 1 FROM publications p WHERE p.raw_item_id = ri.id AND p.channel_key = $3)
           AND NOT EXISTS (
             SELECT 1 FROM publications p
             WHERE p.channel_key = $3 AND ri.story_id IS NOT NULL AND p.story_id = ri.story_id
               AND p.status NOT IN ('rejected', 'failed', 'expired')
               AND p.created_at > now() - CASE WHEN ri.dedup_status = 'update' THEN interval '30 minutes' ELSE interval '6 hours' END)
         ORDER BY score DESC, ri.telegram_date DESC
         LIMIT 1)
       INSERT INTO publications (raw_item_id, story_id, channel_key, priority, origin, status, score, score_detail)
       SELECT id, story_id, $3, priority, 'auto', 'requested', score,
              priority || ' · ' || reports || CASE WHEN reports = 1 THEN ' channel' ELSE ' channels' END
                || CASE WHEN dedup_status = 'update' THEN ' · update' ELSE '' END
                || CASE WHEN official THEN ' · official channel' ELSE '' END
                || CASE WHEN with_media THEN ' · photo/video' ELSE '' END || ' · ' || age_min || ' min old'
       FROM candidate
       ON CONFLICT (raw_item_id, channel_key) DO NOTHING`,
      [priorities, config.maxAgeMinutes, channel.key, channel.settleMinutes, [...config.officialSources.keys()], channel.media]
    );
    queued += rowCount;
  }
  return queued;
}

// Claims whole posts (all their requested channels together), manual
// requests first, newest first.
export async function claimRequested(limit = CLAIM_LIMIT) {
  const { rows } = await pool.query(
    `UPDATE publications SET status = 'drafting', updated_at = now()
     WHERE id IN (
       SELECT p.id FROM publications p
       WHERE p.status = 'requested'
         AND p.raw_item_id IN (
           SELECT raw_item_id FROM publications WHERE status = 'requested'
           GROUP BY raw_item_id
           ORDER BY bool_or(origin = 'manual') DESC, max(created_at) DESC
           LIMIT $1)
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, raw_item_id, channel_key, origin`,
    [limit]
  );
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.raw_item_id)) groups.set(r.raw_item_id, []);
    groups.get(r.raw_item_id).push(r);
  }
  return [...groups.values()];
}

async function loadItem(rawItemId) {
  const { rows } = await pool.query(
    `SELECT ri.id, ri.raw_text, ri.telegram_date, ri.category, ri.priority, ri.dedup_status, ri.has_media,
            s.channel_username, t.translated_text, st.item_count AS story_item_count
     FROM raw_items ri
     JOIN sources s ON s.id = ri.source_id
     LEFT JOIN translations t ON t.raw_item_id = ri.id
     LEFT JOIN stories st ON st.id = ri.story_id
     WHERE ri.id = $1`,
    [rawItemId]
  );
  return rows[0];
}

async function saveDraft(pub, channel, item, draft, model, config) {
  if (draft.skip) {
    await pool.query(
      `UPDATE publications SET status = 'rejected', model = $2, last_error = $3, drafted_at = now(), updated_at = now()
       WHERE id = $1`,
      [pub.id, model, SKIPPED_BY_MODEL]
    );
    return 'skipped';
  }
  // An official statement keeps its exact (translated) wording: no house
  // terminology inside it, and if the model changed any words it is not
  // posted automatically — it waits for review with a note.
  const official = officialOrganisation(item, config.officialSources);
  const text = removeBannedFlags(official ? draft.text : applyTerminology(draft.text, config.terminology));
  const altered = official && !keepsStatementVerbatim(text, statementText(item));
  const autoApprove =
    !altered &&
    config.mode === 'auto' && channel.delivery === 'bot' && pub.origin === 'auto' && channel.autoPriorities.includes(item.priority);
  await pool.query(
    `UPDATE publications
     SET status = $2, draft_text = $3, final_text = $3, model = $4, priority = $5,
         drafted_at = now(), approved_at = CASE WHEN $2 = 'approved' THEN now() END, last_error = $6,
         updated_at = now()
     WHERE id = $1`,
    [
      pub.id, autoApprove ? 'approved' : 'draft', text, model, item.priority,
      altered ? `statement wording differs from the ${official} statement's translation — check before posting` : null,
    ]
  );
  return autoApprove ? 'approved' : 'drafted';
}

export async function failPublications(pubs, message, systemic) {
  const ids = pubs.map((p) => p.id);
  await pool.query(
    systemic
      ? `UPDATE publications SET status = 'requested', last_error = $2, updated_at = now() WHERE id = ANY($1)`
      : `UPDATE publications SET attempts = attempts + 1, last_error = $2, updated_at = now(),
                status = CASE WHEN attempts + 1 >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'requested' END
         WHERE id = ANY($1)`,
    [ids, message]
  );
}

// `llm` and `styleFn` are injectable for tests.
export async function runDraftingTick({ llm = callLLM, styleFn = getStyleContext } = {}) {
  const config = publishConfig();
  await expireStaleRequests(config);
  await queueAutomaticDrafts(config);
  const digests = await runDigestTick({ llm, styleFn });
  const groups = await claimRequested();
  if (groups.length === 0) return digests;

  if (!gate) gate = new RateGate(60_000 / config.draftMaxPerMinute);
  const results = [...digests];

  for (let g = 0; g < groups.length; g++) {
    await gate.wait();
    const outcome = await draftGroup(groups[g], config, { llm, styleFn });
    results.push(...outcome.results);
    if (outcome.systemic) {
      // Provider down / out of quota: put the rest back untouched.
      const rest = groups.slice(g + 1).flat().map((p) => p.id);
      if (rest.length) {
        await pool.query(`UPDATE publications SET status = 'requested', updated_at = now() WHERE id = ANY($1)`, [rest]);
      }
      break;
    }
  }
  return results;
}

// Drafts one claimed post for all its requested channels. `providerName`
// overrides the configured provider list (the drafting drain gives each
// provider its own worker). Returns { results, systemic } — systemic means
// the provider(s) couldn't take it and the post went back to the queue.
export async function draftGroup(group, config, { llm = callLLM, styleFn = getStyleContext, providerName } = {}) {
  const results = [];
  // Channels removed from the config since the request was made.
  const known = group.filter((p) => channelByKey(config, p.channel_key));
  const orphaned = group.filter((p) => !channelByKey(config, p.channel_key));
  if (orphaned.length) {
    await pool.query(
      `UPDATE publications SET status = 'rejected', last_error = 'channel is no longer configured', updated_at = now() WHERE id = ANY($1)`,
      [orphaned.map((p) => p.id)]
    );
  }
  if (known.length === 0) return { results, systemic: false };

  const item = await loadItem(known[0].raw_item_id);
  const targets = [];
  for (const pub of known) {
    const channel = channelByKey(config, pub.channel_key);
    targets.push({ pub, channel, style: await styleFn(channel) });
  }

  try {
    const { content, model } = await llm(buildDraftMessages({ item, targets, terminology: config.terminology, officialSources: config.officialSources, houseRules: config.houseRules }), {
      providerName: providerName || config.draftProvider,
      model: providerName ? undefined : config.draftModel || undefined,
      temperature: 0.4,
    });
    let drafts;
    if (targets.length === 1) {
      drafts = new Map([[targets[0].channel.key, parseDraft(content)]]);
    } else {
      try {
        drafts = parseMultiDraft(content, targets.map((t) => t.channel.key));
      } catch {
        drafts = new Map();
      }
    }
    const missing = [];
    for (const t of targets) {
      const draft = drafts.get(t.channel.key);
      if (!draft) {
        missing.push(t.pub);
        continue;
      }
      results.push({ id: t.pub.id, outcome: await saveDraft(t.pub, t.channel, item, draft, model, config) });
    }
    if (missing.length) {
      // The model left these channels out: retry them (counts as an attempt).
      await failPublications(missing, 'model reply did not include this channel', false);
      for (const p of missing) results.push({ id: p.id, outcome: 'failed', error: 'missing from reply' });
    }
    return { results, systemic: false };
  } catch (err) {
    const systemic = isSystemic(err.message);
    await failPublications(known, err.message, systemic);
    results.push({ id: known[0].id, outcome: 'failed', error: err.message, systemic });
    return { results, systemic };
  }
}
