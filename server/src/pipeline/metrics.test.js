import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { pool } from '../db/pool.js';
import { pipelineRouter } from '../routes/pipeline.js';

after(async () => {
  await pool.end();
});

test('GET /api/pipeline/metrics reports queues, per-stage latency and ingestion health', async () => {
  const app = express();
  app.use('/api/pipeline', pipelineRouter);
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/pipeline/metrics`);
    assert.equal(res.status, 200);
    const body = await res.json();
    for (const q of ['deduplication', 'translation', 'classification']) {
      assert.equal(typeof body.queues[q].depth, 'number');
    }
    for (const stage of ['telegram_to_observed', 'observed_to_committed', 'committed_to_deduped', 'deduped_to_translated', 'translated_to_ready', 'end_to_end']) {
      assert.ok(stage in body.latencySeconds, stage);
    }
    assert.equal(typeof body.ingestion.telegram.reconnects, 'number');
    assert.equal(typeof body.ingestion.sources.enabled, 'number');
    assert.ok('ingested' in body.throughputPerMinute);
  } finally {
    server.close();
  }
});
