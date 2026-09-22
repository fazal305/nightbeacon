import { Router } from 'express';
import { pool } from '../db/pool.js';

export const sourcesRouter = Router();

sourcesRouter.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT s.*,
            COUNT(ri.id)::int AS item_count,
            COUNT(ri.id) FILTER (WHERE ri.status = 'ready')::int AS ready_count
     FROM sources s
     LEFT JOIN raw_items ri ON ri.source_id = s.id
     GROUP BY s.id
     ORDER BY s.first_tracked_at DESC`
  );
  res.json(rows);
});

sourcesRouter.get('/:id', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT s.*,
            COUNT(ri.id)::int AS item_count,
            COUNT(ri.id) FILTER (WHERE ri.status = 'ready')::int AS ready_count
     FROM sources s
     LEFT JOIN raw_items ri ON ri.source_id = s.id
     WHERE s.id = $1
     GROUP BY s.id`,
    [req.params.id]
  );
  if (rows.length === 0) {
    return res.status(404).json({ error: 'Source not found' });
  }

  const recentItems = await pool.query(
    `SELECT id, telegram_message_id, telegram_date, raw_text, status, category, priority
     FROM raw_items
     WHERE source_id = $1
     ORDER BY telegram_date DESC, id DESC
     LIMIT 10`,
    [req.params.id]
  );

  res.json({ ...rows[0], recent_items: recentItems.rows });
});
