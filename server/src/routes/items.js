import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';

export const itemsRouter = Router();

const querySchema = z.object({
  source: z.string().uuid().optional(),
  status: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

itemsRouter.get('/', async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query parameters' });
  }
  const { source, status, from, to, cursor, limit = 50 } = parsed.data;

  const conditions = [];
  const params = [];

  if (source) {
    params.push(source);
    conditions.push(`ri.source_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    conditions.push(`ri.status = $${params.length}`);
  }
  if (from) {
    params.push(from);
    conditions.push(`ri.telegram_date >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    conditions.push(`ri.telegram_date <= $${params.length}`);
  }
  if (cursor) {
    params.push(cursor);
    conditions.push(`ri.id < $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit);

  const { rows } = await pool.query(
    `SELECT ri.id, ri.telegram_message_id, ri.telegram_date, ri.collected_at,
            ri.raw_text, ri.has_media, ri.status,
            s.id AS source_id, s.channel_username, s.display_name
     FROM raw_items ri
     JOIN sources s ON s.id = ri.source_id
     ${where}
     ORDER BY ri.id DESC
     LIMIT $${params.length}`,
    params
  );

  const nextCursor = rows.length === limit ? rows[rows.length - 1].id : null;
  res.json({ items: rows, nextCursor });
});

itemsRouter.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid item id' });
  }

  const { rows } = await pool.query(
    `SELECT ri.*, s.channel_username, s.display_name
     FROM raw_items ri
     JOIN sources s ON s.id = ri.source_id
     WHERE ri.id = $1`,
    [id]
  );

  if (rows.length === 0) {
    return res.status(404).json({ error: 'Item not found' });
  }

  res.json(rows[0]);
});
