import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Api } from 'telegram';
import { pool } from '../db/pool.js';

// No artificial spacing between fake Telegram requests in tests. Set before
// the dynamic imports below so the shared request gate picks it up.
process.env.POLL_INTER_SOURCE_DELAY_MS = '0';
process.env.TELEGRAM_RESOLVE_INTERVAL_MS = '0';
process.env.TELEGRAM_REQUEST_TIMEOUT_MS = '300';
const { pollSource, nextIntervalSeconds, POLL_BATCH_LIMIT } = await import('./pollSource.js');
const { runBackfillStep } = await import('./backfill.js');
const { requestGate } = await import('./telegramClient.js');
const { handleNewMessage, _setSourceMapForTests } = await import('./liveUpdates.js');

// Mirrors GramJS getMessages(peer, { minId, maxId, limit }) for a channel:
// newest-first, ids strictly between minId and maxId (verified against
// telegram@2.26's _MessagesIter).
function fakeTelegram(channelMessages, { onResolve, fail } = {}) {
  return {
    calls: [],
    async getMessages(peer, { minId = 0, maxId = 0, limit }) {
      this.calls.push({ peer, minId, maxId, limit });
      if (fail) throw fail;
      return channelMessages
        .filter((m) => m.id > minId && (!maxId || m.id < maxId))
        .sort((a, b) => b.id - a.id)
        .slice(0, limit);
    },
    async getInputEntity(username) {
      onResolve?.(username);
      return new Api.InputPeerChannel({ channelId: 777, accessHash: 123456789 });
    },
  };
}

function msgs(fromId, toId, { text = (id) => `post ${id}`, date = Math.floor(Date.now() / 1000) } = {}) {
  const out = [];
  for (let id = fromId; id <= toId; id++) out.push({ id, date, message: text(id), media: null });
  return out;
}

async function makeSource(over = {}) {
  const { rows } = await pool.query(
    `INSERT INTO sources (channel_username, display_name, telegram_channel_id, telegram_access_hash, last_seen_id)
     VALUES ($1, 'Test', $2, $3, $4) RETURNING *`,
    [`test_poll_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, over.channelId ?? 4242, over.accessHash ?? 99, over.lastSeen ?? 0]
  );
  return rows[0];
}

async function dropSource(id) {
  await pool.query('DELETE FROM raw_items WHERE source_id = $1', [id]);
  await pool.query('DELETE FROM sources WHERE id = $1', [id]);
}

// These exercise the actual dedup/locking guarantees against a real Postgres
// instance (DATABASE_URL from .env) — the correctness lives in the database,
// so the tests talk to the database, not a mock.

test('unique constraint prevents duplicate (source_id, telegram_message_id)', async () => {
  const src = await pool.query(
    `INSERT INTO sources (channel_username, display_name) VALUES ($1, $2) RETURNING id`,
    [`test_source_${Date.now()}`, 'Test Source']
  );
  const sourceId = src.rows[0].id;

  const first = await pool.query(
    `INSERT INTO raw_items (source_id, telegram_message_id, telegram_date, raw_text)
     VALUES ($1, 1, now(), 'a') ON CONFLICT (source_id, telegram_message_id) DO NOTHING RETURNING id`,
    [sourceId]
  );
  const second = await pool.query(
    `INSERT INTO raw_items (source_id, telegram_message_id, telegram_date, raw_text)
     VALUES ($1, 1, now(), 'b') ON CONFLICT (source_id, telegram_message_id) DO NOTHING RETURNING id`,
    [sourceId]
  );

  assert.equal(first.rowCount, 1);
  assert.equal(second.rowCount, 0);

  const count = await pool.query('SELECT count(*) FROM raw_items WHERE source_id = $1', [sourceId]);
  assert.equal(count.rows[0].count, '1');

  await pool.query('DELETE FROM raw_items WHERE source_id = $1', [sourceId]);
  await pool.query('DELETE FROM sources WHERE id = $1', [sourceId]);
});

test('advisory lock prevents a second concurrent acquire for the same key', async () => {
  const key = 424242;
  const clientA = await pool.connect();
  const clientB = await pool.connect();

  try {
    const lockA = await clientA.query('SELECT pg_try_advisory_lock($1) AS locked', [key]);
    assert.equal(lockA.rows[0].locked, true);

    const lockB = await clientB.query('SELECT pg_try_advisory_lock($1) AS locked', [key]);
    assert.equal(lockB.rows[0].locked, false);

    await clientA.query('SELECT pg_advisory_unlock($1)', [key]);

    const lockB2 = await clientB.query('SELECT pg_try_advisory_lock($1) AS locked', [key]);
    assert.equal(lockB2.rows[0].locked, true);
    await clientB.query('SELECT pg_advisory_unlock($1)', [key]);
  } finally {
    clientA.release();
    clientB.release();
  }
});

test('poll: uses the persisted access hash (no ResolveUsername), stores observed_at, schedules next poll', async () => {
  const source = await makeSource({ lastSeen: 10 });
  let resolves = 0;
  const tg = fakeTelegram(msgs(1, 15), { onResolve: () => resolves++ });

  const r = await pollSource(source, { tgClient: tg });
  assert.equal(resolves, 0);
  assert.equal(r.inserted, 5);
  assert.equal(r.gap, null);
  assert.ok(tg.calls[0].peer instanceof Api.InputPeerChannel);

  const rows = await pool.query(
    `SELECT count(*) FILTER (WHERE observed_at IS NOT NULL AND ingest_path = 'poll')::int AS n FROM raw_items WHERE source_id = $1`,
    [source.id]
  );
  assert.equal(rows.rows[0].n, 5);
  const after = await pool.query('SELECT last_seen_id, next_poll_at > now() AS scheduled FROM sources WHERE id = $1', [source.id]);
  assert.equal(Number(after.rows[0].last_seen_id), 15);
  assert.equal(after.rows[0].scheduled, true);
  await dropSource(source.id);
});

test('poll: resolves a username once and persists the access hash', async () => {
  const source = await makeSource({ channelId: null, accessHash: null });
  await pool.query('UPDATE sources SET telegram_channel_id = NULL, telegram_access_hash = NULL WHERE id = $1', [source.id]);
  source.telegram_channel_id = null;
  source.telegram_access_hash = null;
  let resolves = 0;
  const tg = fakeTelegram(msgs(1, 3), { onResolve: () => resolves++ });

  await pollSource(source, { tgClient: tg });
  const { rows } = await pool.query('SELECT * FROM sources WHERE id = $1', [source.id]);
  assert.equal(resolves, 1);
  assert.equal(String(rows[0].telegram_channel_id), '777');
  assert.equal(String(rows[0].telegram_access_hash), '123456789');

  await pollSource(rows[0], { tgClient: tg });
  assert.equal(resolves, 1, 'second poll reuses the stored hash');
  await dropSource(source.id);
});

test('poll: a burst larger than one batch takes the newest batch now and records the rest as a gap; backfill fills it', async () => {
  const total = POLL_BATCH_LIMIT + 37;
  const source = await makeSource({ lastSeen: 1000 });
  const tg = fakeTelegram(msgs(1001, 1000 + total));

  const r = await pollSource(source, { tgClient: tg });
  assert.equal(r.inserted, POLL_BATCH_LIMIT);
  assert.deepEqual(r.gap, { min: 1000, max: 1001 + 37 });

  // Previously these 37 messages were silently lost. Backfill recovers them.
  while (await runBackfillStep({ tgClient: tg })) {
    const open = await pool.query('SELECT count(*)::int AS n FROM ingestion_gaps WHERE source_id = $1 AND completed_at IS NULL', [source.id]);
    if (open.rows[0].n === 0) break;
  }
  const counts = await pool.query(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE ingest_path = 'backfill')::int AS backfilled
     FROM raw_items WHERE source_id = $1`,
    [source.id]
  );
  assert.equal(counts.rows[0].total, total);
  assert.equal(counts.rows[0].backfilled, 37);
  await pool.query('DELETE FROM ingestion_gaps WHERE source_id = $1', [source.id]);
  await dropSource(source.id);
});

test('poll: a flood-wait pauses all ingestion requests and reschedules the source without counting an error', async () => {
  const source = await makeSource({ lastSeen: 5 });
  const err = Object.assign(new Error('A wait of 120 seconds is required (caused by messages.GetHistory)'), { seconds: 120 });
  const tg = fakeTelegram([], { fail: err });

  await assert.rejects(pollSource(source, { tgClient: tg }));
  assert.equal(requestGate.isPaused(), true);
  const { rows } = await pool.query(
    `SELECT poll_error_count, extract(epoch FROM next_poll_at - now()) AS wait FROM sources WHERE id = $1`,
    [source.id]
  );
  assert.equal(rows[0].poll_error_count, 0);
  assert.ok(Number(rows[0].wait) > 100);
  requestGate.pausedUntil = 0;
  await dropSource(source.id);
});

test('poll: an ordinary failure backs the source off exponentially', async () => {
  const source = await makeSource({ lastSeen: 5 });
  const tg = fakeTelegram([], { fail: Object.assign(new Error('CHANNEL_INVALID'), { code: 400, errorMessage: 'CHANNEL_INVALID' }) });
  await assert.rejects(pollSource(source, { tgClient: tg }));
  const { rows } = await pool.query(
    'SELECT poll_error_count, last_error, telegram_access_hash FROM sources WHERE id = $1',
    [source.id]
  );
  assert.equal(rows[0].poll_error_count, 1);
  assert.equal(rows[0].telegram_access_hash, null, 'stale access hash is cleared so it gets re-resolved once');
  await dropSource(source.id);
});

test('poll: a connectivity failure (proxy/network down) pauses ingestion globally without penalising the channel', async () => {
  const source = await makeSource({ lastSeen: 5 });
  const tg = fakeTelegram([], { fail: new Error('Not connected') });
  await assert.rejects(pollSource(source, { tgClient: tg }));
  assert.equal(requestGate.isPaused(), true);
  const { rows } = await pool.query(
    'SELECT poll_error_count, next_poll_at <= now() AS still_due FROM sources WHERE id = $1',
    [source.id]
  );
  assert.equal(rows[0].poll_error_count, 0);
  assert.equal(rows[0].still_due, true);
  requestGate.pausedUntil = 0;
  await dropSource(source.id);
});

test('poll: a request that never returns (dead proxy) times out instead of freezing ingestion', async () => {
  const source = await makeSource({ lastSeen: 5 });
  const tg = { getMessages: () => new Promise(() => {}), getInputEntity: async () => null };
  await assert.rejects(pollSource(source, { tgClient: tg }), /did not answer/);
  const { rows } = await pool.query('SELECT poll_error_count FROM sources WHERE id = $1', [source.id]);
  assert.equal(rows[0].poll_error_count, 0, 'connectivity, not the channel\'s fault');
  requestGate.pausedUntil = 0;
  await dropSource(source.id);
});

test('adaptive interval: active channels are polled at the minimum interval, quiet ones back off', () => {
  assert.equal(nextIntervalSeconds(600, 3), 60);
  assert.equal(nextIntervalSeconds(60, 0), 90);
  assert.equal(nextIntervalSeconds(590, 0), 600);
});

test('live update: a pushed message for a known channel is persisted immediately and idempotently', async () => {
  const source = await makeSource({ channelId: 5151 });
  _setSourceMapForTests(new Map([['5151', source.id]]));
  const message = {
    id: 42,
    date: Math.floor(Date.now() / 1000),
    message: 'pushed post',
    media: null,
    peerId: new Api.PeerChannel({ channelId: 5151 }),
  };
  assert.equal(await handleNewMessage(message), 1);
  assert.equal(await handleNewMessage(message), 0);
  const { rows } = await pool.query('SELECT ingest_path FROM raw_items WHERE source_id = $1', [source.id]);
  assert.equal(rows[0].ingest_path, 'live');

  // Unknown channels are ignored.
  assert.equal(await handleNewMessage({ ...message, peerId: new Api.PeerChannel({ channelId: 1 }) }), 0);
  await dropSource(source.id);
});

test.after(async () => {
  await pool.end();
});
