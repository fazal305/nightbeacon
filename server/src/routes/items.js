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
  // collapse=1 hides posts dedup attached to an existing story as plain
  // duplicates — the story's first report is shown once, with a count of
  // corroborating sources. Updates (duplicates carrying new facts) and
  // posts still awaiting dedup are always shown.
  collapse: z.enum(['0', '1', 'true', 'false']).optional(),
});

// Link back to the original post, for provenance.
const MESSAGE_URL_SQL = `'https://t.me/' || s.channel_username || '/' || ri.telegram_message_id AS message_url`;

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
  const { source, status, category, priority, from, to, cursor, collapse, limit = 50 } = parsed.data;

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
  if (collapse === '1' || collapse === 'true') {
    conditions.push(`ri.dedup_status <> 'duplicate'`);
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
    `SELECT ri.id, ri.telegram_message_id, ri.telegram_date, ri.observed_at, ri.collected_at,
            ri.raw_text, ri.has_media, ri.status, ri.category, ri.priority,
            ri.dedup_status, ri.story_id, ri.ingest_path,
            st.item_count AS story_item_count, st.update_count AS story_update_count,
            s.id AS source_id, s.channel_username, s.display_name, ${MESSAGE_URL_SQL},
            t.translated_text, t.source_language, t.status AS translation_status
     FROM raw_items ri
     JOIN sources s ON s.id = ri.source_id
     LEFT JOIN stories st ON st.id = ri.story_id
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
    `SELECT ri.*, s.channel_username, s.display_name, ${MESSAGE_URL_SQL},
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

  // Every report attached to the same story, with its own provenance — so
  // the analyst can see which channels carried it, when, and which reports
  // added new information (dedup_status 'update').
  let story = null;
  if (rows[0].story_id) {
    const storyRows = await pool.query(
      `SELECT st.id, st.canonical_item_id, st.item_count, st.update_count, st.first_seen_at, st.last_seen_at
       FROM stories st WHERE st.id = $1`,
      [rows[0].story_id]
    );
    const reports = await pool.query(
      `SELECT ri.id, ri.telegram_date, ri.dedup_status, ri.dedup_method, ri.dedup_score, ri.status,
              s.channel_username, s.display_name, ${MESSAGE_URL_SQL}
       FROM raw_items ri JOIN sources s ON s.id = ri.source_id
       WHERE ri.story_id = $1
       ORDER BY ri.telegram_date
       LIMIT 200`,
      [rows[0].story_id]
    );
    story = storyRows.rows[0] ? { ...storyRows.rows[0], reports: reports.rows } : null;
  }

  res.json({ ...rows[0], tags: tags.rows, story });
});
