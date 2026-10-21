// Adds the channels left in channels/source-candidates.md (after your review)
// as monitored sources.
//
//   npm run sources:add                  all listed candidates
//   npm run sources:add -- --limit 300   only the first 300
//
// Candidates that came with a channel id are polled straight away; the rest
// are resolved by username slowly by the poller (one lookup every few
// seconds, pausing for any Telegram flood-wait), so they start over the
// following hours. A new source's first poll only keeps the last hour of
// posts, so adding hundreds doesn't flood the pipeline with old news.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';
import { CANDIDATES_MD, CANDIDATES_JSON, parseCandidateUsernames } from './discoverSources.js';

const NOTE = 'Added by source discovery (similar / linked / mentioned channels). Not individually vetted — reliability/bias unverified.';

async function main() {
  if (!fs.existsSync(CANDIDATES_MD)) {
    console.error('No candidate list yet — run: npm run sources:discover');
    process.exitCode = 1;
    return;
  }
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity;
  const usernames = parseCandidateUsernames(fs.readFileSync(CANDIDATES_MD, 'utf8')).slice(0, limit);
  const details = fs.existsSync(CANDIDATES_JSON) ? JSON.parse(fs.readFileSync(CANDIDATES_JSON, 'utf8')) : {};

  let added = 0;
  let withId = 0;
  for (const username of usernames) {
    const d = details[username.toLowerCase()] || {};
    const r = await pool.query(
      `INSERT INTO sources (channel_username, display_name, reliability_note, telegram_channel_id, telegram_access_hash)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (channel_username) DO NOTHING RETURNING id`,
      [username, d.title || username, NOTE, d.id ?? null, d.accessHash ?? null]
    );
    added += r.rowCount;
    if (r.rowCount && d.id) withId++;
  }
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM sources WHERE enabled');
  console.log(`Added ${added} source(s) (${withId} polled right away, ${added - withId} after a username lookup).`);
  console.log(`You now monitor ${rows[0].n} enabled sources. The running server picks them up by itself.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end().catch(() => {}));
}
