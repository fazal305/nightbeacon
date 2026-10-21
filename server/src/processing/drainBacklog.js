// Clears the translation backlog with every translator you have keys for,
// all working in parallel, alongside the running server (posts are claimed
// exactly like the translation worker claims them, so nothing is translated
// twice).
//
//   npm run translate:drain                        until under 100 left
//   npm run translate:drain -- --until 500         stop at 500
//   npm run translate:drain -- --providers deepl,cloudflare,mistral
//   npm run translate:drain -- --max-minutes 60
//
// Web translators (deepl, cloudflare, huggingface, microsoft, bing, yandex,
// nllb, libretranslate, …) take posts one by one at their own safe rate; LLM
// providers (cerebras, mistral, openrouter, gemini, groq) take up to 35 per
// request, tagged <POST ID="n">…</POST>. A provider out of allowance waits
// (for its Retry-After or 10 minutes) while the others carry on. Telegram's
// own translation is never used here — a second program translating through
// your account could get it flood-limited — and Groq is left out by default
// because writing posts needs it.
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../db/pool.js';
import { callLLM, isProviderUnavailable } from './llmClient.js';
import { claimBatch } from '../pipeline/claim.js';
import { chunkForBatch, commitTranslation, trySkip, revertToNew, runProvider, LLM_PROVIDERS } from './translate.js';
import { sleep } from '../pipeline/rateGate.js';
import { triageBatch } from './triage.js';

const LLM_BATCH = Number(process.env.DRAIN_BATCH || 35);
const LLM_BATCH_MAX_CHARS = Number(process.env.DRAIN_BATCH_MAX_CHARS || 12000);
const WEB_BATCH = Number(process.env.DRAIN_WEB_BATCH || 10);
const PACING_MS = Number(process.env.DRAIN_PACING_MS || 2500);
const REST_MS = 10 * 60_000;
const DEFAULT_PROVIDERS = 'deepl,cloudflare,huggingface,microsoft,bing,yandex,cerebras,mistral,openrouter,gemini';
const SYSTEM = [
  'You are a translation system for a news monitoring desk.',
  'Translate the text inside every <POST ID="n"> tag into fluent English. Keep every number, name and place exactly; keep line breaks.',
  'Reply with ONLY the translations, one per input post, in the same tags: <POST ID="n" LANG="xx">English text</POST>',
  'where LANG is the ISO 639-1 code of the original language. No markdown, no commentary.',
].join('\n');

export function packPosts(posts) {
  return posts.map((p, i) => `<POST ID="${i + 1}">${p.raw_text}</POST>`).join('\n');
}

// Map(n -> { en, lang }) for the posts the model returned.
export function unpackPosts(reply, count) {
  const out = new Map();
  for (const m of String(reply || '').matchAll(/<POST ID="(\d+)"(?:\s+LANG="([a-zA-Z-]{2,8})")?\s*>([\s\S]*?)<\/POST>/g)) {
    const n = Number(m[1]);
    const en = m[3].trim();
    if (n >= 1 && n <= count && en && !out.has(n)) out.set(n, { en, lang: m[2] ? m[2].toLowerCase().slice(0, 3) : null });
  }
  return out;
}

const isLlm = (provider) => LLM_PROVIDERS.has(provider);

// Translates `posts` with one provider. Commits what it translated, puts
// the rest back in the queue, and returns { done, failedIds, restMs }.
// `llm` and `web` are injectable for tests.
export async function translateWith(provider, posts, { llm = callLLM, web = runProvider } = {}) {
  const translated = new Map(); // post id -> { text, lang, model }
  let restMs = null;
  if (isLlm(provider)) {
    for (const chunk of chunkForBatch(posts, LLM_BATCH, LLM_BATCH_MAX_CHARS)) {
      try {
        const { content, model } = await llm(
          [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: packPosts(chunk) },
          ],
          { providerName: provider, temperature: 0.1 }
        );
        const got = unpackPosts(content, chunk.length);
        chunk.forEach((p, i) => {
          const hit = got.get(i + 1);
          if (hit) translated.set(p.id, { text: hit.en, lang: hit.lang, model });
        });
      } catch (err) {
        if (isProviderUnavailable(err)) {
          restMs = REST_MS;
          break;
        }
      }
    }
  } else {
    const r = await web(provider, posts);
    for (const [id, t] of r.done) translated.set(id, t);
    restMs = r.restMs;
  }
  for (const [id, t] of translated) {
    await commitTranslation(id, { sourceLanguage: t.lang, translatedText: t.text, model: t.model, status: 'done' });
  }
  const left = posts.filter((p) => !translated.has(p.id));
  await revertToNew(left.map((p) => p.id));
  // Without a rest, what's left failed on this provider: don't hand it the same posts again.
  return { done: translated.size, failedIds: restMs ? [] : left.map((p) => p.id), restMs };
}

async function backlogSize() {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM raw_items
     WHERE status IN ('new', 'failed_translation') AND dedup_status IN ('unique', 'update', 'legacy')`
  );
  return rows[0].n;
}

// Sleeps in short steps so a stop or the deadline ends long rests early.
async function wait(ms, ctx) {
  const end = Date.now() + ms;
  while (!ctx.stop && Date.now() < Math.min(end, ctx.deadline)) await sleep(Math.min(5000, end - Date.now()));
}

async function providerLoop(provider, ctx) {
  const skip = new Set(); // posts this provider couldn't do
  const stats = (ctx.stats[provider] = { done: 0, state: 'working' });
  while (!ctx.stop && Date.now() < ctx.deadline) {
    const claimed = await claimBatch({
      eligibleSql: `(status = 'new' OR (status = 'failed_translation' AND translation_attempts < 5))
                    AND dedup_status IN ('unique', 'update', 'legacy') AND NOT (id = ANY($1::bigint[]))`,
      eligibleParams: [[...skip].slice(-5000)],
      claimStatus: 'translating',
      limit: isLlm(provider) ? LLM_BATCH : WEB_BATCH,
      returning: 'id, raw_text, telegram_date',
    });
    if (claimed.length === 0) {
      stats.state = 'idle';
      await wait(30_000, ctx);
      continue;
    }
    const kept = [];
    for (const item of claimed) if (!(await trySkip(item))) kept.push(item);
    // Same priority bar as the translation worker.
    const { translate: posts } = await triageBatch(kept);
    if (posts.length === 0) continue;

    const r = await translateWith(provider, posts);
    stats.done += r.done;
    ctx.total += r.done;
    r.failedIds.forEach((id) => skip.add(id));
    if (r.restMs) {
      stats.state = `resting until ${new Date(Date.now() + r.restMs).toLocaleTimeString()}`;
      await wait(r.restMs, ctx);
    } else {
      stats.state = 'working';
      await wait(PACING_MS, ctx);
    }
  }
}

async function main() {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : fallback;
  };
  const until = Number(arg('until', 100));
  const providers = String(arg('providers', process.env.DRAIN_PROVIDERS || DEFAULT_PROVIDERS))
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p && p !== 'telegram');
  const ctx = { stop: false, total: 0, stats: {}, deadline: Date.now() + Number(arg('max-minutes', 24 * 60)) * 60_000 };
  console.log(`🚀 Draining the translation backlog with ${providers.length} translators in parallel: ${providers.join(', ')}`);
  console.log(`   Stops below ${until} left. Close this window (or Ctrl+C) to stop earlier.`);

  const progress = setInterval(async () => {
    const left = await backlogSize().catch(() => null);
    const per = Object.entries(ctx.stats)
      .map(([p, s]) => `${p} ${s.done}${s.state === 'working' ? '' : ` (${s.state})`}`)
      .join(' · ');
    console.log(`📉 ${left} left · ${ctx.total} translated this run · ${per}`);
    if (left != null && left < until) ctx.stop = true;
  }, 60_000);

  await Promise.all(providers.map((p) => providerLoop(p, ctx).catch((err) => console.warn(`⚠️  ${p} stopped: ${err.message}`))));
  clearInterval(progress);
  console.log(`🏁 Done: ${ctx.total} translated, ${await backlogSize()} left.`);
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
