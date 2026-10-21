// Clears the drafting queue (posts waiting to be written: automatic picks and
// ones you asked for from the dashboard) with every LLM provider you have a
// key for, all working in parallel, alongside the running server. Posts are
// claimed exactly like the drafting worker claims them, so nothing is
// drafted twice.
//
//   npm run publish:drain                        until the queue is empty
//   npm run publish:drain -- --until 50          stop below 50 waiting
//   npm run publish:drain -- --providers gemini,cerebras,github
//   npm run publish:drain -- --max-minutes 60
//
// Automatic picks for news that has gone stale are expired first (as the
// server does), so tokens go to news that can still be posted. A provider
// out of allowance rests for 10 minutes while the others carry on.
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../db/pool.js';
import { providerConfigured } from '../processing/llmClient.js';
import { sleep } from '../pipeline/rateGate.js';
import { publishConfig } from './config.js';
import { claimRequested, draftGroup, expireStaleRequests } from './drafter.js';

const PACING_MS = Number(process.env.DRAFT_DRAIN_PACING_MS || 3000);
const REST_MS = 10 * 60_000;

async function queueSize() {
  const { rows } = await pool.query(`SELECT count(DISTINCT raw_item_id)::int AS n FROM publications WHERE status = 'requested'`);
  return rows[0].n;
}

// Sleeps in short steps so a stop or the deadline ends long rests early.
async function wait(ms, ctx) {
  const end = Date.now() + ms;
  while (!ctx.stop && Date.now() < Math.min(end, ctx.deadline)) await sleep(Math.min(5000, end - Date.now()));
}

// One provider's worker: claims one post at a time and drafts it for all its
// requested channels. `deps` is injectable for tests.
export async function providerLoop(provider, ctx, deps = {}) {
  const claim = deps.claim || (() => claimRequested(1));
  const draft = deps.draft || draftGroup;
  const stats = (ctx.stats[provider] = { done: 0, state: 'working' });
  while (!ctx.stop && Date.now() < ctx.deadline) {
    const [group] = await claim();
    if (!group) {
      ctx.stop = true; // queue empty
      break;
    }
    const { results, systemic } = await draft(group, ctx.config, { providerName: provider });
    const ok = results.filter((r) => r.outcome !== 'failed').length;
    stats.done += ok;
    ctx.total += ok;
    if (systemic) {
      stats.state = `resting until ${new Date(Date.now() + REST_MS).toLocaleTimeString()}`;
      await wait(deps.restMs ?? REST_MS, ctx);
    } else {
      stats.state = 'working';
      await wait(deps.pacingMs ?? PACING_MS, ctx);
    }
  }
  stats.state = 'finished';
}

async function main() {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : fallback;
  };
  const config = publishConfig();
  const until = Number(arg('until', 1));
  const wanted = String(arg('providers', process.env.DRAFT_DRAIN_PROVIDERS || config.draftProvider))
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  const providers = wanted.filter(providerConfigured);
  if (providers.length === 0) {
    console.log(`No drafting provider has a key in .env (looked for: ${wanted.join(', ')}).`);
    return;
  }

  await expireStaleRequests(config);
  const start = await queueSize();
  console.log(`🚀 ${start} post(s) waiting to be drafted. Drafting with ${providers.length} providers in parallel: ${providers.join(', ')}`);
  if (wanted.length > providers.length) {
    console.log(`   (no key for: ${wanted.filter((p) => !providers.includes(p)).join(', ')})`);
  }
  if (start < until) return;

  const ctx = { config, stop: false, total: 0, stats: {}, deadline: Date.now() + Number(arg('max-minutes', 24 * 60)) * 60_000 };
  const progress = setInterval(async () => {
    const left = await queueSize().catch(() => null);
    const per = Object.entries(ctx.stats)
      .map(([p, s]) => `${p} ${s.done}${s.state === 'working' ? '' : ` (${s.state})`}`)
      .join(' · ');
    console.log(`📉 ${left} waiting · ${ctx.total} drafted this run · ${per}`);
    if (left != null && left < until) ctx.stop = true;
  }, 60_000);

  await Promise.all(providers.map((p) => providerLoop(p, ctx).catch((err) => console.warn(`⚠️  ${p} stopped: ${err.message}`))));
  clearInterval(progress);
  console.log(`🏁 Done: ${ctx.total} drafted, ${await queueSize()} still waiting.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
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
