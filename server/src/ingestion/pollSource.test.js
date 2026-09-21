import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../db/pool.js';

// These exercise the actual dedup/locking guarantees against a real Postgres
// instance (DATABASE_URL from .env) — the correctness lives in the database,
// so the tests talk to the database, not a mock.

test('unique constraint prevents duplicate (source_id, telegram_message_id)', async () => {
  const src = await pool.query(
    `INSERT INTO sources (channel_username, display_name) VALUES ($1, $2) RETURNING id`,
    [`test_source_${Date.now()}`, 'Test Source']
  );
  const sourceId = src.rows[0].id;

  const first = await pool.query(
    `INSERT INTO raw_items (source_id, telegram_message_id, telegram_date, raw_text)
     VALUES ($1, 1, now(), 'a') ON CONFLICT (source_id, telegram_message_id) DO NOTHING RETURNING id`,
    [sourceId]
  );
  const second = await pool.query(
    `INSERT INTO raw_items (source_id, telegram_message_id, telegram_date, raw_text)
     VALUES ($1, 1, now(), 'b') ON CONFLICT (source_id, telegram_message_id) DO NOTHING RETURNING id`,
    [sourceId]
  );

  assert.equal(first.rowCount, 1);
  assert.equal(second.rowCount, 0);

  const count = await pool.query('SELECT count(*) FROM raw_items WHERE source_id = $1', [sourceId]);
  assert.equal(count.rows[0].count, '1');

  await pool.query('DELETE FROM raw_items WHERE source_id = $1', [sourceId]);
  await pool.query('DELETE FROM sources WHERE id = $1', [sourceId]);
});

test('advisory lock prevents a second concurrent acquire for the same key', async () => {
  const key = 424242;
  const clientA = await pool.connect();
  const clientB = await pool.connect();

  try {
    const lockA = await clientA.query('SELECT pg_try_advisory_lock($1) AS locked', [key]);
    assert.equal(lockA.rows[0].locked, true);

    const lockB = await clientB.query('SELECT pg_try_advisory_lock($1) AS locked', [key]);
    assert.equal(lockB.rows[0].locked, false);

    await clientA.query('SELECT pg_advisory_unlock($1)', [key]);

    const lockB2 = await clientB.query('SELECT pg_try_advisory_lock($1) AS locked', [key]);
    assert.equal(lockB2.rows[0].locked, true);
    await clientB.query('SELECT pg_advisory_unlock($1)', [key]);
  } finally {
    clientA.release();
    clientB.release();
  }
});

test.after(async () => {
  await pool.end();
});
