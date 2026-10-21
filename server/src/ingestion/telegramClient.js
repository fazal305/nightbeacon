import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Logger, LogLevel } from 'telegram/extensions/Logger.js';
import { UpdateConnectionState } from 'telegram/network/index.js';
import { returnBigInt } from 'telegram/Helpers.js';
import { pool } from '../db/pool.js';
import { buildProxyCandidates, describeProxy, routeKey } from './proxyConfig.js';
import { rankRoutes } from './proxyPool.js';
import { applyProxyTransport } from './fakeTlsConnection.js';
import { RateGate } from '../pipeline/rateGate.js';

let client = null;
let connecting = null;

// Process-wide Telegram health counters, exposed by GET /api/pipeline/metrics.
export const telegramStats = {
  connected: false,
  activeRoute: null,
  failovers: 0,
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

const CONNECT_TIMEOUT_MS = Number(process.env.TELEGRAM_CONNECT_TIMEOUT_MS || 20000);
export const REQUEST_TIMEOUT_MS = Number(process.env.TELEGRAM_REQUEST_TIMEOUT_MS || 60000);
// Consecutive connectivity failures (no answer at all — not Telegram errors)
// before the current route is abandoned for the next configured one.
const FAILOVER_AFTER = Number(process.env.TELEGRAM_PROXY_FAILOVER_AFTER || 3);

export function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Telegram did not answer within ${ms / 1000}s (${what})`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Telegram RPC errors (AUTH_KEY_UNREGISTERED, FLOOD_WAIT, …) mean the route
// works — Telegram answered. Anything else means it didn't.
export function isTelegramAnswer(err) {
  return Boolean(err && (err.code || err.errorMessage || typeof err.seconds === 'number'));
}

let candidates = null;
let candidateIndex = 0;
let consecutiveConnectivityFailures = 0;
const clientHooks = [];

let activeProxy = null;

function routes() {
  if (!candidates) {
    candidates = rankRoutes(buildProxyCandidates());
    // Keep pointing at the route in use after the list is rebuilt.
    const i = activeProxy ? candidates.findIndex((p) => routeKey(p) === routeKey(activeProxy)) : -1;
    candidateIndex = i > -1 ? i : 0;
  }
  return candidates;
}

// Re-reads the configured + found proxy links, fastest first (after new
// links were found, or new speed measurements came in).
export function reloadRoutes() {
  candidates = null;
  return routes();
}

export function currentProxy() {
  return client ? activeProxy : null;
}

function activate(c, proxy, idx) {
  candidateIndex = idx;
  activeProxy = proxy;
  consecutiveConnectivityFailures = 0;
  client = c;
  trackConnectionState(c);
  telegramStats.connected = true;
  telegramStats.connects++;
  telegramStats.activeRoute = describeProxy(proxy);
  telegramStats.lastStateChangeAt = new Date().toISOString();
  for (const cb of clientHooks) {
    Promise.resolve(cb(c)).catch((err) => console.error('[telegram] client hook failed:', err.message));
  }
}

// Moves to a (faster) route without interrupting work: the new connection is
// proven first, and the old one is closed a little later so requests already
// running on it can finish. Returns false (and keeps the current route) if
// the new one doesn't work.
export async function switchRoute(proxy) {
  if (connecting || !client) return false;
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH;
  const sessionString = process.env.TELEGRAM_SESSION;
  const started = Date.now();
  let c;
  try {
    c = await connectRoute(proxy, { apiId, apiHash, sessionString, multipleRoutes: true });
  } catch (err) {
    console.warn(`[telegram] faster route ${describeProxy(proxy)} did not work (${err.message}) — staying`);
    return false;
  }
  if (!client || connecting) {
    c.destroy().catch(() => {});
    return false;
  }
  const old = client;
  const from = telegramStats.activeRoute;
  const list = routes();
  const idx = list.findIndex((p) => routeKey(p) === routeKey(proxy));
  activate(c, proxy, idx > -1 ? idx : candidateIndex);
  console.log(`[telegram] switched from ${from} to faster ${describeProxy(proxy)} (connected in ${Date.now() - started} ms)`);
  setTimeout(() => old.destroy().catch(() => {}), 30_000).unref?.();
  return true;
}

// Connects through one route and proves it with a real request: GramJS's
// connect() can give up without throwing, so "connected" alone isn't trusted.
async function defaultConnectRoute(proxy, { apiId, apiHash, sessionString, multipleRoutes }) {
  const c = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    // With several routes, fail fast and move on; with one, keep retrying it.
    connectionRetries: multipleRoutes ? 1 : Number(process.env.TELEGRAM_CONNECTION_RETRIES || 10),
    retryDelay: 2000,
    autoReconnect: true,
    // GramJS silently sleeps (blocking the caller) on flood-waits up to this
    // many seconds. Kept short so longer waits surface as errors and pause
    // the shared requestGate instead of stalling one request invisibly.
    floodSleepThreshold: Number(process.env.TELEGRAM_FLOOD_SLEEP_THRESHOLD || 10),
    proxy,
    // Route attempts are summarised by our own log lines; GramJS's per-attempt
    // stack traces would bury them when cycling through a long proxy list.
    baseLogger: new Logger(multipleRoutes ? LogLevel.ERROR : LogLevel.WARN),
  });
  applyProxyTransport(c, proxy);
  try {
    await withTimeout(c.connect(), CONNECT_TIMEOUT_MS, 'connect');
    try {
      await withTimeout(c.invoke(new Api.help.GetNearestDc()), CONNECT_TIMEOUT_MS, 'first request');
    } catch (err) {
      if (!isTelegramAnswer(err)) throw err;
    }
    return c;
  } catch (err) {
    c.destroy().catch(() => {});
    throw err;
  }
}

let connectRoute = defaultConnectRoute;

function trackConnectionState(c) {
  c.addEventHandler((update) => {
    if (!(update instanceof UpdateConnectionState) || c !== client) return;
    telegramStats.lastStateChangeAt = new Date().toISOString();
    if (update.state === UpdateConnectionState.connected) {
      telegramStats.reconnects++;
      telegramStats.connected = true;
    } else {
      if (telegramStats.connected) telegramStats.disconnects++;
      telegramStats.connected = false;
    }
  });
}

// Called with every client that becomes active (now, and after each
// failover), e.g. to register live-update handlers on it.
export function onTelegramClient(cb) {
  clientHooks.push(cb);
  if (client) Promise.resolve(cb(client)).catch((err) => console.error('[telegram] client hook failed:', err.message));
}

// A single long-lived MTProto client for the whole process — GramJS expects
// one persistent connection, not one per request/poll.
//
// Concurrent callers share one in-flight connect, and a failed connect is not
// cached (previously one failed connect left a dead client in place until a
// restart). Routes are tried in order starting from the last one that worked.
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

    const list = routes();
    const failures = [];
    for (let i = 0; i < list.length; i++) {
      const idx = (candidateIndex + i) % list.length;
      const proxy = list[idx];
      const label = describeProxy(proxy);
      const started = Date.now();
      try {
        const c = await connectRoute(proxy, { apiId, apiHash, sessionString, multipleRoutes: list.length > 1 });
        console.log(`[telegram] connected via ${label} in ${Date.now() - started} ms`);
        activate(c, proxy, idx);
        return c;
      } catch (err) {
        failures.push(`${label}: ${err.message}`);
        console.warn(`[telegram] route ${idx + 1}/${list.length} failed — ${label}: ${err.message}`);
      }
    }
    // Next attempt starts from the route after the first one tried.
    candidateIndex = (candidateIndex + 1) % list.length;
    throw new Error(`Could not reach Telegram via any of ${list.length} configured route(s). ${failures.slice(0, 3).join(' | ')}`);
  })();

  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

export function reportTelegramSuccess() {
  consecutiveConnectivityFailures = 0;
}

// Called when a request got no answer at all. After FAILOVER_AFTER in a row
// the current client is dropped; the next getTelegramClient() moves on to the
// next configured route (or reconnects, if there is only one).
export function reportConnectivityFailure() {
  consecutiveConnectivityFailures++;
  if (!client || consecutiveConnectivityFailures < FAILOVER_AFTER) return;
  const dead = client;
  const label = telegramStats.activeRoute;
  client = null;
  consecutiveConnectivityFailures = 0;
  candidateIndex = (candidateIndex + 1) % routes().length;
  telegramStats.failovers = (telegramStats.failovers || 0) + 1;
  telegramStats.connected = false;
  telegramStats.activeRoute = null;
  activeProxy = null;
  console.warn(`[telegram] ${FAILOVER_AFTER} requests in a row got no answer via ${label} — switching route`);
  dead.destroy().catch(() => {});
}

export function _setConnectRouteForTests(fn, routeList) {
  connectRoute = fn || defaultConnectRoute;
  candidates = routeList ?? null;
  candidateIndex = 0;
  activeProxy = null;
  consecutiveConnectivityFailures = 0;
  client = null;
  clientHooks.length = 0;
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

  // Never sleep through a ResolveUsername flood-wait here: polls run one at a
  // time, so waiting would freeze polling of every channel (this is what
  // stalled ingestion for hours after the access-hash column was added).
  // Throwing with `seconds` makes the caller reschedule just this channel
  // for when the wait ends, like any other flood-wait.
  if (resolveGate.isPaused()) {
    const seconds = Math.ceil((resolveGate.pausedUntil - Date.now()) / 1000);
    throw Object.assign(new Error(`username resolution paused by a Telegram flood-wait (${seconds}s left)`), { seconds });
  }
  await resolveGate.wait();
  telegramStats.resolves++;
  let peer;
  try {
    peer = await withTimeout(tgClient.getInputEntity(source.channel_username), REQUEST_TIMEOUT_MS, 'resolve username');
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
