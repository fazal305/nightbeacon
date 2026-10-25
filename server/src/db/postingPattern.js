// A monitored channel's posting pattern, from what ingestion stored:
//   npm run sources:pattern                         (Middle_East_Spectator)
//   npm run sources:pattern -- @SomeChannel --days 7
import 'dotenv/config';
import { pool } from './pool.js';
import { paceProfile } from '../publishing/pace.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const username = (process.argv.slice(2).find((a) => !a.startsWith('--') && !/^\d+$/.test(a)) || 'Middle_East_Spectator').replace(/^@/, '');
const days = Number(arg('days', 14));
const timeZone = process.env.PUBLISH_TIMEZONE || 'Asia/Karachi';

try {
  const p = await paceProfile(username, timeZone, { days });
  if (!p.posts) throw new Error(`no stored posts from @${username} in ${days} days — check the username with npm run sources:list`);
  const { rows: [st] } = await pool.query(
    `SELECT round(avg(length(raw_text)))::int AS avg_len,
            round(100.0 * avg(CASE WHEN has_media THEN 1 ELSE 0 END))::int AS media_pct,
            round(100.0 * avg(CASE WHEN raw_text ~ '#\\w' THEN 1 ELSE 0 END))::int AS hashtag_pct,
            round(100.0 * avg(CASE WHEN raw_text ~* '^\\W*(breaking|urgent|just in)' THEN 1 ELSE 0 END))::int AS breaking_pct,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY gap)::int AS median_gap_min
     FROM (SELECT ri.*, extract(epoch FROM ri.telegram_date - lag(ri.telegram_date) OVER (ORDER BY ri.telegram_date)) / 60 AS gap
           FROM raw_items ri JOIN sources s ON s.id = ri.source_id
           WHERE lower(s.channel_username) = lower($1) AND ri.telegram_date > now() - make_interval(days => $2)) t`,
    [username, days]
  );
  console.log(`@${username} — last ${p.days} day(s), ${p.posts} posts (${(p.posts / Math.max(p.days, 1)).toFixed(0)} a day)`);
  console.log(`  typical gap between posts: ${st.median_gap_min} min · average length: ${st.avg_len} characters`);
  console.log(`  with photo/video: ${st.media_pct}% · hashtags: ${st.hashtag_pct}% · starting with BREAKING/URGENT: ${st.breaking_pct}%`);
  console.log(`\nPosts per hour (${timeZone}), average:`);
  const max = Math.max(...p.hours, 1);
  p.hours.forEach((n, h) => console.log(`  ${String(h).padStart(2, '0')}:00  ${n.toFixed(1).padStart(5)}  ${'█'.repeat(Math.round((n / max) * 30))}`));
  console.log(`\nChannels with "paceLike": "${username}" post up to that many an hour (capped by their maxPerHour).`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
