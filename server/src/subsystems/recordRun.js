import { pool } from '../db/pool.js';

// Every pipeline stage runs through this so subsystem_status reflects what
// actually happened, not a hardcoded UI string. `fn` returns an array of
// per-item results (each with an `outcome`, and optionally `error`); a
// stage-level throw (e.g. the DB itself is unavailable) is also caught here
// and recorded as a full failure rather than crashing the cron tick.
export async function recordRun(subsystemName, fn) {
  const startedAt = new Date();
  let results = [];
  let stageError = null;

  try {
    results = await fn();
  } catch (err) {
    stageError = err;
  }

  const completedAt = new Date();
  const durationMs = completedAt.getTime() - startedAt.getTime();

  const processedCount = results.length;
  const errorCount = results.filter((r) => r.outcome === 'failed').length;

  let status;
  let lastError = null;

  if (stageError) {
    status = 'failed';
    lastError = stageError.message;
  } else if (processedCount === 0) {
    status = 'success';
  } else if (errorCount === processedCount) {
    status = 'failed';
    lastError = results.find((r) => r.error)?.error ?? null;
  } else if (errorCount > 0) {
    status = 'degraded';
    lastError = results.find((r) => r.error)?.error ?? null;
  } else {
    status = 'success';
  }

  await pool.query(
    `INSERT INTO subsystem_status
       (subsystem_name, status, started_at, completed_at, duration_ms, processed_count, error_count, last_error, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      subsystemName,
      status,
      startedAt,
      completedAt,
      durationMs,
      processedCount,
      errorCount,
      lastError,
      JSON.stringify({ outcomes: summarizeOutcomes(results) }),
    ]
  );

  if (stageError) throw stageError;
  return results;
}

function summarizeOutcomes(results) {
  const summary = {};
  for (const r of results) {
    summary[r.outcome] = (summary[r.outcome] || 0) + 1;
  }
  return summary;
}
