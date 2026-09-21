import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../db/pool.js';
import { recordRun } from './recordRun.js';

async function latestRun(name) {
  const { rows } = await pool.query(
    'SELECT * FROM subsystem_status WHERE subsystem_name = $1 ORDER BY id DESC LIMIT 1',
    [name]
  );
  return rows[0];
}

test('recordRun: all-success results record status=success', async () => {
  await recordRun('ingestion', async () => [{ id: 1, outcome: 'success' }]);
  const run = await latestRun('ingestion');
  assert.equal(run.status, 'success');
  assert.equal(run.processed_count, 1);
  assert.equal(run.error_count, 0);
});

test('recordRun: mixed results record status=degraded', async () => {
  await recordRun('translation', async () => [
    { id: 1, outcome: 'translated' },
    { id: 2, outcome: 'failed', error: 'boom' },
  ]);
  const run = await latestRun('translation');
  assert.equal(run.status, 'degraded');
  assert.equal(run.processed_count, 2);
  assert.equal(run.error_count, 1);
  assert.equal(run.last_error, 'boom');
});

test('recordRun: a thrown error records status=failed without crashing the caller silently', async () => {
  await assert.rejects(
    recordRun('classification', async () => {
      throw new Error('stage exploded');
    })
  );
  const run = await latestRun('classification');
  assert.equal(run.status, 'failed');
  assert.equal(run.last_error, 'stage exploded');
});

test.after(async () => {
  await pool.query(
    `DELETE FROM subsystem_status WHERE last_error IN ('boom', 'stage exploded') OR (subsystem_name = 'ingestion' AND processed_count = 1 AND error_count = 0)`
  );
  await pool.end();
});
