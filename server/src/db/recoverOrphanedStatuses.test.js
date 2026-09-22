import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from './pool.js';
import { recoverOrphanedStatuses } from './recoverOrphanedStatuses.js';

test('recoverOrphanedStatuses: resets translating->new and tagging->translated, leaves other statuses alone', async () => {
  const src = await pool.query(
    `INSERT INTO sources (channel_username, display_name) VALUES ($1, $2) RETURNING id`,
    [`test_recover_${Date.now()}`, 'Test Source']
  );
  const sourceId = src.rows[0].id;

  const rows = await pool.query(
    `INSERT INTO raw_items (source_id, telegram_message_id, telegram_date, raw_text, status)
     VALUES
       ($1, 1, now(), 'a', 'translating'),
       ($1, 2, now(), 'b', 'tagging'),
       ($1, 3, now(), 'c', 'ready')
     RETURNING id, status`,
    [sourceId]
  );
  const [translatingId, taggingId, readyId] = rows.rows.map((r) => r.id);

  const recovered = await recoverOrphanedStatuses();
  assert.ok(recovered >= 2);

  const after = await pool.query('SELECT id, status FROM raw_items WHERE id = ANY($1) ORDER BY id', [
    [translatingId, taggingId, readyId],
  ]);
  const byId = Object.fromEntries(after.rows.map((r) => [r.id, r.status]));
  assert.equal(byId[translatingId], 'new');
  assert.equal(byId[taggingId], 'translated');
  assert.equal(byId[readyId], 'ready'); // untouched

  await pool.query('DELETE FROM raw_items WHERE source_id = $1', [sourceId]);
  await pool.query('DELETE FROM sources WHERE id = $1', [sourceId]);
});

test.after(async () => {
  await pool.end();
});
