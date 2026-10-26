import { pool } from '../db/pool.js';
import { getState, setState } from '../db/appState.js';

// Posting pace copied from another channel ("paceLike": "@Middle_East_Spectator"
// in channels.json): that channel's own posts per hour of the day (local
// time, PUBLISH_TIMEZONE), averaged over the last 14 days from what
// ingestion stored, become this channel's hourly limit for that hour —
// busy at its busy hours, quiet at night. maxPerHour stays the ceiling.
// Profiles are refreshed every few hours; without enough data the channel's
// own maxPerHour applies.
const REFRESH_MS = 3 * 3600_000;
const profiles = new Map(); // username -> { at, hours: [24], days, posts }

export function localHour(date, timeZone) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(date));
}

export async function paceProfile(username, timeZone, { days = 14 } = {}) {
  const key = String(username || '').replace(/^@/, '').toLowerCase();
  const cached = profiles.get(key);
  if (cached && Date.now() - cached.at < REFRESH_MS) return cached;
  // One stored row per post (media-only messages aren't stored; an album's
  // caption is one message).
  const { rows } = await pool.query(
    `SELECT extract(hour FROM ri.telegram_date AT TIME ZONE $2)::int AS h, count(*)::int AS n
     FROM raw_items ri JOIN sources s ON s.id = ri.source_id
     WHERE lower(s.channel_username) = $1 AND ri.telegram_date > now() - make_interval(days => $3)
     GROUP BY 1`,
    [key, timeZone, days]
  );
  const { rows: [span] } = await pool.query(
    `SELECT count(DISTINCT (ri.telegram_date AT TIME ZONE $2)::date)::int AS days, count(*)::int AS posts
     FROM raw_items ri JOIN sources s ON s.id = ri.source_id
     WHERE lower(s.channel_username) = $1 AND ri.telegram_date > now() - make_interval(days => $3)`,
    [key, timeZone, days]
  );
  const hours = Array(24).fill(0);
  for (const r of rows) hours[r.h] = r.n / Math.max(span.days, 1);
  const profile = { at: Date.now(), hours, days: span.days, posts: span.posts };
  profiles.set(key, profile);
  return profile;
}

// Pace from the channel's own stats ("pace": "stats"): its posts of the last
// 15 days (older than a day, so views have settled) are read with the
// monitoring account, and the average views per post at each hour of the day
// decide how much of the day's budget (postsPerHour × 24) that hour gets:
// more where posts are seen, fewer where they aren't. Hours with few posts
// lean towards the average, every hour keeps at least one post per two hours
// (or postsPerHour if lower), and maxPerHour stays the ceiling. Only the
// server process reads Telegram (every 6 hours); the hourly views are kept in
// app_state so the dashboard and check scripts see the same pace.
const STATS_REFRESH_MS = 6 * 3600_000;
const STATS_RELOAD_MS = 10 * 60_000;
const STATS_RETRY_MS = 30 * 60_000;
const MIN_POSTS = 20;
const SHRINK = 4; // posts' worth of pull towards the average at quiet hours
const MIN_RATE = 0.5;
const ownStats = new Map(); // channel key -> { stats, checkedAt, triedAt }

// Average views per post for each hour of the day: [{ n, views }] × 24.
export function hourlyViews(posts, timeZone) {
  const hours = Array.from({ length: 24 }, () => ({ n: 0, views: 0 }));
  for (const p of posts) {
    const h = hours[localHour(new Date(p.at), timeZone)];
    h.views = (h.views * h.n + p.views) / (h.n + 1);
    h.n++;
  }
  return hours.map((h) => ({ n: h.n, views: Math.round(h.views) }));
}

// Posts per hour for each hour of the day, or null without enough posts.
export function paceRates(hours, { target, max }) {
  const total = hours.reduce((s, h) => s + h.n, 0);
  if (total < MIN_POSTS) return null;
  const overall = hours.reduce((s, h) => s + h.n * h.views, 0) / total;
  if (!overall) return null;
  const score = hours.map((h) => (h.n * (h.views / overall) + SHRINK) / (h.n + SHRINK));
  const mean = score.reduce((s, x) => s + x, 0) / 24;
  const floor = Math.min(MIN_RATE, target);
  return score.map((x) => Math.round(Math.min(max, Math.max(floor, (target * x) / mean)) * 100) / 100);
}

async function fetchSettledPosts(channel, days = 15) {
  const [{ getTelegramClient, withTimeout, REQUEST_TIMEOUT_MS }, { findChannelPeer }] = await Promise.all([
    import('../ingestion/telegramClient.js'),
    import('./style.js'),
  ]);
  const client = await getTelegramClient();
  const peer = await findChannelPeer(client, channel.telegram);
  const read = (opts) => withTimeout(client.getMessages(peer, opts), REQUEST_TIMEOUT_MS, 'read channel');
  const dayOld = Date.now() - 86400_000;
  return (await readChannelPosts(read, days)).filter((p) => p.at < dayOld);
}

// A channel's posts of the last `days` days, one per album, newest first.
// `read` is client.getMessages bound to the channel.
export async function readChannelPosts(read, days) {
  const since = Date.now() - days * 86400_000;
  const posts = [];
  const albums = new Set();
  let offsetId = 0;
  for (let page = 0; page < 20; page++) {
    const batch = await read({ limit: 100, offsetId });
    if (!batch.length) break;
    for (const m of batch) {
      if (m.date * 1000 < since || (!m.message && !m.media)) continue;
      if (m.groupedId) {
        const g = m.groupedId.toString();
        if (albums.has(g)) continue;
        albums.add(g);
      }
      posts.push({
        at: m.date * 1000,
        text: m.message || '',
        views: m.views || 0,
        forwards: m.forwards || 0,
        reactions: (m.reactions?.results || []).reduce((s, r) => s + (r.count || 0), 0),
        media: Boolean(m.media),
      });
    }
    offsetId = batch[batch.length - 1].id;
    if (batch[batch.length - 1].date * 1000 < since) break;
  }
  return posts;
}

async function refreshOwnPace(channel, config, { fetch, fetchPosts }) {
  const entry = ownStats.get(channel.key) || {};
  ownStats.set(channel.key, entry);
  const now = Date.now();
  if (entry.checkedAt && now - entry.checkedAt < STATS_RELOAD_MS) return;
  entry.checkedAt = now;
  const saved = await getState(`pace:${channel.key}`).catch(() => null);
  if (saved) {
    try {
      entry.stats = JSON.parse(saved.value);
    } catch {
      /* rebuilt below */
    }
  }
  const stale = !entry.stats || now - entry.stats.at > STATS_REFRESH_MS;
  if (!fetch || !stale || (entry.triedAt && now - entry.triedAt < STATS_RETRY_MS)) return;
  entry.triedAt = now;
  try {
    const posts = await fetchPosts(channel);
    entry.stats = { at: now, posts: posts.length, hours: hourlyViews(posts, config.timeZone) };
    await setState(`pace:${channel.key}`, JSON.stringify(entry.stats));
  } catch (err) {
    console.warn(`[publishing] could not read ${channel.telegram}'s stats for its pace: ${err.message}`);
  }
}

// `fetch: false` only reads what the server last saved (no Telegram).
export async function refreshPaces(config, { fetch = true, fetchPosts = fetchSettledPosts } = {}) {
  for (const c of config.channels) {
    if (c.pace === 'stats') await refreshOwnPace(c, config, { fetch, fetchPosts }).catch(() => null);
    else if (c.paceLike) await paceProfile(c.paceLike, config.timeZone).catch(() => null);
  }
}

// The channel's posts-per-hour plan for each hour of the day (null until its
// stats are read, or when it has too few posts).
export function ownPace(channel) {
  const stats = ownStats.get(channel.key)?.stats;
  const rates = stats && paceRates(stats.hours, { target: channel.postsPerHour, max: channel.maxPerHour });
  return rates ? { rates, posts: stats.posts, at: stats.at } : null;
}

const fromRate = (rate) => ({ maxPerHour: Math.max(1, Math.ceil(rate)), minGapMinutes: Math.round(60 / rate) });

// { maxPerHour, minGapMinutes } for the channel at `date`.
export function limitsFor(channel, config, date = new Date()) {
  if (channel.pace === 'stats') {
    const plan = ownPace(channel);
    return fromRate(plan ? plan.rates[localHour(date, config.timeZone)] : channel.postsPerHour);
  }
  const own = { maxPerHour: channel.maxPerHour, minGapMinutes: channel.minGapMinutes };
  if (!channel.paceLike) return own;
  const p = profiles.get(String(channel.paceLike).replace(/^@/, '').toLowerCase());
  if (!p || p.days < 3) return own;
  const per = p.hours[localHour(date, config.timeZone)];
  const maxPerHour = Math.max(1, Math.min(channel.maxPerHour, Math.round(per)));
  return { maxPerHour, minGapMinutes: Math.min(30, 30 / maxPerHour) };
}

export function _setOwnStatsForTests(key, hours) {
  ownStats.set(key, { stats: { at: Date.now(), posts: hours.reduce((s, h) => s + h.n, 0), hours }, checkedAt: Date.now(), triedAt: Date.now() });
}

export function _setPaceProfileForTests(username, hours, days = 14) {
  profiles.set(String(username).replace(/^@/, '').toLowerCase(), { at: Date.now(), hours, days, posts: 0 });
}
