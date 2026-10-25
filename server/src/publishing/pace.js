import { pool } from '../db/pool.js';

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

export async function refreshPaces(config) {
  for (const c of config.channels) if (c.paceLike) await paceProfile(c.paceLike, config.timeZone).catch(() => null);
}

// { maxPerHour, minGapMinutes } for the channel at `date`.
export function limitsFor(channel, config, date = new Date()) {
  const own = { maxPerHour: channel.maxPerHour, minGapMinutes: channel.minGapMinutes };
  if (!channel.paceLike) return own;
  const p = profiles.get(String(channel.paceLike).replace(/^@/, '').toLowerCase());
  if (!p || p.days < 3) return own;
  const per = p.hours[localHour(date, config.timeZone)];
  const maxPerHour = Math.max(1, Math.min(channel.maxPerHour, Math.round(per)));
  return { maxPerHour, minGapMinutes: Math.min(30, 30 / maxPerHour) };
}

export function _setPaceProfileForTests(username, hours, days = 14) {
  profiles.set(String(username).replace(/^@/, '').toLowerCase(), { at: Date.now(), hours, days, posts: 0 });
}
