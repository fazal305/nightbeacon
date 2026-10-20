import { pool } from '../db/pool.js';
import { getTelegramClient } from './telegramClient.js';
import { fetchHistory, insertMessages, withSourceLock, POLL_BATCH_LIMIT } from './pollSource.js';

const MAX_GAP_ATTEMPTS = Number(process.env.BACKFILL_MAX_ATTEMPTS || 5);

// Fills one page of the oldest open ingestion gap (recorded by the live poller
// when a channel posted more than one batch between polls). Works from the
// gap's newest end backwards, shrinking max_id each step, so a crash mid-gap
// resumes exactly where it stopped. Rows are tagged ingest_path='backfill',
// which the processing queues rank behind live posts.
//
// Returns true when it did any work (so the scheduler knows whether to idle).
export async function runBackfillStep({ tgClient } = {}) {
  const { rows } = await pool.query(
    `SELECT g.*, s.channel_username, s.telegram_channel_id, s.telegram_access_hash
     FROM ingestion_gaps g
     JOIN sources s ON s.id = g.source_id
     WHERE g.completed_at IS NULL AND g.attempts < $1 AND s.enabled
     ORDER BY g.created_at
     LIMIT 1`,
    [MAX_GAP_ATTEMPTS]
  );
  const gap = rows[0];
  if (!gap) return false;

  const source = {
    id: gap.source_id,
    channel_username: gap.channel_username,
    telegram_channel_id: gap.telegram_channel_id,
    telegram_access_hash: gap.telegram_access_hash,
  };

  await withSourceLock(source.id, async () => {
    let messages;
    try {
      const c = tgClient || (await getTelegramClient());
      messages = await fetchHistory(c, source, {
        minId: Number(gap.min_id),
        maxId: Number(gap.max_id),
        limit: POLL_BATCH_LIMIT,
      });
    } catch (err) {
      await pool.query(
        `UPDATE ingestion_gaps SET attempts = attempts + 1, last_error = $2, updated_at = now() WHERE id = $1`,
        [gap.id, err.message]
      );
      return;
    }

    const observedAt = new Date();
    const fetched = messages.filter((m) => m.id != null);
    const minFetched = fetched.reduce((min, m) => Math.min(min, m.id), Infinity);
    const done = fetched.length < POLL_BATCH_LIMIT || minFetched <= Number(gap.min_id) + 1;

    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      await insertMessages(tx, source.id, fetched, { observedAt, ingestPath: 'backfill' });
      await tx.query(
        done
          ? `UPDATE ingestion_gaps SET completed_at = now(), updated_at = now() WHERE id = $1`
          : `UPDATE ingestion_gaps SET max_id = $2, updated_at = now() WHERE id = $1`,
        done ? [gap.id] : [gap.id, minFetched]
      );
      await tx.query('COMMIT');
    } catch (err) {
      await tx.query('ROLLBACK');
      throw err;
    } finally {
      tx.release();
    }
  });
  return true;
}
