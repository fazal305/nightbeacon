import { pool } from '../db/pool.js';
import { classify } from './classificationRules.js';
import { classifyWithJev, isJevRateLimit } from './jevClassify.js';
import { claimBatch } from '../pipeline/claim.js';
import { higherPriority } from './triage.js';

// The rule-based classifier is pure CPU and takes well under a millisecond
// per item; the old 20-per-minute cap made this stage a backlog of its own
// (1,200 items/hour max, below real ingestion volume).
const BATCH_SIZE = Number(process.env.CLASSIFY_BATCH_SIZE || 200);
const MAX_ATTEMPTS = 5;

async function ensureTagIds(client, tagNames) {
  if (tagNames.length === 0) return [];
  const { rows } = await client.query(
    `INSERT INTO tags (name)
     SELECT unnest($1::text[])
     ON CONFLICT (name) DO NOTHING`,
    [tagNames]
  );
  const existing = await client.query('SELECT id, name FROM tags WHERE name = ANY($1::text[])', [
    tagNames,
  ]);
  return existing.rows;
}

async function processItemRule(item) {
  const client = await pool.connect();
  try {
    // Classify on the translated text when available (it's what an English-reading
    // analyst — and these English keyword lists — can actually match against);
    // fall back to the original text if translation was skipped/unavailable.
    const textToClassify = item.translated_text || item.raw_text;
    const { category, priority: english, tags } = classify(textToClassify);
    // The guess from the original text (triage.js) can only raise it: a
    // keyword the translation phrased differently shouldn't lose a story.
    const priority = item.triage_priority ? higherPriority(english, item.triage_priority) : english;

    await client.query('BEGIN');

    await client.query(
      `UPDATE raw_items SET category = $2, priority = $3, status = 'ready', ready_at = clock_timestamp(), updated_at = now() WHERE id = $1`,
      [item.id, category, priority]
    );

    const tagRows = await ensureTagIds(client, tags);
    for (const tag of tagRows) {
      await client.query(
        `INSERT INTO item_tags (raw_item_id, tag_id, source) VALUES ($1, $2, 'rule')
         ON CONFLICT (raw_item_id, tag_id) DO NOTHING`,
        [item.id, tag.id]
      );
    }

    await client.query('COMMIT');
    return { id: item.id, outcome: 'ready', category, priority, tagCount: tagRows.length };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    await pool.query(
      `UPDATE raw_items SET status = 'failed_tagging', tagging_attempts = tagging_attempts + 1, updated_at = now() WHERE id = $1`,
      [item.id]
    );
    return { id: item.id, outcome: 'failed', error: err.message };
  } finally {
    client.release();
  }
}

// Jev (see docs/adr/0005-jev-classification.md) answers category/priority
// directly — no keyword extraction, so it produces no item_tags rows.
// Deliberately not the default: it's a paid external call replacing a free,
// instant, deterministic one, so it's opt-in via CLASSIFICATION_PROVIDER.
async function processItemJev(item) {
  const client = await pool.connect();
  try {
    const textToClassify = item.translated_text || item.raw_text;
    const { category, priority } = await classifyWithJev(textToClassify);

    await client.query('BEGIN');
    await client.query(
      `UPDATE raw_items SET category = $2, priority = $3, status = 'ready', ready_at = clock_timestamp(), updated_at = now() WHERE id = $1`,
      [item.id, category, priority]
    );
    await client.query('COMMIT');
    return { id: item.id, outcome: 'ready', category, priority, tagCount: 0 };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // A rate-limited account isn't this item's fault and won't clear sooner
    // by burning its tagging_attempts budget — same reasoning as translate.js's
    // isSystemicFailure handling for the Groq provider. Reverts to 'translated'
    // (not 'new') so the claim query, not ingestion, picks it back up.
    const systemic = isJevRateLimit(err);
    await pool.query(
      systemic
        ? `UPDATE raw_items SET status = 'translated', updated_at = now() WHERE id = $1`
        : `UPDATE raw_items SET status = 'failed_tagging', tagging_attempts = tagging_attempts + 1, updated_at = now() WHERE id = $1`,
      [item.id]
    );
    return { id: item.id, outcome: 'failed', error: err.message, systemic };
  } finally {
    client.release();
  }
}

export async function runClassificationTick() {
  const claimed = await claimBatch({
    eligibleSql: `(status = 'translated' OR (status = 'failed_tagging' AND tagging_attempts < $1))`,
    eligibleParams: [MAX_ATTEMPTS],
    claimStatus: 'tagging',
    limit: BATCH_SIZE,
    returning: `id, raw_text, telegram_date, triage_priority,
       (SELECT translated_text FROM translations t WHERE t.raw_item_id = raw_items.id) AS translated_text`,
  });

  if (claimed.length === 0) return [];

  const provider = (process.env.CLASSIFICATION_PROVIDER || 'rule').toLowerCase();
  const processItem = provider === 'jev' ? processItemJev : processItemRule;

  const results = [];
  for (let i = 0; i < claimed.length; i++) {
    const result = await processItem(claimed[i]);
    results.push(result);
    if (result.systemic) {
      // Same early-stop-and-revert pattern as translate.js: once the
      // provider is confirmed rate-limited for this tick, further calls in
      // the same batch are just as doomed. Items already claimed
      // (status='tagging') but not yet attempted must be put back
      // explicitly, or they'd be stuck forever — 'tagging' isn't a status
      // the claim query ever re-picks up on its own.
      const remaining = claimed.slice(i + 1).map((c) => c.id);
      if (remaining.length > 0) {
        await pool.query(`UPDATE raw_items SET status = 'translated', updated_at = now() WHERE id = ANY($1)`, [
          remaining,
        ]);
      }
      break;
    }
  }
  return results;
}
