import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../db/pool.js';
import { claimBatch } from './claim.js';

after(async () => {
  await pool.end();
});

test('claimBatch: live posts before backlog, round-robin across sources, newest first', async () => {
  // Park anything else in the queue so only this test's rows are eligible.
  await pool.query(`UPDATE raw_items SET status = 'ready' WHERE status = 'translated'`);
  const mk = async (n) =>
    (
      await pool.query(`INSERT INTO sources (channel_username, display_name) VALUES ($1, $1) RETURNING id`, [
        `claim_${n}_${Date.now()}`,
      ])
    ).rows[0].id;
  const busy = await mk('busy');
  const quiet = await mk('quiet');
  const ins = async (source, msg, minutesAgo) =>
    (
      await pool.query(
        `INSERT INTO raw_items (source_id, telegram_message_id, telegram_date, raw_text, status)
         VALUES ($1, $2, now() - make_interval(mins => $3), 'x', 'translated') RETURNING id`,
        [source, msg, minutesAgo]
      )
    ).rows[0].id;

  const oldBacklog = await ins(quiet, 1, 60 * 24 * 3); // 3 days old
  const busyIds = [];
  for (let i = 0; i < 5; i++) busyIds.push(await ins(busy, 100 + i, i)); // 5 fresh posts from one channel
  const quietFresh = await ins(quiet, 2, 10);

  try {
    const claimed = await claimBatch({
      eligibleSql: `status = 'translated'`,
      claimStatus: 'tagging',
      limit: 3,
      returning: 'id, telegram_date',
    });
    const ids = claimed.map((r) => Number(r.id));
    assert.equal(ids.length, 3);
    // The quiet channel's fresh post gets a slot even though the busy
    // channel has 5 newer posts; the 3-day-old backlog item waits.
    assert.ok(ids.includes(Number(quietFresh)), 'fairness: quiet channel not starved');
    assert.ok(!ids.includes(Number(oldBacklog)), 'backlog waits behind live posts');
    assert.ok(ids.includes(Number(busyIds[0])), 'newest post from busy channel first');

    const rest = await claimBatch({ eligibleSql: `status = 'translated'`, claimStatus: 'tagging', limit: 10, returning: 'id, telegram_date' });
    assert.equal(rest.length, 4, 'already-claimed rows are not claimed twice');
    assert.equal(Number(rest[rest.length - 1].id), Number(oldBacklog), 'backlog still processed once live work is drained');
  } finally {
    await pool.query('DELETE FROM raw_items WHERE source_id = ANY($1)', [[busy, quiet]]);
    await pool.query('DELETE FROM sources WHERE id = ANY($1)', [[busy, quiet]]);
  }
});
