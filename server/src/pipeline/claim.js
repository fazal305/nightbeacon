import { pool } from '../db/pool.js';

// Shared work-queue claim used by translation and classification.
//
// Previously both stages claimed `ORDER BY id` — oldest first — so with a
// 12,000+ item backlog every newly arrived post waited behind all of it.
// Now the order is:
//   1. posts from the live window (default: last 6h of Telegram time) first;
//   2. round-robin across sources (rank within its own source), so one
//      channel dumping 100 posts can't monopolise a batch;
//   3. newest first.
// Older backlog is still processed, just only when live work is drained.
//
// The window function can't share a query level with FOR UPDATE, so the
// ranking picks candidates and a second level locks them (SKIP LOCKED) and
// re-checks eligibility — a row claimed by a concurrent tick in between is
// simply skipped, never double-claimed.
export const LIVE_WINDOW_HOURS = Number(process.env.PIPELINE_LIVE_WINDOW_HOURS || 6);

export async function claimBatch({ eligibleSql, eligibleParams = [], claimStatus, limit, returning, db = pool }) {
  const p = eligibleParams.length;
  const { rows } = await db.query(
    `WITH ranked AS (
       SELECT id, telegram_date,
              ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY telegram_date DESC, id DESC) AS source_rank
       FROM raw_items
       WHERE ${eligibleSql}
     ),
     candidates AS (
       SELECT id FROM ranked
       ORDER BY (telegram_date >= now() - make_interval(hours => $${p + 1})) DESC,
                source_rank, telegram_date DESC, id DESC
       LIMIT $${p + 2}
     ),
     locked AS (
       SELECT id FROM raw_items
       WHERE id IN (SELECT id FROM candidates) AND ${eligibleSql}
       FOR UPDATE SKIP LOCKED
     )
     UPDATE raw_items
     SET status = '${claimStatus}', updated_at = now()
     WHERE id IN (SELECT id FROM locked)
     RETURNING ${returning}`,
    [...eligibleParams, LIVE_WINDOW_HOURS, limit]
  );
  // UPDATE ... RETURNING doesn't preserve the CTE's order; restore priority
  // order so per-item processing (and rate-limited providers) handle the
  // most urgent rows first.
  return rows.sort(
    (a, b) => new Date(b.telegram_date) - new Date(a.telegram_date) || Number(b.id) - Number(a.id)
  );
}
