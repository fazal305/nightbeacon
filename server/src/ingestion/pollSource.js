import { pool } from '../db/pool.js';
import {
  getTelegramClient,
  requestGate,
  resolveSourcePeer,
  forgetSourcePeer,
  handleFloodWait,
  isStalePeerError,
} from './telegramClient.js';

export const POLL_BATCH_LIMIT = Number(process.env.POLL_BATCH_LIMIT || 100);

// Adaptive per-source cadence. A channel that just posted is polled again
// soon; a quiet one backs off gradually. The overall request rate is still
// capped by requestGate (one request per POLL_INTER_SOURCE_DELAY_MS), so this
// only decides WHICH channels get the available requests first — it never
// makes polling as a whole more aggressive towards Telegram.
const MIN_INTERVAL_S = Number(process.env.POLL_MIN_INTERVAL_SECONDS || 60);
const MAX_INTERVAL_S = Number(process.env.POLL_MAX_INTERVAL_SECONDS || 600);
const MAX_ERROR_BACKOFF_S = Number(process.env.POLL_MAX_ERROR_BACKOFF_SECONDS || 3600);

export function nextIntervalSeconds(prevInterval, fetchedCount) {
  if (fetchedCount > 0) return MIN_INTERVAL_S;
  return Math.min(MAX_INTERVAL_S, Math.max(MIN_INTERVAL_S, Math.round((prevInterval || MIN_INTERVAL_S) * 1.5)));
}

export function errorBackoffSeconds(consecutiveErrors) {
  return Math.min(MAX_ERROR_BACKOFF_S, MIN_INTERVAL_S * 2 ** Math.min(consecutiveErrors, 10));
}

// Deterministic key for pg_try_advisory_lock — derived from the source's uuid so
// two poll ticks (or, later, two worker processes) can never process the same
// source concurrently. This is a DB-level lock, not in-memory, so it stays correct
// even if ingestion is later split into a separate worker process.
function advisoryLockKey(sourceId) {
  let hash = 0;
  for (let i = 0; i < sourceId.length; i++) {
    hash = (hash * 31 + sourceId.charCodeAt(i)) | 0;
  }
  return hash;
}

export async function withSourceLock(sourceId, fn) {
  const lockKey = advisoryLockKey(sourceId);
  const lockClient = await pool.connect();
  try {
    const { rows } = await lockClient.query('SELECT pg_try_advisory_lock($1) AS locked', [lockKey]);
    if (!rows[0].locked) {
      return { skipped: true, reason: 'poll already in progress for this source' };
    }
    try {
      return await fn();
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock($1)', [lockKey]);
    }
  } finally {
    lockClient.release();
  }
}

// Idempotent insert shared by polling, live updates and backfill. Media-only
// posts (no caption text) are not stored — nothing for translation/
// classification to work with. Returns the number of NEW rows.
export async function insertMessages(db, sourceId, messages, { observedAt, ingestPath }) {
  let inserted = 0;
  for (const m of messages) {
    if (m.id == null || !m.message || !m.message.trim()) continue;
    const result = await db.query(
      `INSERT INTO raw_items (source_id, telegram_message_id, telegram_date, raw_text, raw_metadata, has_media,
                             observed_at, ingest_path)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (source_id, telegram_message_id) DO NOTHING`,
      [
        sourceId,
        m.id,
        new Date(m.date * 1000),
        m.message,
        JSON.stringify(m.toJSON ? m.toJSON() : {}),
        Boolean(m.media),
        observedAt,
        ingestPath,
      ]
    );
    inserted += result.rowCount;
  }
  return inserted;
}

// Fetch a page of history through the shared request gate, translating
// flood-waits into a global pause. `tgClient` is injectable for tests.
export async function fetchHistory(tgClient, source, params) {
  const peer = await resolveSourcePeer(tgClient, source);
  await requestGate.wait();
  try {
    return await tgClient.getMessages(peer, params);
  } catch (err) {
    handleFloodWait(err, 'history');
    if (isStalePeerError(err) && source.telegram_access_hash != null) await forgetSourcePeer(source.id);
    throw err;
  }
}

export async function pollSource(source, { tgClient } = {}) {
  return withSourceLock(source.id, () => doPoll(source, tgClient));
}

async function doPoll(source, tgClient) {
  let messages;
  let observedAt;
  try {
    const c = tgClient || (await getTelegramClient());
    // getMessages with minId walks back from the NEWEST message and stops at
    // minId, so it always returns the newest POLL_BATCH_LIMIT messages — the
    // live edge comes first. If more than a batch arrived since the last
    // poll, the older remainder is recorded as a gap for the backfill worker
    // (previously it was silently skipped forever, because last_seen_id
    // jumped straight past it).
    messages = await fetchHistory(c, source, { minId: Number(source.last_seen_id), limit: POLL_BATCH_LIMIT });
    observedAt = new Date();
  } catch (err) {
    await recordPollFailure(source, err);
    throw err;
  }

  const fetched = messages.filter((m) => m.id != null);
  const lastSeen = Number(source.last_seen_id);
  const maxId = fetched.reduce((max, m) => Math.max(max, m.id), lastSeen);
  const minFetched = fetched.reduce((min, m) => Math.min(min, m.id), Infinity);
  // Only a full batch can hide older unseen messages; first-ever polls
  // (last_seen_id 0) intentionally start from "now", not the channel's
  // entire history.
  const gap = lastSeen > 0 && fetched.length >= POLL_BATCH_LIMIT && minFetched > lastSeen + 1
    ? { min: lastSeen, max: minFetched }
    : null;

  const interval = nextIntervalSeconds(source.poll_interval_seconds, fetched.length);
  const newestDate = fetched.reduce((d, m) => Math.max(d, m.date || 0), 0);

  const txClient = await pool.connect();
  let insertedCount = 0;
  try {
    await txClient.query('BEGIN');
    insertedCount = await insertMessages(txClient, source.id, fetched, { observedAt, ingestPath: 'poll' });

    if (gap) {
      await txClient.query(`INSERT INTO ingestion_gaps (source_id, min_id, max_id) VALUES ($1, $2, $3)`, [
        source.id,
        gap.min,
        gap.max,
      ]);
    }

    // last_seen_id advances past every fetched message, including media-only
    // ones we don't store — otherwise a mostly-media channel would re-fetch
    // the same messages forever.
    await txClient.query(
      `UPDATE sources
       SET last_seen_id = GREATEST(last_seen_id, $2),
           last_poll_at = now(),
           last_success_at = now(),
           last_error = NULL,
           poll_error_count = 0,
           poll_interval_seconds = $3::int,
           next_poll_at = now() + make_interval(secs => $3::int),
           last_message_at = GREATEST(last_message_at, $4),
           updated_at = now()
       WHERE id = $1`,
      [source.id, maxId, interval, newestDate ? new Date(newestDate * 1000) : null]
    );

    await txClient.query('COMMIT');
  } catch (err) {
    await txClient.query('ROLLBACK');
    throw err;
  } finally {
    txClient.release();
  }

  return { inserted: insertedCount, fetched: fetched.length, maxId, gap };
}

const CONNECTIVITY_PAUSE_MS = Number(process.env.TELEGRAM_CONNECTIVITY_PAUSE_MS || 15000);

// Telegram's own RPC errors carry a code / errorMessage (CHANNEL_INVALID,
// FLOOD_WAIT_X, ...). Anything else — missing credentials, connect failure,
// proxy down, socket timeout — means we never got an answer about this
// channel at all.
export function isConnectivityError(err) {
  return !(err && (err.code || err.errorMessage || typeof err.seconds === 'number'));
}

async function recordPollFailure(source, err) {
  // Neither a flood-wait nor a connectivity failure is this channel's fault.
  // Penalising each channel would push hundreds of them into hour-long
  // backoff during a proxy outage, delaying recovery long after the
  // connection is back. Instead: pause ingestion globally (flood-wait: for
  // its duration, set by handleFloodWait; connectivity: briefly) and leave
  // the channel's error backoff untouched.
  const flood = err && typeof err.seconds === 'number' ? err.seconds : null;
  const connectivity = flood == null && isConnectivityError(err);
  if (connectivity) requestGate.pauseFor(CONNECTIVITY_PAUSE_MS);
  const delay = flood ?? (connectivity ? 0 : errorBackoffSeconds((source.poll_error_count || 0) + 1));
  await pool.query(
    `UPDATE sources
     SET last_poll_at = now(), last_error = $2,
         poll_error_count = poll_error_count + $3,
         next_poll_at = now() + make_interval(secs => $4),
         updated_at = now()
     WHERE id = $1`,
    [source.id, err.message, flood != null || connectivity ? 0 : 1, delay]
  );
}

// Picks the source whose turn it is: never-polled sources first, then the
// most overdue. When there are more due sources than request budget, this
// degrades to a fair round-robin by how long each has waited.
export async function nextDueSource() {
  const { rows } = await pool.query(
    `SELECT * FROM sources
     WHERE enabled AND (next_poll_at IS NULL OR next_poll_at <= now())
     ORDER BY next_poll_at NULLS FIRST, last_poll_at NULLS FIRST
     LIMIT 1`
  );
  return rows[0] || null;
}

// Kept for manual one-off use (and the existing tests); the server itself now
// uses the continuous scheduler in scheduler.js.
export async function pollAllEnabledSources() {
  const { rows: sources } = await pool.query('SELECT * FROM sources WHERE enabled = true');
  const results = [];
  for (const source of sources) {
    try {
      const result = await pollSource(source);
      results.push({ sourceId: source.id, ...result });
    } catch (err) {
      results.push({ sourceId: source.id, error: err.message });
    }
  }
  return results;
}
