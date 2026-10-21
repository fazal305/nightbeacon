import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { publishConfig, channelByKey } from '../publishing/config.js';
import { publishGate, publishingStats } from '../publishing/sender.js';
import { loadBestMedia } from '../publishing/media.js';
import { describeError } from '../db/describeError.js';

export const publicationsRouter = Router();

// Express 4 doesn't catch rejected async handlers (an invalid channels file
// would otherwise crash the process); route them to the error handler.
const h = (fn) => (req, res, next) => fn(req, res).catch(next);

const STATUS_GROUPS = {
  drafts: ['requested', 'drafting', 'draft'],
  queue: ['approved', 'sending'],
  published: ['published', 'sent_manually'],
  closed: ['rejected', 'failed', 'expired'],
};

const SELECT_PUBLICATIONS = `
  SELECT p.*, ri.raw_text, ri.telegram_date, ri.category, ri.dedup_status, ri.has_media,
         ri.priority AS item_priority, s.channel_username, s.display_name,
         'https://t.me/' || s.channel_username || '/' || ri.telegram_message_id AS source_url,
         t.translated_text, st.item_count AS story_item_count
  FROM publications p
  LEFT JOIN raw_items ri ON ri.id = p.raw_item_id
  LEFT JOIN sources s ON s.id = ri.source_id
  LEFT JOIN translations t ON t.raw_item_id = ri.id
  LEFT JOIN stories st ON st.id = p.story_id`;

function withChannel(config) {
  return (row) => {
    const ch = channelByKey(config, row.channel_key);
    return { ...row, channel_name: ch?.name ?? row.channel_key, delivery: ch?.delivery ?? 'manual', channel_telegram: ch?.telegram ?? null };
  };
}

publicationsRouter.get('/', h(async (req, res) => {
  const parsed = z
    .object({
      group: z.enum(['drafts', 'queue', 'published', 'closed']).default('drafts'),
      channel: z.string().max(32).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    })
    .safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid query parameters' });
  const { group, channel, limit } = parsed.data;
  const params = [STATUS_GROUPS[group], limit];
  let where = 'p.status = ANY($1)';
  if (channel) {
    params.push(channel);
    where += ` AND p.channel_key = $${params.length}`;
  }
  const order = group === 'published' ? 'p.published_at DESC' : group === 'queue' ? 'p.approved_at' : 'p.created_at DESC';
  const { rows } = await pool.query(`${SELECT_PUBLICATIONS} WHERE ${where} ORDER BY ${order} LIMIT $2`, params);
  res.json({ items: rows.map(withChannel(publishConfig())) });
}));

// Every channel's version of one post (Content Inspector).
publicationsRouter.get('/item/:rawItemId', h(async (req, res) => {
  const rawItemId = Number(req.params.rawItemId);
  if (!Number.isInteger(rawItemId)) return res.status(400).json({ error: 'Invalid item id' });
  const { rows } = await pool.query(`${SELECT_PUBLICATIONS} WHERE p.raw_item_id = $1 ORDER BY p.channel_key`, [rawItemId]);
  res.json({ items: rows.map(withChannel(publishConfig())) });
}));

// The source post's photos/videos, for posting them by hand on manual
// channels: list, then download each (fetched once, cached for a day).
publicationsRouter.get('/item/:rawItemId/media', h(async (req, res) => {
  const rawItemId = Number(req.params.rawItemId);
  if (!Number.isInteger(rawItemId)) return res.status(400).json({ error: 'Invalid item id' });
  try {
    const { media } = await loadBestMedia(rawItemId, { officialUsernames: [...publishConfig().officialSources.keys()] });
    res.json({ items: media.map(({ kind, mime, name, size }, index) => ({ index, kind, mime, name, size })) });
  } catch (err) {
    res.status(502).json({ error: `Could not fetch the media from Telegram: ${describeError(err)}` });
  }
}));

publicationsRouter.get('/item/:rawItemId/media/:index', h(async (req, res) => {
  const rawItemId = Number(req.params.rawItemId);
  const index = Number(req.params.index);
  if (!Number.isInteger(rawItemId) || !Number.isInteger(index)) return res.status(400).json({ error: 'Invalid request' });
  const { media } = await loadBestMedia(rawItemId, { officialUsernames: [...publishConfig().officialSources.keys()] }).catch(() => ({ media: [] }));
  const m = media[index];
  if (!m) return res.status(404).json({ error: 'Not found' });
  res.type(m.mime);
  if (req.query.download) res.attachment(`nightbeacon-${rawItemId}-${m.name}`);
  res.sendFile(m.file);
}));

publicationsRouter.get('/status', h(async (req, res) => {
  let config;
  try {
    config = publishConfig();
  } catch (err) {
    return res.json({ configError: err.message, channels: [], counts: {} });
  }
  const { rows } = await pool.query(`SELECT status, count(*)::int AS n FROM publications GROUP BY status`);
  const gate = publishGate(config);
  res.json({
    mode: config.mode,
    channelsFile: config.channelsFile,
    channels: config.channels.map(({ key, name, telegram, delivery, draftPriorities, autoPriorities }) => ({
      key, name, telegram, delivery, draftPriorities, autoPriorities,
    })),
    botConfigured: Boolean(config.botToken),
    draftProvider: config.draftProvider,
    minIntervalSeconds: config.minIntervalSeconds,
    pausedUntil: gate.isPaused() ? new Date(gate.pausedUntil).toISOString() : null,
    lastSentAt: publishingStats.lastSentAt,
    lastError: publishingStats.lastError,
    counts: Object.fromEntries(rows.map((r) => [r.status, r.n])),
  });
}));

// Ask for drafts of a post — for one channel, or all configured channels.
// A version that was rejected/failed/expired before is requested again.
publicationsRouter.post('/', h(async (req, res) => {
  const parsed = z
    .object({ rawItemId: z.coerce.number().int().positive(), channelKey: z.string().max(32).optional() })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'rawItemId required' });
  const config = publishConfig();
  const keys = parsed.data.channelKey ? [parsed.data.channelKey] : config.channels.map((c) => c.key);
  if (keys.length === 0) return res.status(409).json({ error: 'No publishing channels are configured' });
  if (keys.some((k) => !channelByKey(config, k))) return res.status(400).json({ error: 'Unknown channel' });

  const exists = await pool.query('SELECT 1 FROM raw_items WHERE id = $1', [parsed.data.rawItemId]);
  if (exists.rows.length === 0) return res.status(404).json({ error: 'Item not found' });
  await pool.query(
    `INSERT INTO publications (raw_item_id, story_id, channel_key, priority, origin, status)
     SELECT ri.id, ri.story_id, k, ri.priority, 'manual', 'requested'
     FROM raw_items ri, unnest($2::text[]) AS k
     WHERE ri.id = $1
     ON CONFLICT (raw_item_id, channel_key) DO UPDATE
       SET status = 'requested', origin = 'manual', attempts = 0, last_error = NULL, updated_at = now()
       WHERE publications.status IN ('rejected', 'failed', 'expired')`,
    [parsed.data.rawItemId, keys]
  );
  const { rows } = await pool.query(
    `${SELECT_PUBLICATIONS} WHERE p.raw_item_id = $1 AND p.channel_key = ANY($2) ORDER BY p.channel_key`,
    [parsed.data.rawItemId, keys]
  );
  res.status(201).json({ items: rows.map(withChannel(config)) });
}));

const ACTIONS = {
  save: { from: ['draft', 'approved'], to: null },
  // Bot channels only: queue for the bot.
  approve: { from: ['draft', 'failed', 'expired'], to: 'approved', delivery: 'bot' },
  // Manual channels: you copied and posted it yourself.
  mark_sent: { from: ['draft', 'approved', 'failed', 'expired'], to: 'sent_manually', delivery: 'manual' },
  reject: { from: ['requested', 'draft', 'approved', 'failed', 'expired'], to: 'rejected' },
  redraft: { from: ['draft', 'rejected', 'failed', 'expired'], to: 'requested' },
};

publicationsRouter.patch('/:id', h(async (req, res) => {
  const id = Number(req.params.id);
  const parsed = z
    .object({
      action: z.enum(['save', 'approve', 'mark_sent', 'reject', 'redraft']),
      text: z.string().trim().min(1).max(4096).optional(),
    })
    .safeParse(req.body);
  if (!Number.isInteger(id) || !parsed.success) return res.status(400).json({ error: 'Invalid request' });
  const { action, text } = parsed.data;
  const rule = ACTIONS[action];

  const current = await pool.query('SELECT status, channel_key, kind FROM publications WHERE id = $1', [id]);
  if (current.rows.length === 0) return res.status(404).json({ error: 'Not found' });
  if (current.rows[0].kind === 'digest' && action === 'redraft') {
    return res.status(409).json({ error: 'A summary can\'t be redrafted — edit the text or reject it' });
  }
  const config = publishConfig();
  const delivery = channelByKey(config, current.rows[0].channel_key)?.delivery ?? 'manual';
  if (rule.delivery && rule.delivery !== delivery) {
    return res.status(409).json({
      error: delivery === 'manual' ? 'This channel is posted manually — copy the text and mark it as sent' : 'This channel is posted by the bot — approve it instead',
    });
  }

  const { rows } = await pool.query(
    `UPDATE publications
     SET final_text = COALESCE($3, final_text),
         status = COALESCE($4, status),
         origin = CASE WHEN $2 IN ('approve', 'mark_sent') THEN 'manual' ELSE origin END,
         approved_at = CASE WHEN $2 = 'approve' THEN now() ELSE approved_at END,
         published_at = CASE WHEN $2 = 'mark_sent' THEN now() ELSE published_at END,
         attempts = CASE WHEN $2 IN ('approve', 'redraft') THEN 0 ELSE attempts END,
         last_error = CASE WHEN $2 IN ('approve', 'redraft', 'mark_sent') THEN NULL ELSE last_error END,
         updated_at = now()
     WHERE id = $1 AND status = ANY($5)
     RETURNING *`,
    [id, action, text ?? null, rule.to, rule.from]
  );
  if (rows.length === 0) {
    return res.status(409).json({ error: `Cannot ${action.replace('_', ' ')} a publication that is ${current.rows[0].status}` });
  }
  res.json(withChannel(config)(rows[0]));
}));
