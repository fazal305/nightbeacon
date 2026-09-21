import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../db/pool.js';
import { runClassificationTick } from './classify.js';
import { classify } from './classificationRules.js';

test('classify: deterministic category and priority scoring', () => {
  const high = classify('Airstrike hits residential building, dozens killed.');
  assert.equal(high.category, 'security-incident');
  assert.equal(high.priority, 'high');
  assert.ok(high.tags.length > 0);

  const medium = classify('Protesters clash with police near the capital.');
  assert.equal(medium.priority, 'medium');

  const none = classify('The weather today is mild with clear skies.');
  assert.equal(none.category, null);
  assert.equal(none.priority, 'informational');

  const empty = classify('');
  assert.equal(empty.category, null);
  assert.equal(empty.priority, 'informational');
});

test('classification tick: claims translated items, sets category/priority/tags, moves to ready', async () => {
  const src = await pool.query(
    `INSERT INTO sources (channel_username, display_name) VALUES ($1, $2) RETURNING id`,
    [`test_classify_${Date.now()}`, 'Test Source']
  );
  const sourceId = src.rows[0].id;

  const item = await pool.query(
    `INSERT INTO raw_items (source_id, telegram_message_id, telegram_date, raw_text, status)
     VALUES ($1, 1, now(), 'Missile strike reported, casualties feared.', 'translated')
     RETURNING id`,
    [sourceId]
  );

  await runClassificationTick();

  const after = await pool.query('SELECT status, category, priority FROM raw_items WHERE id = $1', [
    item.rows[0].id,
  ]);
  assert.equal(after.rows[0].status, 'ready');
  assert.equal(after.rows[0].category, 'security-incident');
  assert.equal(after.rows[0].priority, 'high');

  const tags = await pool.query('SELECT count(*) FROM item_tags WHERE raw_item_id = $1', [
    item.rows[0].id,
  ]);
  assert.ok(Number(tags.rows[0].count) > 0);

  await pool.query('DELETE FROM raw_items WHERE source_id = $1', [sourceId]);
  await pool.query('DELETE FROM sources WHERE id = $1', [sourceId]);
});

test.after(async () => {
  await pool.end();
});
