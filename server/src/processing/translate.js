import { pool } from '../db/pool.js';
import { callLLM } from './llmClient.js';
import { looksLikeEnglish } from './detectLanguage.js';

// Groq's free tier (default provider, see llmClient.js) allows ~1000
// requests/10min (~100/min sustained) and ~30k tokens/min — confirmed via
// its response rate-limit headers. 50/min leaves comfortable headroom under
// both the request and token ceilings even with the long real-world post
// lengths seen in production (a full backlog item can run several hundred
// tokens). Was 5, then 15 under OpenRouter's much stricter free tier before
// its 50-req/day account-wide cap forced the provider switch — see
// docs/POLLING.md and the ADR for that decision.
const BATCH_SIZE = 50;
const MAX_ATTEMPTS = 5;

const LANG_CODE_RE = /^[a-z]{2,3}$/i;

// A systemic failure (the whole account/model is out of quota, or the
// provider itself is down) is not the item's fault and won't resolve by
// retrying that specific item sooner — it resolves on its own schedule
// (daily quota reset, provider recovery). Counting these against an item's
// translation_attempts would exhaust its retry budget for good within
// minutes (5 attempts × ~1min ticks) over something entirely external,
// permanently stranding it in failed_translation long after the real
// problem has cleared. Per-item errors (bad response format, etc.) still
// count normally.
function isSystemicFailure(message) {
  return /free-models-per-day|rate limit (exceeded|reached)|too many requests|429/i.test(message);
}

async function translateText(text) {
  const { content, model } = await callLLM([
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
    const systemic = isSystemicFailure(err.message);
    await pool.query(
      systemic
        ? `UPDATE raw_items SET status = 'new', updated_at = now() WHERE id = $1`
        : `UPDATE raw_items SET status = 'failed_translation', translation_attempts = translation_attempts + 1, updated_at = now() WHERE id = $1`,
      [item.id]
    );
    if (!systemic) {
      await upsertTranslation(pool, { id: item.id, status: 'failed', errorMessage: err.message });
    }
    return { id: item.id, outcome: 'failed', error: err.message, systemic };
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
  for (let i = 0; i < claimed.length; i++) {
    const result = await processItem(claimed[i]);
    results.push(result);
    if (result.systemic) {
      // Once the provider/quota is confirmed down for this tick, further
      // calls in the same batch are just as doomed — stop spending them.
      // The items already claimed (status='translating') but not yet
      // attempted must be put back to 'new' explicitly, or they'd be stuck
      // forever — 'translating' isn't a status the claim query ever re-picks
      // up.
      const remaining = claimed.slice(i + 1).map((c) => c.id);
      if (remaining.length > 0) {
        await pool.query(`UPDATE raw_items SET status = 'new', updated_at = now() WHERE id = ANY($1)`, [
          remaining,
        ]);
      }
      break;
    }
  }
  return results;
}
