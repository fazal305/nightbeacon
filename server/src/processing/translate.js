import { pool } from '../db/pool.js';
import { callLLM } from './llmClient.js';
import { looksLikeEnglish } from './detectLanguage.js';
import { translateBatch, isTelegramFloodWait, TRANSLATE_CHUNK_SIZE } from './telegramTranslate.js';
import { claimBatch } from '../pipeline/claim.js';
import { RateGate } from '../pipeline/rateGate.js';
import { floodWaitSeconds, isTelegramAnswer } from '../ingestion/telegramClient.js';

// Groq's free tier (default LLM provider, see llmClient.js) allows ~1000
// requests/10min (~100/min sustained) and ~30k tokens/min — confirmed via
// its response rate-limit headers. 50/min leaves comfortable headroom under
// both the request and token ceilings even with the long real-world post
// lengths seen in production (a full backlog item can run several hundred
// tokens). Was 5, then 15 under OpenRouter's much stricter free tier before
// its 50-req/day account-wide cap forced the provider switch — see
// docs/POLLING.md and the ADR for that decision.
//
// Translation now runs as a continuous worker (see pipeline/workers.js), not
// a once-a-minute cron batch, so the per-minute budget is enforced by
// spacing calls rather than by batch size — a batch can't burst past it, and
// a slow tick can no longer overlap the next one.
const BATCH_SIZE = Number(process.env.TRANSLATE_BATCH_SIZE || 20);
const MAX_ATTEMPTS = 5;
const llmGate = new RateGate(60_000 / Number(process.env.TRANSLATE_MAX_PER_MINUTE || 50));
// Telegram publishes no limit for messages.translateText, so calls (each up to
// TRANSLATE_CHUNK_SIZE posts) are spaced conservatively — 12/min = 240 posts/min
// by default — and a flood-wait pauses this provider for its full duration
// rather than being retried after the worker's generic 60s backoff.
const telegramGate = new RateGate(60_000 / Number(process.env.TELEGRAM_TRANSLATE_CALLS_PER_MINUTE || 12));

const LANG_CODE_RE = /^[a-z]{2,3}$/i;

// A systemic failure (the whole account/model is out of quota, or the
// provider itself is down) is not the item's fault and won't resolve by
// retrying that specific item sooner — it resolves on its own schedule
// (daily quota reset, provider recovery, flood-wait expiry). Counting these
// against an item's translation_attempts would exhaust its retry budget for
// good within minutes (5 attempts × ~1min ticks) over something entirely
// external, permanently stranding it in failed_translation long after the
// real problem has cleared. Per-item errors (bad response format, etc.)
// still count normally.
function isSystemicFailure(message) {
  return /free-models-per-day|rate limit (exceeded|reached)|too many requests|429/i.test(message);
}

async function translateTextLLM(text) {
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

async function commitTranslation(id, translationRow) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await upsertTranslation(client, { id, ...translationRow });
    await client.query(
      `UPDATE raw_items SET status = 'translated', translated_at = clock_timestamp(), updated_at = now() WHERE id = $1`,
      [id]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Skip logic is provider-agnostic — deterministic (detectLanguage.js), never
// an LLM/Telegram call, per the project's "prefer deterministic rules"
// principle. Shared by both translation paths below.
async function trySkip(item) {
  const english = looksLikeEnglish(item.raw_text);
  if (english === null) {
    // Media-only post, nothing to translate — not a failure, just nothing to do.
    await commitTranslation(item.id, { status: 'skipped_same_language' });
    return { id: item.id, outcome: 'skipped' };
  }
  if (english) {
    await commitTranslation(item.id, {
      sourceLanguage: 'en',
      translatedText: item.raw_text,
      status: 'skipped_same_language',
    });
    return { id: item.id, outcome: 'skipped' };
  }
  return null;
}

async function processItemLLM(item) {
  const skipped = await trySkip(item);
  if (skipped) return skipped;

  try {
    await llmGate.wait();
    const result = await translateTextLLM(item.raw_text);
    await commitTranslation(item.id, {
      sourceLanguage: result.sourceLanguage,
      translatedText: result.translatedText,
      model: result.model,
      status: 'done',
    });
    return { id: item.id, outcome: 'translated' };
  } catch (err) {
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
  }
}

async function runLLMBatch(claimed) {
  const results = [];
  for (let i = 0; i < claimed.length; i++) {
    const result = await processItemLLM(claimed[i]);
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

// Telegram's own messages.translateText, via the same MTProto user session
// ingestion already holds open — see docs/adr/0004-telegram-native-translation.md.
// A flood-wait here fails the whole chunk that was in flight (one MTProto
// call covers several items at once), not a single item, so the systemic
// handling operates per-chunk rather than per-item.
async function runTelegramBatch(claimed) {
  const results = [];
  const toTranslate = [];

  for (const item of claimed) {
    const skipped = await trySkip(item);
    if (skipped) {
      results.push(skipped);
    } else {
      toTranslate.push(item);
    }
  }

  for (let i = 0; i < toTranslate.length; i += TRANSLATE_CHUNK_SIZE) {
    const chunk = toTranslate.slice(i, i + TRANSLATE_CHUNK_SIZE);
    try {
      await telegramGate.wait();
      const translated = await translateBatch(chunk.map((c) => c.raw_text));
      for (let j = 0; j < chunk.length; j++) {
        const item = chunk[j];
        await commitTranslation(item.id, {
          // translateText doesn't report a detected source language, only
          // the translated text — same "unknown language, still usable"
          // case the LLM path already tolerates when the model skips it.
          translatedText: translated[j],
          model: 'telegram',
          status: 'done',
        });
        results.push({ id: item.id, outcome: 'translated' });
      }
    } catch (err) {
      // Flood-waits and "no answer at all" (proxy down, timeout) are not the
      // posts' fault: put them back without spending their retry budget.
      const flood = floodWaitSeconds(err);
      if (flood) telegramGate.pauseFor(flood * 1000);
      const systemic = flood != null || isTelegramFloodWait(err.message) || !isTelegramAnswer(err);
      for (const item of chunk) {
        if (systemic) {
          await pool.query(`UPDATE raw_items SET status = 'new', updated_at = now() WHERE id = $1`, [item.id]);
        } else {
          await pool.query(
            `UPDATE raw_items SET status = 'failed_translation', translation_attempts = translation_attempts + 1, updated_at = now() WHERE id = $1`,
            [item.id]
          );
          await upsertTranslation(pool, { id: item.id, status: 'failed', errorMessage: err.message });
        }
        results.push({ id: item.id, outcome: 'failed', error: err.message, systemic });
      }

      if (systemic) {
        const remaining = toTranslate.slice(i + TRANSLATE_CHUNK_SIZE);
        if (remaining.length > 0) {
          await pool.query(
            `UPDATE raw_items SET status = 'new', updated_at = now() WHERE id = ANY($1)`,
            [remaining.map((c) => c.id)]
          );
          results.push(...remaining.map((c) => ({ id: c.id, outcome: 'reverted' })));
        }
        break;
      }
    }
  }

  return results;
}

export async function runTranslationTick() {
  const provider = (process.env.TRANSLATION_PROVIDER || 'groq').toLowerCase();
  // While Telegram has translation flood-waited, don't claim anything — the
  // posts stay queued (and visible in the feed) instead of sitting in
  // 'translating' for the whole wait.
  if (provider === 'telegram' && telegramGate.isPaused()) return [];

  // Only items dedup has cleared: unique stories, and updates that carry new
  // information. Duplicates never reach this stage ('legacy' = rows that were
  // already past 'new' before dedup existed).
  const claimed = await claimBatch({
    eligibleSql: `(status = 'new' OR (status = 'failed_translation' AND translation_attempts < $1))
                  AND dedup_status IN ('unique', 'update', 'legacy')`,
    eligibleParams: [MAX_ATTEMPTS],
    claimStatus: 'translating',
    limit: BATCH_SIZE,
    returning: 'id, raw_text, telegram_date',
  });

  if (claimed.length === 0) return [];

  return provider === 'telegram' ? runTelegramBatch(claimed) : runLLMBatch(claimed);
}
