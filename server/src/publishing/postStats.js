// What works on one of your channels, from its own recent posts (read with
// the monitoring account): average views, shares and reactions by hour of
// posting, with or without a photo/video, headline style, and length; plus
// the best and worst posts. Only posts older than a day are compared (views
// keep growing for a while).
//   npm run stats:posts                       (@r3syst, last 14 days)
//   npm run stats:posts -- @ResistanceMediaNews --days 7
import 'dotenv/config';
import { getTelegramClient, withTimeout, REQUEST_TIMEOUT_MS } from '../ingestion/telegramClient.js';
import { findChannelPeer } from './style.js';
import { localHour } from './pace.js';
import { isHeadlinePost } from './banners.js';
import { pool } from '../db/pool.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const channel = `@${(process.argv.slice(2).find((a) => a.startsWith('@')) || '@r3syst').replace(/^@/, '')}`;
const days = Number(arg('days', 14));
const timeZone = process.env.PUBLISH_TIMEZONE || 'Asia/Karachi';

export function summarise(posts) {
  const avg = (list, f) => (list.length ? list.reduce((s, p) => s + f(p), 0) / list.length : 0);
  const line = (label, list) =>
    `  ${label.padEnd(26)} ${String(list.length).padStart(4)} posts · ${avg(list, (p) => p.views).toFixed(0).padStart(5)} views · ${avg(list, (p) => p.forwards).toFixed(1).padStart(4)} shares · ${avg(list, (p) => p.reactions).toFixed(1).padStart(4)} reactions`;
  return { avg, line };
}

async function main() {
  const client = await getTelegramClient();
  const peer = await findChannelPeer(client, channel);
  const since = Date.now() - days * 86400_000;
  const dayOld = Date.now() - 86400_000;
  const posts = [];
  let offsetId = 0;
  for (let page = 0; page < 20; page++) {
    const batch = await withTimeout(client.getMessages(peer, { limit: 100, offsetId }), REQUEST_TIMEOUT_MS, 'read channel');
    if (!batch.length) break;
    for (const m of batch) {
      const at = m.date * 1000;
      if (at < since) continue;
      if (!m.message && !m.media) continue;
      posts.push({
        at,
        text: m.message || '',
        views: m.views || 0,
        forwards: m.forwards || 0,
        reactions: (m.reactions?.results || []).reduce((s, r) => s + (r.count || 0), 0),
        media: Boolean(m.media),
        grouped: m.groupedId ? m.groupedId.toString() : null,
      });
    }
    offsetId = batch[batch.length - 1].id;
    if (batch[batch.length - 1].date * 1000 < since) break;
  }
  // Albums: keep the message with the caption (or the first).
  const seen = new Set();
  const all = posts.filter((p) => (p.grouped ? (seen.has(p.grouped) ? false : (seen.add(p.grouped), true)) : true));
  const settled = all.filter((p) => p.at < dayOld);
  if (settled.length < 10) throw new Error(`only ${settled.length} post(s) older than a day in the last ${days} days — try --days 30`);
  const { avg, line } = summarise(settled);

  console.log(`${channel} — ${settled.length} posts from the last ${days} days (older than 1 day)\n`);
  console.log(line('All posts', settled));
  console.log(line('With photo/video', settled.filter((p) => p.media)));
  console.log(line('Text only', settled.filter((p) => !p.media)));
  console.log(line('Headline (BREAKING/🔴…)', settled.filter((p) => isHeadlinePost(p.text))));
  console.log(line('Other style', settled.filter((p) => !isHeadlinePost(p.text))));
  console.log(line('Short (< 300 chars)', settled.filter((p) => p.text.length < 300)));
  console.log(line('Long (≥ 300 chars)', settled.filter((p) => p.text.length >= 300)));

  // Busy days vs quiet days: does posting more lower views per post?
  const byDay = new Map();
  for (const p of settled) {
    const d = new Date(p.at).toLocaleDateString('en-CA', { timeZone });
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(p);
  }
  console.log('\nPer day (posts → average views per post, total views):');
  for (const [d, list] of [...byDay.entries()].sort()) {
    console.log(`  ${d}  ${String(list.length).padStart(3)} posts → ${avg(list, (p) => p.views).toFixed(0).padStart(5)} per post, ${list.reduce((s, p) => s + p.views, 0)} total`);
  }

  console.log(`\nBy hour posted (${timeZone}) — average views per post:`);
  const hours = Array.from({ length: 24 }, () => []);
  for (const p of settled) hours[localHour(new Date(p.at), timeZone)].push(p);
  const best = Math.max(...hours.map((l) => avg(l, (p) => p.views)), 1);
  hours.forEach((l, h) => {
    if (!l.length) return;
    const v = avg(l, (p) => p.views);
    console.log(`  ${String(h).padStart(2, '0')}:00  ${String(l.length).padStart(3)} posts  ${v.toFixed(0).padStart(5)}  ${'█'.repeat(Math.round((v / best) * 30))}`);
  });

  const first = (p) => p.text.split('\n')[0].slice(0, 70) || '(media only)';
  const ranked = settled.slice().sort((a, b) => b.views + b.forwards * 20 - (a.views + a.forwards * 20));
  console.log('\nBest posts (views, shares):');
  for (const p of ranked.slice(0, 5)) console.log(`  ${String(p.views).padStart(5)} · ${p.forwards} · ${first(p)}`);
  console.log('Weakest posts:');
  for (const p of ranked.slice(-5)) console.log(`  ${String(p.views).padStart(5)} · ${p.forwards} · ${first(p)}`);
}

if (process.argv[1]?.endsWith('postStats.js')) {
  main()
    .catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
    })
    .finally(async () => {
      await pool.end().catch(() => {});
      setTimeout(() => process.exit(), 300);
    });
}
