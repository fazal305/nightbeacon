import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';

export const itemsRouter = Router();

const querySchema = z.object({
  source: z.string().uuid().optional(),
  status: z.string().optional(),
  category: z.string().optional(),
  priority: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  // Opaque keyset cursor: "<telegram_date ISO>_<id>". Sorting is by
  // telegram_date (when the post actually happened on Telegram), not id
  // (insertion/collection order) — with 400+ sources polling on staggered
  // cycles plus a historical backfill, those two orderings diverge a lot.
  // `id` breaks ties when two posts share the same telegram_date.
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

function parseCursor(cursor) {
  const sepIndex = cursor.lastIndexOf('_');
  if (sepIndex === -1) return null;
  const dateStr = cursor.slice(0, sepIndex);
  const idStr = cursor.slice(sepIndex + 1);
  const id = Number(idStr);
  const date = new Date(dateStr);
  if (Number.isNaN(id) || Number.isNaN(date.getTime())) return null;
  return { date, id };
}

itemsRouter.get('/', async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query parameters' });
  }
  const { source, status, category, priority, from, to, cursor, limit = 50 } = parsed.data;

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
  if (category) {
    params.push(category);
    conditions.push(`ri.category = $${params.length}`);
  }
  if (priority) {
    params.push(priority);
    conditions.push(`ri.priority = $${params.length}`);
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
    const parsedCursor = parseCursor(cursor);
    if (!parsedCursor) {
      return res.status(400).json({ error: 'Invalid cursor' });
    }
    params.push(parsedCursor.date, parsedCursor.id);
    conditions.push(`(ri.telegram_date, ri.id) < ($${params.length - 1}, $${params.length})`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit);

  const { rows } = await pool.query(
    `SELECT ri.id, ri.telegram_message_id, ri.telegram_date, ri.collected_at,
            ri.raw_text, ri.has_media, ri.status, ri.category, ri.priority,
            s.id AS source_id, s.channel_username, s.display_name,
            t.translated_text, t.source_language, t.status AS translation_status
     FROM raw_items ri
     JOIN sources s ON s.id = ri.source_id
     LEFT JOIN translations t ON t.raw_item_id = ri.id
     ${where}
     ORDER BY ri.telegram_date DESC, ri.id DESC
     LIMIT $${params.length}`,
    params
  );

  const last = rows[rows.length - 1];
  const nextCursor = rows.length === limit ? `${last.telegram_date.toISOString()}_${last.id}` : null;
  res.json({ items: rows, nextCursor });
});

itemsRouter.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid item id' });
  }

  const { rows } = await pool.query(
    `SELECT ri.*, s.channel_username, s.display_name,
            t.translated_text, t.source_language, t.target_language, t.model AS translation_model,
            t.status AS translation_status, t.error_message AS translation_error, t.updated_at AS translated_at
     FROM raw_items ri
     JOIN sources s ON s.id = ri.source_id
     LEFT JOIN translations t ON t.raw_item_id = ri.id
     WHERE ri.id = $1`,
    [id]
  );

  if (rows.length === 0) {
    return res.status(404).json({ error: 'Item not found' });
  }

  const tags = await pool.query(
    `SELECT tg.name, it.source, it.confidence
     FROM item_tags it
     JOIN tags tg ON tg.id = it.tag_id
     WHERE it.raw_item_id = $1
     ORDER BY tg.name`,
    [id]
  );

  res.json({ ...rows[0], tags: tags.rows });
});
