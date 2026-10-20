import { Router } from 'express';
import { pool } from '../db/pool.js';

export const subsystemsRouter = Router();

const KNOWN_SUBSYSTEMS = ['ingestion', 'deduplication', 'translation', 'classification'];

// Current health = the latest row per subsystem. A subsystem with no rows at
// all (never run) is reported explicitly rather than omitted, so the UI
// never has to guess why something is missing.
subsystemsRouter.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (subsystem_name) *
     FROM subsystem_status
     WHERE subsystem_name = ANY($1)
     ORDER BY subsystem_name, started_at DESC`,
    [KNOWN_SUBSYSTEMS]
  );

  const byName = Object.fromEntries(rows.map((r) => [r.subsystem_name, r]));

  const result = KNOWN_SUBSYSTEMS.map(
    (name) =>
      byName[name] || {
        subsystem_name: name,
        status: 'never_run',
        started_at: null,
        completed_at: null,
        duration_ms: null,
        processed_count: 0,
        error_count: 0,
        last_error: null,
      }
  );

  res.json(result);
});
