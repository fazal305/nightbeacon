// Shows why ingestion is failing: the latest ingestion runs, their errors,
// and how many polls succeeded recently.
//   npm run ingest:check
import 'dotenv/config';
import { pool } from '../db/pool.js';

try {
  const { rows: runs } = await pool.query(
    `SELECT status, processed_count, error_count, completed_at, last_error
     FROM subsystem_status WHERE subsystem_name = 'ingestion' ORDER BY id DESC LIMIT 8`
  );
  console.log('Latest ingestion runs (one per minute):');
  for (const r of runs) {
    console.log(`  ${new Date(r.completed_at).toLocaleTimeString()}  ${r.status.padEnd(8)} ${r.processed_count - r.error_count}/${r.processed_count} polls ok`);
    if (r.last_error) console.log(`      error: ${r.last_error.slice(0, 300)}`);
  }
  const { rows: [items] } = await pool.query(
    `SELECT count(*)::int AS n, max(collected_at) AS last FROM raw_items WHERE collected_at > now() - interval '30 minutes'`
  );
  console.log(`\nNew posts stored in the last 30 min: ${items.n}${items.last ? ` (latest ${new Date(items.last).toLocaleTimeString()})` : ''}`);
  const { rows: errs } = await pool.query(
    `SELECT channel_username, last_error FROM sources
     WHERE last_error IS NOT NULL AND updated_at > now() - interval '30 minutes' ORDER BY updated_at DESC LIMIT 5`
  ).catch(() => ({ rows: [] }));
  if (errs.length) {
    console.log('\nRecent channel errors:');
    for (const e of errs) console.log(`  @${e.channel_username}: ${String(e.last_error).slice(0, 200)}`);
  }
} catch (err) {
  console.error(`Could not read the database: ${err.message}`);
} finally {
  await pool.end().catch(() => {});
}
