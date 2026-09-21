import { pool } from '../db/pool.js';
import { callOpenRouter } from './openrouter.js';
import { looksLikeEnglish } from './detectLanguage.js';

const BATCH_SIZE = 5; // stay well under free-tier OpenRouter rate limits per tick
const MAX_ATTEMPTS = 5;

const LANG_CODE_RE = /^[a-z]{2,3}$/i;

async function translateText(text) {
  const { content, model } = await callOpenRouter([
    {
      role: 'system',
      content:
        'You translate social media / news posts to English for an OSINT analyst. ' +
        'Respond with exactly two parts: the first line is the ISO 639-1 language code ' +
        'of the original text (e.g. "ar", "fa", "ru"), and every line after that is the ' +
        'English translation only — no commentary, no quotes, no explanation.',
    },
    { role: 'user', content: text },
  ]);

  const newlineIndex = content.indexOf('\n');
  const firstLine = (newlineIndex === -1 ? content : content.slice(0, newlineIndex)).trim();
  const rest = (newlineIndex === -1 ? '' : content.slice(newlineIndex + 1)).trim();

  if (LANG_CODE_RE.test(firstLine) && rest) {
    return { sourceLanguage: firstLine.toLowerCase(), translatedText: rest, model };
  }
  // Model didn't follow the format — still usable, just no detected-language field.
  return { sourceLanguage: null, translatedText: content.trim(), model };
}

async function upsertTranslation(client, raw) {
  await client.query(
    `INSERT INTO translations (raw_item_id, source_language, target_language, translated_text, model, status, error_message)
     VALUES ($1, $2, 'en', $3, $4, $5, $6)
     ON CONFLICT (raw_item_id) DO UPDATE SET
       source_language = EXCLUDED.source_language,
       translated_text = EXCLUDED.translated_text,
       model = EXCLUDED.model,
       status = EXCLUDED.status,
       error_message = EXCLUDED.error_message,
       updated_at = now()`,
    [raw.id, raw.sourceLanguage ?? null, raw.translatedText ?? null, raw.model ?? null, raw.status, raw.errorMessage ?? null]
  );
}

async function processItem(item) {
  const client = await pool.connect();
  try {
    const english = looksLikeEnglish(item.raw_text);

    if (english === null) {
      // Media-only post, nothing to translate — not a failure, just nothing to do.
      await client.query('BEGIN');
      await upsertTranslation(client, { id: item.id, status: 'skipped_same_language' });
      await client.query(`UPDATE raw_items SET status = 'translated', updated_at = now() WHERE id = $1`, [
        item.id,
      ]);
      await client.query('COMMIT');
      return { id: item.id, outcome: 'skipped' };
    }

    if (english) {
      await client.query('BEGIN');
      await upsertTranslation(client, {
        id: item.id,
        sourceLanguage: 'en',
        translatedText: item.raw_text,
        status: 'skipped_same_language',
      });
      await client.query(`UPDATE raw_items SET status = 'translated', updated_at = now() WHERE id = $1`, [
        item.id,
      ]);
      await client.query('COMMIT');
      return { id: item.id, outcome: 'skipped' };
    }

    const result = await translateText(item.raw_text);
    await client.query('BEGIN');
    await upsertTranslation(client, {
      id: item.id,
      sourceLanguage: result.sourceLanguage,
      translatedText: result.translatedText,
      model: result.model,
      status: 'done',
    });
    await client.query(`UPDATE raw_items SET status = 'translated', updated_at = now() WHERE id = $1`, [
      item.id,
    ]);
    await client.query('COMMIT');
    return { id: item.id, outcome: 'translated' };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // Translation failure never touches raw_items.raw_text — only status + the
    // separate translations row. The original stays intact and visible.
    await pool.query(
      `UPDATE raw_items SET status = 'failed_translation', translation_attempts = translation_attempts + 1, updated_at = now() WHERE id = $1`,
      [item.id]
    );
    await upsertTranslation(pool, { id: item.id, status: 'failed', errorMessage: err.message });
    return { id: item.id, outcome: 'failed', error: err.message };
  } finally {
    client.release();
  }
}

export async function runTranslationTick() {
  // Claim a batch atomically so two overlapping ticks can't double-process the
  // same rows — same conditional-UPDATE claim pattern used for ingestion.
  const { rows: claimed } = await pool.query(
    `UPDATE raw_items
     SET status = 'translating', updated_at = now()
     WHERE id IN (
       SELECT id FROM raw_items
       WHERE (status = 'new' OR (status = 'failed_translation' AND translation_attempts < $1))
       ORDER BY id
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, raw_text`,
    [MAX_ATTEMPTS, BATCH_SIZE]
  );

  const results = [];
  for (const item of claimed) {
    results.push(await processItem(item));
  }
  return results;
}
