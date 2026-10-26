import { pool } from '../db/pool.js';
import { getState, setState } from '../db/appState.js';

// Big-event mode: when something major breaks (e.g. a strike on Iran), bot
// channels with "surge" in channels.json post faster than their normal pace
// for a while. It turns on by itself when either
//   - high-priority stories in the last hour reach SURGE_RATIO × last week's
//     hourly average (and at least SURGE_MIN_STORIES), or
//   - one story of the last 2 hours is reported by SURGE_STORY_REPORTS+
//     channels,
// and stays on until SURGE_HOLD_HOURS after the last time a signal fired.
// It can also be switched on (for N hours) or off from the Publishing page.
// The server's workers detect it; the state lives in app_state so the
// dashboard and check scripts see the same thing.
const STATE_KEY = 'surge';
const CHECK_MS = 2 * 60_000;

export function surgeSettings(env = process.env) {
  return {
    ratio: Number(env.SURGE_RATIO || 3),
    minStories: Number(env.SURGE_MIN_STORIES || 12),
    storyReports: Number(env.SURGE_STORY_REPORTS || 40),
    holdHours: Number(env.SURGE_HOLD_HOURS || 2),
  };
}

let current = null; // { until, since, reason, manual } or null
let checkedAt = 0;

export function surgeActive(now = Date.now()) {
  return current && new Date(current.until).getTime() > now ? current : null;
}

// The numbers behind the decision.
export async function surgeSignals() {
  const { rows: [r] } = await pool.query(
    `SELECT count(*) FILTER (WHERE st.first_seen_at > now() - interval '1 hour')::int AS last_hour,
            count(*) FILTER (WHERE st.first_seen_at <= now() - interval '1 hour')::float / (7 * 24 - 1) AS hourly_avg,
            coalesce(max(st.item_count) FILTER (WHERE st.first_seen_at > now() - interval '2 hours'), 0)::int AS top_reports
     FROM stories st JOIN raw_items ri ON ri.id = st.canonical_item_id
     WHERE st.last_seen_at > now() - interval '7 days' AND st.first_seen_at > now() - interval '7 days'
       AND coalesce(ri.priority, ri.triage_priority) = 'high'`
  );
  return { lastHour: r.last_hour, hourlyAvg: Math.round(r.hourly_avg * 10) / 10, topReports: r.top_reports };
}

export function surgeReason(signals, settings = surgeSettings()) {
  const { lastHour, hourlyAvg, topReports } = signals;
  if (lastHour >= settings.minStories && lastHour >= settings.ratio * hourlyAvg)
    return `${lastHour} high-priority stories in the last hour (usually ${hourlyAvg})`;
  if (topReports >= settings.storyReports) return `one story reported by ${topReports} channels`;
  return null;
}

// `detect: false` only reads the saved state (dashboard, check scripts).
export async function refreshSurge({ detect = true, signals = surgeSignals, now = Date.now() } = {}) {
  if (now - checkedAt < CHECK_MS) return surgeActive(now);
  checkedAt = now;
  const saved = await getState(STATE_KEY).catch(() => null);
  try {
    current = saved?.value ? JSON.parse(saved.value) : null;
  } catch {
    current = null;
  }
  if (!detect) return surgeActive(now);
  const active = surgeActive(now);
  // A manual switch decides until it runs out.
  if (active?.manual) return active;
  if (current?.quietUntil && new Date(current.quietUntil).getTime() > now) return null;
  const settings = surgeSettings();
  const reason = surgeReason(await signals(), settings);
  if (reason) {
    current = {
      since: active?.since || new Date(now).toISOString(),
      until: new Date(now + settings.holdHours * 3600_000).toISOString(),
      reason,
      manual: false,
    };
    if (!active) console.log(`[publishing] big-event mode on: ${reason}`);
    await setState(STATE_KEY, JSON.stringify(current));
  }
  return surgeActive(now);
}

// From the dashboard: hours > 0 switches it on for that long, 0 switches it off.
export async function setSurge(hours, now = Date.now()) {
  current =
    hours > 0
      ? { since: new Date(now).toISOString(), until: new Date(now + hours * 3600_000).toISOString(), reason: 'switched on by you', manual: true }
      : // Off: also keeps the detector quiet for the hold time, so it doesn't
        // switch straight back on from the same signals.
        { since: null, until: new Date(now).toISOString(), reason: 'switched off by you', manual: true, quietUntil: new Date(now + surgeSettings().holdHours * 3600_000).toISOString() };
  checkedAt = now;
  await setState(STATE_KEY, JSON.stringify(current));
  return surgeActive(now);
}

export function _setSurgeForTests(state) {
  current = state;
  checkedAt = state ? Date.now() : 0;
}
