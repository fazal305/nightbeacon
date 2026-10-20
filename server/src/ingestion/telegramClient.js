import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { UpdateConnectionState } from 'telegram/network/index.js';
import { returnBigInt } from 'telegram/Helpers.js';
import { pool } from '../db/pool.js';
import { buildProxyConfig, describeProxy } from './proxyConfig.js';
import { RateGate } from '../pipeline/rateGate.js';

let client = null;
let connecting = null;

// Process-wide Telegram health counters, exposed by GET /api/pipeline/metrics.
export const telegramStats = {
  connected: false,
  connects: 0,
  reconnects: 0,
  disconnects: 0,
  lastStateChangeAt: null,
  resolves: 0,
  floodWaits: 0,
  lastFloodWait: null, // { method, seconds, at }
  liveMessages: 0,
  liveInserted: 0,
};

// Every ingestion-side MTProto request (history fetches, backfill) passes
// through one gate: a minimum spacing between requests (the old
// POLL_INTER_SOURCE_DELAY_MS, same default) and a global pause while
// Telegram has the account in a flood-wait — flood-waits are account-wide,
// so continuing to hit other channels only extends them.
export const requestGate = new RateGate(Number(process.env.POLL_INTER_SOURCE_DELAY_MS || 750));

// contacts.ResolveUsername has a much stricter limit than history fetches
// (it is what flood-waited the account for ~18h — see docs/POLLING.md), so
// it gets its own, slower gate on top. With access hashes now persisted it
// only runs once per source, ever.
export const resolveGate = new RateGate(Number(process.env.TELEGRAM_RESOLVE_INTERVAL_MS || 15000));

// A single long-lived MTProto client for the whole process — GramJS expects
// one persistent connection, not one per request/poll.
//
// Concurrent callers share one in-flight connect, and a failed connect is not
// cached: previously the client was stored before connect() resolved, so one
// failed connect (common on a blocked network) left every later poll using a
// disconnected client until the process was restarted.
export async function getTelegramClient() {
  if (client) return client;
  if (connecting) return connecting;

  connecting = (async () => {
    const apiId = Number(process.env.TELEGRAM_API_ID);
    const apiHash = process.env.TELEGRAM_API_HASH;
    const sessionString = process.env.TELEGRAM_SESSION;

    if (!apiId || !apiHash || !sessionString) {
      throw new Error(
        'Telegram credentials missing. Run "npm run telegram:login" once to generate TELEGRAM_SESSION, ' +
          'and set TELEGRAM_API_ID / TELEGRAM_API_HASH from https://my.telegram.org.'
      );
    }

    const proxy = buildProxyConfig();
    const c = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
      connectionRetries: Number(process.env.TELEGRAM_CONNECTION_RETRIES || 10),
      retryDelay: 2000,
      autoReconnect: true,
      // GramJS silently sleeps (blocking the caller) on flood-waits up to this
      // many seconds. Kept short so longer waits surface as errors and pause
      // the shared requestGate instead of stalling one request invisibly.
      floodSleepThreshold: Number(process.env.TELEGRAM_FLOOD_SLEEP_THRESHOLD || 10),
      proxy,
    });
    if (proxy) console.log(`[telegram] connecting via ${describeProxy(proxy)}`);

    c.addEventHandler((update) => {
      if (!(update instanceof UpdateConnectionState)) return;
      telegramStats.lastStateChangeAt = new Date().toISOString();
      if (update.state === UpdateConnectionState.connected) {
        if (telegramStats.connects > 0) telegramStats.reconnects++;
        telegramStats.connects++;
        telegramStats.connected = true;
      } else {
        if (telegramStats.connected) telegramStats.disconnects++;
        telegramStats.connected = false;
      }
    });

    await c.connect();
    telegramStats.connected = true;
    client = c;
    return c;
  })();

  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

export function floodWaitSeconds(err) {
  // GramJS's FloodWaitError carries `seconds`; the message form is matched
  // too in case an error was re-wrapped on the way up.
  if (typeof err?.seconds === 'number') return err.seconds;
  const m = /wait of (\d+) seconds/i.exec(err?.message || '');
  return m ? Number(m[1]) : null;
}

// Records a flood-wait and pauses all ingestion requests for its duration.
export function handleFloodWait(err, method) {
  const seconds = floodWaitSeconds(err);
  if (seconds == null) return null;
  telegramStats.floodWaits++;
  telegramStats.lastFloodWait = { method, seconds, at: new Date().toISOString() };
  const gate = method === 'resolve' ? resolveGate : requestGate;
  gate.pauseFor(seconds * 1000);
  console.warn(`[telegram] flood-wait ${seconds}s on ${method} — pausing ${method === 'resolve' ? 'username resolution' : 'ingestion requests'}`);
  return seconds;
}

// Errors meaning a cached access hash is no longer usable — clear it so the
// next poll resolves the username again (once).
const STALE_PEER_RE = /CHANNEL_INVALID|CHANNEL_PRIVATE|PEER_ID_INVALID|CHANNEL_PUBLIC_GROUP_NA/;

export function isStalePeerError(err) {
  return STALE_PEER_RE.test(err?.errorMessage || err?.message || '');
}

// Returns an InputPeer for a source, resolving its username via the network
// at most once: the channel id + access hash are persisted on the source row,
// so restarts never re-run contacts.ResolveUsername for hundreds of channels
// (GramJS's StringSession doesn't persist its entity cache).
export async function resolveSourcePeer(tgClient, source) {
  if (source.telegram_channel_id != null && source.telegram_access_hash != null) {
    return new Api.InputPeerChannel({
      channelId: returnBigInt(String(source.telegram_channel_id)),
      accessHash: returnBigInt(String(source.telegram_access_hash)),
    });
  }

  await resolveGate.wait();
  telegramStats.resolves++;
  let peer;
  try {
    peer = await tgClient.getInputEntity(source.channel_username);
  } catch (err) {
    handleFloodWait(err, 'resolve');
    throw err;
  }

  if (peer instanceof Api.InputPeerChannel) {
    await pool.query(
      `UPDATE sources SET telegram_channel_id = $2, telegram_access_hash = $3, updated_at = now() WHERE id = $1`,
      [source.id, peer.channelId.toString(), peer.accessHash.toString()]
    );
    source.telegram_channel_id = peer.channelId.toString();
    source.telegram_access_hash = peer.accessHash.toString();
  }
  return peer;
}

export async function forgetSourcePeer(sourceId) {
  await pool.query(`UPDATE sources SET telegram_access_hash = NULL, updated_at = now() WHERE id = $1`, [sourceId]);
}
