import { pool } from '../db/pool.js';
import { callLLM } from '../processing/llmClient.js';
import { RateGate } from '../pipeline/rateGate.js';
import { publishConfig, channelByKey } from './config.js';
import { getStyleContext } from './style.js';
import { buildDraftMessages, parseDraft, parseMultiDraft, applyTerminology, removeBannedFlags } from './prompt.js';

// Drafting stage, after classification. Work comes from:
//   - automatic (PUBLISH_MODE review/auto): fresh, fully processed unique
//     stories and story updates, per channel, at that channel's draftPriorities;
//   - manual: any post the operator asks to draft from the dashboard.
// Duplicates are never drafted — the story's first report already was.
// All pending channels for the same post are drafted in ONE LLM call.
const CLAIM_LIMIT = 15;
const MAX_ATTEMPTS = 3;
let gate = null;

function isSystemic(message) {
  return /rate limit|too many requests|429|quota|free-models-per-day|not configured|fetch failed|ECONNREFUSED|timeout|aborted/i.test(
    message || ''
  );
}

// Automatic drafts for news that got too old while waiting (e.g. the LLM
// was out of quota) are dropped instead of spending tokens on stale news.
async function expireStaleRequests(config) {
  await pool.query(
    `UPDATE publications p SET status = 'expired', last_error = 'news too old by the time it could be drafted', updated_at = now()
     FROM raw_items ri
     WHERE p.raw_item_id = ri.id AND p.status = 'requested' AND p.origin = 'auto'
       AND ri.telegram_date < now() - make_interval(mins => $1)`,
    [config.maxAgeMinutes]
  );
}

// At most channel.maxPerHour automatic drafts per channel per hour, so the
// channel isn't flooded and the LLM's free allowance lasts: high priority
// first, newest first.
async function queueAutomaticDrafts(config) {
  if (config.mode === 'off') return 0;
  let queued = 0;
  for (const channel of config.channels) {
    if (channel.draftPriorities.length === 0) continue;
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM publications
       WHERE channel_key = $1 AND origin = 'auto' AND created_at > now() - interval '1 hour'
         AND NOT (status = 'rejected' AND last_error = 'model judged it not worth posting on this channel')`,
      [channel.key]
    );
    const room = channel.maxPerHour - rows[0].n;
    if (room <= 0) continue;
    const { rowCount } = await pool.query(
      `INSERT INTO publications (raw_item_id, story_id, channel_key, priority, origin, status)
       SELECT ri.id, ri.story_id, $3, ri.priority, 'auto', 'requested'
       FROM raw_items ri
       WHERE ri.status = 'ready'
         AND ri.dedup_status IN ('unique', 'update')
         AND ri.priority = ANY($1)
         AND ri.telegram_date >= now() - make_interval(mins => $2)
         AND NOT EXISTS (SELECT 1 FROM publications p WHERE p.raw_item_id = ri.id AND p.channel_key = $3)
       ORDER BY CASE ri.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, ri.telegram_date DESC
       LIMIT $4
       ON CONFLICT (raw_item_id, channel_key) DO NOTHING`,
      [channel.draftPriorities, config.maxAgeMinutes, channel.key, room]
    );
    queued += rowCount;
  }
  return queued;
}

// Claims whole posts (all their requested channels together), manual
// requests first, newest first.
async function claimRequested() {
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
    [CLAIM_LIMIT]
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
    `SELECT ri.id, ri.raw_text, ri.telegram_date, ri.category, ri.priority, ri.dedup_status,
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
      `UPDATE publications SET status = 'rejected', model = $2, last_error = 'model judged it not worth posting on this channel',
                               drafted_at = now(), updated_at = now()
       WHERE id = $1`,
      [pub.id, model]
    );
    return 'skipped';
  }
  const autoApprove =
    config.mode === 'auto' && channel.delivery === 'bot' && pub.origin === 'auto' && channel.autoPriorities.includes(item.priority);
  await pool.query(
    `UPDATE publications
     SET status = $2, draft_text = $3, final_text = $3, model = $4, priority = $5,
         drafted_at = now(), approved_at = CASE WHEN $2 = 'approved' THEN now() END, last_error = NULL,
         updated_at = now()
     WHERE id = $1`,
    [pub.id, autoApprove ? 'approved' : 'draft', removeBannedFlags(applyTerminology(draft.text, config.terminology)), model, item.priority]
  );
  return autoApprove ? 'approved' : 'drafted';
}

async function failPublications(pubs, message, systemic) {
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
  const groups = await claimRequested();
  if (groups.length === 0) return [];

  if (!gate) gate = new RateGate(60_000 / config.draftMaxPerMinute);
  const results = [];

  for (let g = 0; g < groups.length; g++) {
    const group = groups[g];
    // Channels removed from the config since the request was made.
    const known = group.filter((p) => channelByKey(config, p.channel_key));
    const orphaned = group.filter((p) => !channelByKey(config, p.channel_key));
    if (orphaned.length) {
      await pool.query(
        `UPDATE publications SET status = 'rejected', last_error = 'channel is no longer configured', updated_at = now() WHERE id = ANY($1)`,
        [orphaned.map((p) => p.id)]
      );
    }
    if (known.length === 0) continue;

    const item = await loadItem(known[0].raw_item_id);
    const targets = [];
    for (const pub of known) {
      const channel = channelByKey(config, pub.channel_key);
      targets.push({ pub, channel, style: await styleFn(channel) });
    }

    try {
      await gate.wait();
      const { content, model } = await llm(buildDraftMessages({ item, targets, terminology: config.terminology }), {
        providerName: config.draftProvider,
        model: config.draftModel || undefined,
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
    } catch (err) {
      const systemic = isSystemic(err.message);
      await failPublications(known, err.message, systemic);
      results.push({ id: known[0].id, outcome: 'failed', error: err.message, systemic });
      if (systemic) {
        // Provider down / out of quota: put the rest back untouched.
        const rest = groups.slice(g + 1).flat().map((p) => p.id);
        if (rest.length) {
          await pool.query(`UPDATE publications SET status = 'requested', updated_at = now() WHERE id = ANY($1)`, [rest]);
        }
        break;
      }
    }
  }
  return results;
}
