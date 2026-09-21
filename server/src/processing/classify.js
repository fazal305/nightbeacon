import { pool } from '../db/pool.js';
import { classify } from './classificationRules.js';

const BATCH_SIZE = 20; // deterministic, no external API — can process a larger batch per tick

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

async function processItem(item) {
  const client = await pool.connect();
  try {
    // Classify on the translated text when available (it's what an English-reading
    // analyst — and these English keyword lists — can actually match against);
    // fall back to the original text if translation was skipped/unavailable.
    const textToClassify = item.translated_text || item.raw_text;
    const { category, priority, tags } = classify(textToClassify);

    await client.query('BEGIN');

    await client.query(
      `UPDATE raw_items SET category = $2, priority = $3, status = 'ready', updated_at = now() WHERE id = $1`,
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

const MAX_ATTEMPTS = 5;

export async function runClassificationTick() {
  const { rows: claimed } = await pool.query(
    `UPDATE raw_items
     SET status = 'tagging', updated_at = now()
     WHERE id IN (
       SELECT id FROM raw_items
       WHERE (status = 'translated' OR (status = 'failed_tagging' AND tagging_attempts < $1))
       ORDER BY id
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, raw_text,
       (SELECT translated_text FROM translations t WHERE t.raw_item_id = raw_items.id) AS translated_text`,
    [MAX_ATTEMPTS, BATCH_SIZE]
  );

  const results = [];
  for (const item of claimed) {
    results.push(await processItem(item));
  }
  return results;
}
