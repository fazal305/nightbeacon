import { pool } from './pool.js';

// 'translating' and 'tagging' are claim-in-progress statuses that only make
// sense while the process that claimed them is still running. If the
// process crashes or restarts (deploy, `--watch` reload, manual restart)
// with items mid-claim, those rows are orphaned: the claim queries only
// ever pick up 'new'/'translated' (or their failed-with-budget-remaining
// counterparts), never 'translating'/'tagging' — so without this, an
// orphaned row would sit stuck forever, invisible to every future tick.
// Safe to run on every boot: nothing legitimately holds these statuses
// across a process restart, since the only writer was this same process.
export async function recoverOrphanedStatuses() {
  const translating = await pool.query(
    `UPDATE raw_items SET status = 'new', updated_at = now() WHERE status = 'translating' RETURNING id`
  );
  const tagging = await pool.query(
    `UPDATE raw_items SET status = 'translated', updated_at = now() WHERE status = 'tagging' RETURNING id`
  );

  const recovered = translating.rowCount + tagging.rowCount;
  if (recovered > 0) {
    console.log(
      `[startup] recovered ${translating.rowCount} orphaned 'translating' + ${tagging.rowCount} orphaned 'tagging' item(s) from a previous process`
    );
  }
  return recovered;
}
