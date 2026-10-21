import { pool } from '../db/pool.js';
import { callLLM } from './llmClient.js';
import { looksLikeEnglish } from './detectLanguage.js';
import { translateBatch, isTelegramFloodWait, TRANSLATE_CHUNK_SIZE } from './telegramTranslate.js';
import { claimBatch } from '../pipeline/claim.js';
import { RateGate } from '../pipeline/rateGate.js';
import { floodWaitSeconds, isTelegramAnswer } from '../ingestion/telegramClient.js';
import { WEB_TRANSLATORS, WEB_TRANSLATOR_RATES, looksDegenerate } from './webTranslate.js';

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
const BATCH_SIZE = Number(process.env.TRANSLATE_BATCH_SIZE || 30);
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

export async function commitTranslation(id, translationRow) {
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
export async function trySkip(item) {
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

// Several posts per LLM call ("array" translation): the instructions and the
// model's reasoning overhead are paid once per batch instead of once per
// post, which cuts tokens noticeably against Groq's daily cap and cuts
// requests by ~LLM_TRANSLATE_BATCH x. Posts get short indexes (not DB ids)
// and every index is checked; anything missing or malformed falls back to
// the one-post path, so a sloppy reply never loses a post.
// LLM_TRANSLATE_BATCH=1 restores one call per post.
const LLM_BATCH = Math.max(1, Number(process.env.LLM_TRANSLATE_BATCH || 15));
const LLM_BATCH_MAX_CHARS = Number(process.env.LLM_TRANSLATE_BATCH_MAX_CHARS || 4000);

export function chunkForBatch(items, maxItems = LLM_BATCH, maxChars = LLM_BATCH_MAX_CHARS) {
  const chunks = [];
  let current = [];
  let chars = 0;
  for (const item of items) {
    const len = (item.raw_text || '').length;
    if (current.length > 0 && (current.length >= maxItems || chars + len > maxChars)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += len;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export function buildBatchMessages(chunk) {
  return [
    {
      role: 'system',
      content:
        'You translate social media / news posts to English for an OSINT analyst. ' +
        'You receive a JSON array of {"i": number, "text": string}. Reply with ONLY a JSON array with exactly ' +
        'one entry per input item: [{"i": number, "lang": "<ISO 639-1 code of the original>", "en": "<English translation>"}]. ' +
        'Keep every number, name and place exactly. No commentary, no Markdown fences.',
    },
    { role: 'user', content: JSON.stringify(chunk.map((item, idx) => ({ i: idx + 1, text: item.raw_text }))) },
  ];
}

// Returns Map(index -> { lang, en }) for the entries that are usable.
export function parseBatchReply(content, size) {
  const text = String(content || '');
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) throw new Error('batch reply is not a JSON array');
  const parsed = JSON.parse(text.slice(start, end + 1));
  const out = new Map();
  for (const entry of Array.isArray(parsed) ? parsed : []) {
    const i = Number(entry?.i);
    const en = typeof entry?.en === 'string' ? entry.en.trim() : '';
    if (Number.isInteger(i) && i >= 1 && i <= size && en && !out.has(i)) {
      out.set(i, { en, lang: LANG_CODE_RE.test(entry.lang || '') ? entry.lang.toLowerCase() : null });
    }
  }
  return out;
}

export async function revertToNew(ids) {
  if (ids.length > 0) {
    await pool.query(`UPDATE raw_items SET status = 'new', updated_at = now() WHERE id = ANY($1)`, [ids]);
  }
}

async function runLLMBatch(claimed) {
  const results = [];
  const toTranslate = [];
  for (const item of claimed) {
    const skipped = await trySkip(item);
    if (skipped) results.push(skipped);
    else toTranslate.push(item);
  }

  const chunks = LLM_BATCH > 1 ? chunkForBatch(toTranslate) : toTranslate.map((item) => [item]);
  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c];
    let leftovers = chunk;
    if (chunk.length > 1) {
      try {
        await llmGate.wait();
        const { content, model } = await callLLM(buildBatchMessages(chunk));
        let got = new Map();
        try {
          got = parseBatchReply(content, chunk.length);
        } catch {
          // Unusable reply: every post in the chunk falls back to one-by-one.
        }
        leftovers = [];
        for (let idx = 0; idx < chunk.length; idx++) {
          const hit = got.get(idx + 1);
          if (!hit) {
            leftovers.push(chunk[idx]);
            continue;
          }
          await commitTranslation(chunk[idx].id, {
            sourceLanguage: hit.lang,
            translatedText: hit.en,
            model,
            status: 'done',
          });
          results.push({ id: chunk[idx].id, outcome: 'translated' });
        }
      } catch (err) {
        if (isSystemicFailure(err.message)) {
          // Provider down / out of quota: put this chunk and the rest back.
          await revertToNew(chunks.slice(c).flat().map((i) => i.id));
          results.push({ id: chunk[0].id, outcome: 'failed', error: err.message, systemic: true });
          return results;
        }
        leftovers = chunk;
      }
    }

    for (let i = 0; i < leftovers.length; i++) {
      const result = await processItemLLM(leftovers[i]);
      results.push(result);
      if (result.systemic) {
        // Once the provider/quota is confirmed down for this tick, further
        // calls are just as doomed — put everything not yet attempted back
        // ('translating' is never re-claimed on its own).
        await revertToNew([...leftovers.slice(i + 1), ...chunks.slice(c + 1).flat()].map((x) => x.id));
        return results;
      }
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

// ---------------------------------------------------------------------------
// Rotation across several free providers: TRANSLATION_PROVIDER is an ordered
// list, e.g. "telegram,google,lingva". Each claimed post goes to the first
// provider that is available; a provider that is rate-limited, flood-waited
// or unreachable is rested (for its flood-wait / Retry-After, or a few
// minutes) and the posts move on to the next one, so one provider's limit no
// longer stalls the whole backlog. A post one provider can't handle (e.g.
// too long) is offered to the next as well.
export const LLM_PROVIDERS = new Set(['groq', 'gemini', 'cerebras', 'mistral', 'openrouter', 'ollama', 'llm']);
const REST_MS = Number(process.env.TRANSLATION_PROVIDER_REST_SECONDS || 300) * 1000;
const restingUntil = new Map(); // provider -> timestamp
const webGates = new Map();

export function translationProviders(env = process.env) {
  return String(env.TRANSLATION_PROVIDER || 'groq')
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
}

export const translationRotation = {
  resting: (name) => (restingUntil.get(name) || 0) > Date.now(),
  rest(name, ms = REST_MS) {
    restingUntil.set(name, Date.now() + ms);
    console.warn(`[translation] ${name} unavailable — resting it for ${Math.round(ms / 1000)}s, using the next provider`);
  },
  reset: () => restingUntil.clear(),
};

function webGate(name) {
  if (!webGates.has(name)) webGates.set(name, new RateGate(60_000 / WEB_TRANSLATOR_RATES[name]));
  return webGates.get(name);
}

// Each runner translates what it can from `items` and returns
// { done: Map(id -> {text, lang, model}), errors: Map(id -> message), restMs }
// — restMs set when the provider itself is unavailable (the rest of the
// items were not attempted).
async function runTelegramProvider(items) {
  const done = new Map();
  const errors = new Map();
  for (let i = 0; i < items.length; i += TRANSLATE_CHUNK_SIZE) {
    const chunk = items.slice(i, i + TRANSLATE_CHUNK_SIZE);
    try {
      await telegramGate.wait();
      const translated = await translateBatch(chunk.map((c) => c.raw_text));
      chunk.forEach((item, j) => translated[j] && done.set(item.id, { text: translated[j], lang: null, model: 'telegram' }));
    } catch (err) {
      const flood = floodWaitSeconds(err);
      if (flood) telegramGate.pauseFor(flood * 1000);
      if (flood != null || isTelegramFloodWait(err.message) || !isTelegramAnswer(err)) {
        return { done, errors, restMs: flood ? flood * 1000 : REST_MS };
      }
      for (const item of chunk) errors.set(item.id, `telegram: ${err.message}`);
    }
  }
  return { done, errors, restMs: null };
}

async function runWebProvider(name, items) {
  const done = new Map();
  const errors = new Map();
  for (const item of items) {
    try {
      await webGate(name).wait();
      const r = await WEB_TRANSLATORS[name](item.raw_text);
      if (looksDegenerate(item.raw_text, r.text)) errors.set(item.id, `${name}: unusable translation (garbled or empty)`);
      else done.set(item.id, { text: r.text.trim(), lang: r.lang, model: name });
    } catch (err) {
      if (err.systemic) return { done, errors, restMs: err.retryAfterMs || REST_MS };
      errors.set(item.id, err.message);
    }
  }
  return { done, errors, restMs: null };
}

async function runLLMProvider(name, items) {
  const done = new Map();
  const errors = new Map();
  const providerName = name === 'llm' ? undefined : name;
  for (const chunk of chunkForBatch(items)) {
    try {
      await llmGate.wait();
      const { content, model } = await callLLM(buildBatchMessages(chunk), { providerName });
      let got = new Map();
      try {
        got = parseBatchReply(content, chunk.length);
      } catch {
        // unusable reply: these posts move on to the next provider
      }
      chunk.forEach((item, idx) => {
        const hit = got.get(idx + 1);
        if (hit) done.set(item.id, { text: hit.en, lang: hit.lang, model });
        else errors.set(item.id, `${name}: post missing from batch reply`);
      });
    } catch (err) {
      if (isSystemicFailure(err.message) || /not configured|fetch failed|timeout|aborted/i.test(err.message)) {
        return { done, errors, restMs: REST_MS };
      }
      for (const item of chunk) errors.set(item.id, `${name}: ${err.message}`);
    }
  }
  return { done, errors, restMs: null };
}

export function runProvider(name, items) {
  if (name === 'telegram') return runTelegramProvider(items);
  if (WEB_TRANSLATORS[name]) return runWebProvider(name, items);
  if (LLM_PROVIDERS.has(name)) return runLLMProvider(name, items);
  throw new Error(
    `Unknown TRANSLATION_PROVIDER "${name}" — use ${['telegram', ...Object.keys(WEB_TRANSLATORS), ...LLM_PROVIDERS].join(', ')}`
  );
}

async function runRotation(claimed, providers) {
  const results = [];
  let pending = [];
  for (const item of claimed) {
    const skipped = await trySkip(item);
    if (skipped) results.push(skipped);
    else pending.push(item);
  }
  const errors = new Map();

  for (const name of providers) {
    if (pending.length === 0) break;
    if (translationRotation.resting(name)) continue;
    const r = await runProvider(name, pending);
    for (const [id, t] of r.done) {
      await commitTranslation(id, { sourceLanguage: t.lang, translatedText: t.text, model: t.model, status: 'done' });
      results.push({ id, outcome: 'translated', provider: name });
    }
    for (const [id, msg] of r.errors) errors.set(id, msg);
    pending = pending.filter((item) => !r.done.has(item.id));
    if (r.restMs) translationRotation.rest(name, r.restMs);
  }

  // Left over: a post some provider rejected counts an attempt; a post that
  // only met unavailable providers simply goes back to the queue.
  for (const item of pending) {
    const msg = errors.get(item.id);
    if (msg) {
      await pool.query(
        `UPDATE raw_items SET status = 'failed_translation', translation_attempts = translation_attempts + 1, updated_at = now() WHERE id = $1`,
        [item.id]
      );
      await upsertTranslation(pool, { id: item.id, status: 'failed', errorMessage: msg });
      results.push({ id: item.id, outcome: 'failed', error: msg });
    } else {
      await revertToNew([item.id]);
      results.push({ id: item.id, outcome: 'reverted' });
    }
  }
  return results;
}

export async function runTranslationTick() {
  const providers = translationProviders();
  const rotation = providers.length > 1 || providers.some((p) => WEB_TRANSLATORS[p]);
  // While every provider is resting (or Telegram is flood-waited), don't
  // claim anything — the posts stay queued (and visible in the feed)
  // instead of sitting in 'translating' for the whole wait.
  if (rotation && providers.every((p) => translationRotation.resting(p))) return [];
  const provider = providers[0];
  if (!rotation && provider === 'telegram' && telegramGate.isPaused()) return [];

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

  if (rotation) return runRotation(claimed, providers);
  return provider === 'telegram' ? runTelegramBatch(claimed) : runLLMBatch(claimed);
}
