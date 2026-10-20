import { NewMessage } from 'telegram/events/index.js';
import { pool } from '../db/pool.js';
import { telegramStats } from './telegramClient.js';
import { insertMessages } from './pollSource.js';

// Event-driven ingestion. Telegram only pushes new-message updates for
// channels the account is a member of; the monitoring account deliberately
// doesn't join most sources (docs/SECURITY.md), so for those polling remains
// the only mechanism. For any source it HAS joined, this persists posts within
// a second or so instead of waiting for its next poll.
//
// Polling stays the source of truth for checkpoints: a pushed message never
// advances last_seen_id (if pushes were missed in between, advancing it would
// hide them from the next poll). The poll simply re-sees pushed messages and
// they no-op on the unique constraint.

const REFRESH_MS = 60_000;
let sourceByChannelId = new Map();
let lastRefresh = 0;

async function refreshSourceMap() {
  const { rows } = await pool.query(
    `SELECT id, telegram_channel_id FROM sources WHERE enabled AND telegram_channel_id IS NOT NULL`
  );
  sourceByChannelId = new Map(rows.map((r) => [String(r.telegram_channel_id), r.id]));
  lastRefresh = Date.now();
}

export async function handleNewMessage(message) {
  const peer = message?.peerId;
  if (!peer || peer.className !== 'PeerChannel') return 0;
  if (Date.now() - lastRefresh > REFRESH_MS) await refreshSourceMap();
  const sourceId = sourceByChannelId.get(peer.channelId.toString());
  if (!sourceId) return 0;

  telegramStats.liveMessages++;
  const inserted = await insertMessages(pool, sourceId, [message], {
    observedAt: new Date(),
    ingestPath: 'live',
  });
  telegramStats.liveInserted += inserted;
  return inserted;
}

export async function startLiveUpdates(client) {
  if ((process.env.TELEGRAM_LIVE_UPDATES || 'true').toLowerCase() === 'false') return;
  await refreshSourceMap();
  client.addEventHandler(async (event) => {
    try {
      await handleNewMessage(event.message);
    } catch (err) {
      console.error('[ingestion] live update insert failed:', err.message);
    }
  }, new NewMessage({}));
  console.log(`[ingestion] live updates enabled (${sourceByChannelId.size} source(s) with known channel ids)`);
}

export function _setSourceMapForTests(map) {
  sourceByChannelId = map;
  lastRefresh = Date.now();
}
