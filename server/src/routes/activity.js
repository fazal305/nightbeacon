import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';

export const activityRouter = Router();

const querySchema = z.object({
  subsystem: z.enum(['ingestion', 'translation', 'classification']).optional(),
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

activityRouter.get('/', async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query parameters' });
  }
  const { subsystem, cursor, limit = 50 } = parsed.data;

  const conditions = [];
  const params = [];
  if (subsystem) {
    params.push(subsystem);
    conditions.push(`subsystem_name = $${params.length}`);
  }
  if (cursor) {
    params.push(cursor);
    conditions.push(`id < $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit);

  const { rows } = await pool.query(
    `SELECT id, subsystem_name, status, started_at, completed_at, duration_ms,
            processed_count, error_count, last_error
     FROM subsystem_status
     ${where}
     ORDER BY id DESC
     LIMIT $${params.length}`,
    params
  );

  const nextCursor = rows.length === limit ? rows[rows.length - 1].id : null;
  res.json({ items: rows, nextCursor });
});
