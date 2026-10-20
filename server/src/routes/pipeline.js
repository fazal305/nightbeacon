import { Router } from 'express';
import { pool } from '../db/pool.js';
import { telegramStats, requestGate, resolveGate } from '../ingestion/telegramClient.js';
import { schedulerStats } from '../ingestion/scheduler.js';
import { workerStates } from '../pipeline/workers.js';
import { embeddingConfig } from '../dedup/embeddings.js';

export const pipelineRouter = Router();

// Where does a post's time go? Each stage boundary has its own timestamp:
//   telegram_date  — published on Telegram
//   observed_at    — first seen by the poller / live handler
//   collected_at   — committed to raw_items
//   dedup_at       — duplicate check finished
//   translated_at  — translation (or English skip) finished
//   ready_at       — classification finished
// so a backlog can be attributed to the stage that actually causes it.
// (Dashboard display adds at most the feed's refetch interval on top.)
const LATENCY_STAGES = [
  ['telegram_to_observed', 'observed_at - telegram_date'],
  ['observed_to_committed', 'collected_at - observed_at'],
  ['committed_to_deduped', 'dedup_at - collected_at'],
  ['deduped_to_translated', 'translated_at - dedup_at'],
  ['translated_to_ready', 'ready_at - translated_at'],
  ['end_to_end', 'ready_at - telegram_date'],
];

function queueQuery(where) {
  return pool.query(
    `SELECT count(*)::int AS depth, min(collected_at) AS oldest_collected_at
     FROM raw_items WHERE ${where}`
  );
}

pipelineRouter.get('/metrics', async (req, res) => {
  const latencySelect = LATENCY_STAGES.map(
    ([name, expr]) => `
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM ${expr})) AS ${name}_p50,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM ${expr})) AS ${name}_p95`
  ).join(',');

  const [dedupQ, translateQ, classifyQ, failed, latency, throughput, dedupMix, sources, gaps] = await Promise.all([
    queueQuery(`dedup_status = 'pending'`),
    queueQuery(`status IN ('new', 'translating') AND dedup_status IN ('unique', 'update', 'legacy')`),
    queueQuery(`status IN ('translated', 'tagging')`),
    pool.query(
      `SELECT count(*) FILTER (WHERE status = 'failed_translation')::int AS failed_translation,
              count(*) FILTER (WHERE status = 'failed_tagging')::int AS failed_tagging
       FROM raw_items WHERE status IN ('failed_translation', 'failed_tagging')`
    ),
    // Live posts only: backfilled history is old by definition and would
    // drown out the numbers that matter.
    pool.query(
      `SELECT count(*)::int AS sample_size, ${latencySelect}
       FROM raw_items
       WHERE collected_at >= now() - interval '60 minutes' AND ingest_path <> 'backfill'`
    ),
    pool.query(
      `SELECT count(*) FILTER (WHERE collected_at >= now() - interval '15 minutes')::int AS ingested,
              count(*) FILTER (WHERE dedup_at >= now() - interval '15 minutes')::int AS deduped,
              count(*) FILTER (WHERE translated_at >= now() - interval '15 minutes')::int AS translated,
              count(*) FILTER (WHERE ready_at >= now() - interval '15 minutes')::int AS ready
       FROM raw_items WHERE collected_at >= now() - interval '24 hours'`
    ),
    pool.query(
      `SELECT dedup_status, count(*)::int AS count
       FROM raw_items WHERE dedup_at >= now() - interval '60 minutes'
       GROUP BY dedup_status`
    ),
    pool.query(
      `SELECT count(*)::int AS enabled,
              count(*) FILTER (WHERE next_poll_at IS NULL OR next_poll_at <= now())::int AS due,
              extract(epoch FROM now() - min(next_poll_at) FILTER (WHERE next_poll_at <= now())) AS max_overdue_seconds,
              max(last_success_at) AS last_successful_fetch_at,
              count(*) FILTER (WHERE poll_error_count > 0)::int AS erroring,
              count(*) FILTER (WHERE telegram_access_hash IS NULL)::int AS unresolved
       FROM sources WHERE enabled`
    ),
    pool.query(
      `SELECT count(*)::int AS open, min(created_at) AS oldest_open_at
       FROM ingestion_gaps WHERE completed_at IS NULL`
    ),
  ]);

  const lat = latency.rows[0];
  const latencySeconds = Object.fromEntries(
    LATENCY_STAGES.map(([name]) => [
      name,
      { p50: lat[`${name}_p50`] == null ? null : Number(lat[`${name}_p50`]), p95: lat[`${name}_p95`] == null ? null : Number(lat[`${name}_p95`]) },
    ])
  );

  const perMinute = Object.fromEntries(
    Object.entries(throughput.rows[0]).map(([k, v]) => [k, Math.round((v / 15) * 10) / 10])
  );

  const src = sources.rows[0];
  res.json({
    generatedAt: new Date().toISOString(),
    queues: {
      deduplication: dedupQ.rows[0],
      translation: translateQ.rows[0],
      classification: classifyQ.rows[0],
      failed: failed.rows[0],
    },
    throughputPerMinute: perMinute,
    latencySeconds: { sampleSize: lat.sample_size, ...latencySeconds },
    dedupLastHour: Object.fromEntries(dedupMix.rows.map((r) => [r.dedup_status, r.count])),
    ingestion: {
      sources: {
        ...src,
        max_overdue_seconds: src.max_overdue_seconds == null ? 0 : Math.round(Number(src.max_overdue_seconds)),
      },
      gaps: gaps.rows[0],
      scheduler: schedulerStats,
      telegram: {
        ...telegramStats,
        floodWaitActiveUntil: requestGate.isPaused() ? new Date(requestGate.pausedUntil).toISOString() : null,
        resolveFloodWaitActiveUntil: resolveGate.isPaused() ? new Date(resolveGate.pausedUntil).toISOString() : null,
      },
    },
    workers: workerStates(),
    embeddings: (({ provider, enabled, model }) => ({ provider, enabled, model }))(embeddingConfig()),
  });
});
