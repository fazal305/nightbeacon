import { pool } from '../db/pool.js';
import { getTelegramClient } from './telegramClient.js';

const POLL_BATCH_LIMIT = 100;

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

export async function pollSource(source) {
  const lockKey = advisoryLockKey(source.id);
  const lockClient = await pool.connect();

  try {
    const { rows } = await lockClient.query('SELECT pg_try_advisory_lock($1) AS locked', [lockKey]);
    if (!rows[0].locked) {
      return { skipped: true, reason: 'poll already in progress for this source' };
    }

    try {
      return await doPoll(source);
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock($1)', [lockKey]);
    }
  } finally {
    lockClient.release();
  }
}

async function doPoll(source) {
  const client = await getTelegramClient();

  let messages;
  try {
    messages = await client.getMessages(source.channel_username, {
      minId: source.last_seen_id,
      limit: POLL_BATCH_LIMIT,
    });
  } catch (err) {
    await recordPollFailure(source.id, err.message);
    throw err;
  }

  const textMessages = messages.filter((m) => m.id != null);

  if (textMessages.length === 0) {
    await recordPollSuccess(source.id, source.last_seen_id, 0);
    return { inserted: 0, maxId: source.last_seen_id };
  }

  // Never trust API return order for "the newest id" — compute it explicitly.
  const maxId = textMessages.reduce((max, m) => Math.max(max, m.id), source.last_seen_id);

  const txClient = await pool.connect();
  let insertedCount = 0;
  try {
    await txClient.query('BEGIN');

    for (const m of textMessages) {
      const result = await txClient.query(
        `INSERT INTO raw_items (source_id, telegram_message_id, telegram_date, raw_text, raw_metadata, has_media)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (source_id, telegram_message_id) DO NOTHING`,
        [
          source.id,
          m.id,
          new Date(m.date * 1000),
          m.message || null,
          JSON.stringify(m.toJSON ? m.toJSON() : {}),
          Boolean(m.media),
        ]
      );
      insertedCount += result.rowCount;
    }

    await txClient.query(
      `UPDATE sources
       SET last_seen_id = GREATEST(last_seen_id, $2),
           last_poll_at = now(),
           last_success_at = now(),
           last_error = NULL,
           poll_error_count = 0,
           updated_at = now()
       WHERE id = $1`,
      [source.id, maxId]
    );

    await txClient.query('COMMIT');
  } catch (err) {
    await txClient.query('ROLLBACK');
    throw err;
  } finally {
    txClient.release();
  }

  return { inserted: insertedCount, maxId };
}

async function recordPollSuccess(sourceId, lastSeenId, inserted) {
  await pool.query(
    `UPDATE sources
     SET last_poll_at = now(), last_success_at = now(), last_error = NULL, poll_error_count = 0, updated_at = now()
     WHERE id = $1`,
    [sourceId]
  );
}

async function recordPollFailure(sourceId, errorMessage) {
  await pool.query(
    `UPDATE sources
     SET last_poll_at = now(), last_error = $2, poll_error_count = poll_error_count + 1, updated_at = now()
     WHERE id = $1`,
    [sourceId, errorMessage]
  );
}

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
