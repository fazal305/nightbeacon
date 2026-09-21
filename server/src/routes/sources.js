import { Router } from 'express';
import { pool } from '../db/pool.js';

export const sourcesRouter = Router();

sourcesRouter.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT s.*, COUNT(ri.id)::int AS item_count
     FROM sources s
     LEFT JOIN raw_items ri ON ri.source_id = s.id
     GROUP BY s.id
     ORDER BY s.display_name`
  );
  res.json(rows);
});

sourcesRouter.get('/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM sources WHERE id = $1', [req.params.id]);
  if (rows.length === 0) {
    return res.status(404).json({ error: 'Source not found' });
  }
  res.json(rows[0]);
});
