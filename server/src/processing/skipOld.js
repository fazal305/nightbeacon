// Takes posts that are too old to matter out of the translation queue, so
// the translators spend their free allowance on current news. Nothing is
// deleted: the posts keep their original text and get status 'skipped_old'.
//
//   npm run translate:skip-old                       older than 48 hours
//   npm run translate:skip-old -- --hours 24
//   npm run translate:skip-old -- --restore          put them all back in the queue
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../db/pool.js';

export async function skipOld(hours) {
  const { rowCount } = await pool.query(
    `UPDATE raw_items SET status = 'skipped_old', updated_at = now()
     WHERE status IN ('new', 'failed_translation')
       AND telegram_date < now() - make_interval(hours => $1)`,
    [hours]
  );
  return rowCount;
}

export async function restoreOld() {
  const { rowCount } = await pool.query(
    `UPDATE raw_items SET status = 'new', translation_attempts = 0, updated_at = now() WHERE status = 'skipped_old'`
  );
  return rowCount;
}

async function main() {
  if (process.argv.includes('--restore')) {
    console.log(`${await restoreOld()} post(s) put back in the translation queue.`);
    return;
  }
  const i = process.argv.indexOf('--hours');
  const hours = i > -1 ? Number(process.argv[i + 1]) : 48;
  const n = await skipOld(hours);
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM raw_items
     WHERE status IN ('new', 'failed_translation') AND dedup_status IN ('unique', 'update', 'legacy')`
  );
  console.log(`${n} post(s) older than ${hours} hours taken out of the translation queue. ${rows[0].n} still waiting.`);
  console.log('Undo with: npm run translate:skip-old -- --restore');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
    })
    .finally(async () => {
      await pool.end().catch(() => {});
      setTimeout(() => process.exit(), 300);
    });
}
