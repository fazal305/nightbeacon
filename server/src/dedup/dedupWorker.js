import { pool } from '../db/pool.js';
import { normalizeText, contentHash, extractNumbers, MIN_FUZZY_LENGTH } from './normalize.js';
import { embedTexts, embeddingConfig, cosine } from './embeddings.js';
import { decide, dedupThresholds } from './decide.js';

// Stage B + C of the pipeline: runs on the ORIGINAL text, before any
// translation or LLM call, so a story reported by twenty channels is
// translated and classified once — not twenty times.
//
// Single writer: the whole tick holds a global advisory lock. Two dedup
// workers racing could each decide "no existing story" for two copies of the
// same post and create two stories; serialising avoids that without any
// per-row locking. Dedup is cheap (hash lookup, one trigram query, an
// in-memory cosine scan), so one worker comfortably keeps up.

const DEDUP_LOCK_KEY = 0x6e6264; // "nbd"
const BATCH_SIZE = Number(process.env.DEDUP_BATCH_SIZE || 100);

// In-memory index of recent story embeddings for the semantic scan. Only
// this worker writes stories, so it can keep the index in sync itself
// instead of re-reading thousands of vectors from Postgres per item.
const semanticIndex = {
  loaded: false,
  model: null,
  stories: new Map(), // id -> { id, embedding, numbers, first_seen_at, last_seen_at }
};

export function _resetSemanticIndex() {
  semanticIndex.loaded = false;
  semanticIndex.model = null;
  semanticIndex.stories.clear();
}

async function ensureSemanticIndex(model, t) {
  if (semanticIndex.loaded && semanticIndex.model === model) {
    pruneSemanticIndex(t);
    return;
  }
  semanticIndex.stories.clear();
  const { rows } = await pool.query(
    `SELECT id, embedding, numbers, first_seen_at, last_seen_at
     FROM stories
     WHERE embedding IS NOT NULL AND embedding_model = $1
       AND last_seen_at >= now() - make_interval(hours => $2)
     ORDER BY last_seen_at DESC
     LIMIT $3`,
    [model, t.semanticWindowHours, t.semanticMaxCandidates]
  );
  for (const r of rows) semanticIndex.stories.set(Number(r.id), { ...r, id: Number(r.id) });
  semanticIndex.loaded = true;
  semanticIndex.model = model;
}

function pruneSemanticIndex(t) {
  const cutoff = Date.now() - t.semanticWindowHours * 3_600_000;
  for (const [id, s] of semanticIndex.stories) {
    if (new Date(s.last_seen_at).getTime() < cutoff) semanticIndex.stories.delete(id);
  }
  // Keep the scan bounded even during a burst: drop the stalest beyond the cap.
  if (semanticIndex.stories.size > t.semanticMaxCandidates) {
    const sorted = [...semanticIndex.stories.values()].sort(
      (a, b) => new Date(a.last_seen_at) - new Date(b.last_seen_at)
    );
    for (const s of sorted.slice(0, semanticIndex.stories.size - t.semanticMaxCandidates)) {
      semanticIndex.stories.delete(s.id);
    }
  }
}

function bestSemanticMatch(embedding) {
  let best = null;
  for (const s of semanticIndex.stories.values()) {
    const sim = cosine(embedding, s.embedding);
    if (!best || sim > best.similarity) best = { story: s, similarity: sim };
  }
  return best;
}

async function findExact(client, item, hash) {
  const { rows } = await client.query(
    `SELECT s.id, s.numbers, s.first_seen_at, s.last_seen_at
     FROM raw_items ri
     JOIN stories s ON s.id = ri.story_id
     WHERE ri.content_hash = $1 AND ri.id <> $2
     ORDER BY abs(extract(epoch FROM ri.telegram_date - $3::timestamptz))
     LIMIT 1`,
    [hash, item.id, item.telegram_date]
  );
  return rows[0] ? { story: rows[0] } : null;
}

async function findFuzzy(client, item, normalized, t) {
  // `%` uses the pg_trgm GIN index (default similarity_threshold 0.3) to
  // shortlist; decide() applies the real, much stricter threshold.
  const { rows } = await client.query(
    `SELECT s.id, s.numbers, s.first_seen_at, s.last_seen_at,
            similarity(s.normalized_text, $1) AS similarity
     FROM stories s
     WHERE s.normalized_text % $1
       AND s.last_seen_at BETWEEN $2::timestamptz - make_interval(hours => $3)
                              AND $2::timestamptz + make_interval(hours => $3)
     ORDER BY similarity DESC
     LIMIT 1`,
    [normalized, item.telegram_date, t.fuzzyWindowHours]
  );
  return rows[0] ? { story: rows[0], similarity: Number(rows[0].similarity) } : null;
}

async function applyDecision(client, item, prepared, result, embedding, model) {
  const { normalized, hash, numbers } = prepared;

  if (result.decision === 'unique') {
    const { rows } = await client.query(
      `INSERT INTO stories (canonical_item_id, normalized_text, content_hash, numbers, embedding, embedding_model,
                            first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       RETURNING id, numbers, first_seen_at, last_seen_at`,
      [item.id, normalized, hash, numbers, embedding, embedding ? model : null, item.telegram_date]
    );
    const story = rows[0];
    await client.query(
      `UPDATE raw_items
       SET normalized_text = $2, content_hash = $3, dedup_status = 'unique', story_id = $4,
           dedup_method = NULL, dedup_score = NULL, dedup_at = clock_timestamp(), updated_at = now()
       WHERE id = $1`,
      [item.id, normalized, hash, story.id]
    );
    return { storyId: Number(story.id), story };
  }

  const isUpdate = result.decision === 'update';
  const { rows } = await client.query(
    `UPDATE stories
     SET item_count = item_count + 1,
         update_count = update_count + $2::int,
         numbers = CASE WHEN $2::int = 1
                        THEN ARRAY(SELECT DISTINCT unnest(numbers || $3::text[]) ORDER BY 1)
                        ELSE numbers END,
         first_seen_at = LEAST(first_seen_at, $4),
         last_seen_at = GREATEST(last_seen_at, $4),
         updated_at = now()
     WHERE id = $1
     RETURNING id, numbers, first_seen_at, last_seen_at`,
    [result.storyId, isUpdate ? 1 : 0, numbers, item.telegram_date]
  );
  // Duplicates skip translation/classification entirely (status
  // 'duplicate'); updates carry new information, so they stay 'new' and go
  // through the rest of the pipeline like any unique story.
  await client.query(
    `UPDATE raw_items
     SET normalized_text = $2, content_hash = $3, dedup_status = $4, story_id = $5,
         dedup_method = $6, dedup_score = $7, dedup_at = clock_timestamp(),
         status = CASE WHEN $4 = 'duplicate' AND status = 'new' THEN 'duplicate' ELSE status END,
         updated_at = now()
     WHERE id = $1`,
    [item.id, normalized, hash, result.decision, result.storyId, result.method, result.score]
  );
  return { storyId: Number(result.storyId), story: rows[0] };
}

async function processItem(client, item, embedding, model, t) {
  const normalized = normalizeText(item.raw_text);
  const hash = contentHash(normalized);
  const numbers = extractNumbers(item.raw_text);
  const longEnough = normalized.length >= MIN_FUZZY_LENGTH;

  const exact = await findExact(client, item, hash);
  const fuzzy = !exact && longEnough ? await findFuzzy(client, item, normalized, t) : null;
  const semantic = !exact && longEnough && embedding ? bestSemanticMatch(embedding) : null;

  const result = decide({ item: { telegramDate: item.telegram_date, numbers }, exact, fuzzy, semantic }, t);

  await client.query('BEGIN');
  try {
    const applied = await applyDecision(client, item, { normalized, hash, numbers }, result, embedding, model);
    await client.query('COMMIT');

    if (embedding || semanticIndex.stories.has(applied.storyId)) {
      const prev = semanticIndex.stories.get(applied.storyId);
      const story = applied.story;
      semanticIndex.stories.set(applied.storyId, {
        id: applied.storyId,
        embedding: prev?.embedding ?? embedding,
        numbers: story.numbers,
        first_seen_at: story.first_seen_at,
        last_seen_at: story.last_seen_at,
      });
    }
    return { id: item.id, outcome: result.decision, method: result.method, storyId: applied.storyId };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

// `embed` is injectable so tests can supply deterministic vectors.
export async function runDedupTick({ embed = embedTexts } = {}) {
  const client = await pool.connect();
  try {
    const { rows: lock } = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [DEDUP_LOCK_KEY]);
    if (!lock[0].locked) return [];

    try {
      const t = dedupThresholds();
      // Newest first: live posts are deduped (and so reach translation)
      // ahead of any historical backlog.
      const { rows: items } = await client.query(
        `SELECT id, source_id, raw_text, telegram_date
         FROM raw_items
         WHERE dedup_status = 'pending'
         ORDER BY telegram_date DESC, id DESC
         LIMIT $1`,
        [BATCH_SIZE]
      );
      if (items.length === 0) return [];

      // Embeddings only for recent posts long enough to compare; old
      // backlog gets the cheap checks only (its contemporaries have long
      // since left the semantic window anyway).
      const cfg = embeddingConfig();
      const cutoff = Date.now() - t.semanticWindowHours * 3_600_000;
      const toEmbed = cfg.enabled
        ? items.filter(
            (i) =>
              new Date(i.telegram_date).getTime() >= cutoff && normalizeText(i.raw_text).length >= MIN_FUZZY_LENGTH
          )
        : [];
      const vectors = new Map();
      if (toEmbed.length > 0) {
        const embedded = await embed(toEmbed.map((i) => i.raw_text));
        if (embedded) {
          await ensureSemanticIndex(cfg.model, t);
          toEmbed.forEach((i, idx) => vectors.set(i.id, embedded[idx]));
        }
      }

      // Selected newest-first (live priority), but processed oldest-first so
      // the earliest report in a batch becomes the story's canonical item and
      // later relays attach to it.
      items.reverse();

      const results = [];
      for (const item of items) {
        try {
          results.push(await processItem(client, item, vectors.get(item.id) ?? null, cfg.model, t));
        } catch (err) {
          // Fail open: an item dedup can't handle is passed on as unique
          // (worst case: one extra translation) rather than retried forever
          // or held back from the analyst. If the DB itself is down this
          // update throws too and the whole tick is retried later.
          await client.query(
            `UPDATE raw_items SET dedup_status = 'unique', dedup_method = 'error', dedup_at = clock_timestamp(),
                                  updated_at = now()
             WHERE id = $1 AND dedup_status = 'pending'`,
            [item.id]
          );
          results.push({ id: item.id, outcome: 'failed', error: err.message });
        }
      }
      return results;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [DEDUP_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
