// Clears the translation backlog in big batches through the free LLM
// providers, alongside the running server (it claims posts the same way the
// translation worker does, so the two never translate the same post).
//
//   npm run translate:drain                       until under 100 left
//   npm run translate:drain -- --until 500        stop at 500
//   npm run translate:drain -- --providers cerebras,mistral
//   npm run translate:drain -- --max-minutes 60
//
// Each request carries up to DRAIN_BATCH (35) posts — fewer if they're long —
// tagged <POST ID="n">…</POST> with short numbers, not database ids. Providers
// are tried in order; each rotates through its own models, and one that is
// out of allowance is rested while the next takes over (see llmClient.js).
// Default order keeps Groq and Gemini last: drafting posts needs them too.
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../db/pool.js';
import { callLLM, isProviderUnavailable } from './llmClient.js';
import { claimBatch } from '../pipeline/claim.js';
import { chunkForBatch, commitTranslation, trySkip, revertToNew } from './translate.js';
import { sleep } from '../pipeline/rateGate.js';

const BATCH = Number(process.env.DRAIN_BATCH || 35);
const BATCH_MAX_CHARS = Number(process.env.DRAIN_BATCH_MAX_CHARS || 12000);
const PACING_MS = Number(process.env.DRAIN_PACING_MS || 2500);
const REST_MS = 10 * 60_000;
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

async function backlogSize() {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM raw_items
     WHERE status IN ('new', 'failed_translation') AND dedup_status IN ('unique', 'update', 'legacy')`
  );
  return rows[0].n;
}

// One batch through the first provider that takes it. Returns the number
// translated; throws only when every provider is unavailable.
export async function drainBatch(posts, providers, { llm = callLLM, resting = new Map(), log = console.log } = {}) {
  const ready = providers.filter((p) => (resting.get(p) || 0) <= Date.now());
  if (ready.length === 0) throw Object.assign(new Error('every provider is resting'), { allResting: true });
  for (const provider of ready) {
    try {
      const { content, model } = await llm(
        [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: packPosts(posts) },
        ],
        { providerName: provider, temperature: 0.1 }
      );
      const got = unpackPosts(content, posts.length);
      if (got.size === 0) throw new Error('reply had no usable <POST> tags');
      for (let i = 0; i < posts.length; i++) {
        const hit = got.get(i + 1);
        if (hit) await commitTranslation(posts[i].id, { sourceLanguage: hit.lang, translatedText: hit.en, model, status: 'done' });
      }
      // Posts the model left out go back to the queue for the next batch.
      await revertToNew(posts.filter((_, i) => !got.has(i + 1)).map((p) => p.id));
      log(`✅ ${got.size}/${posts.length} translated via ${provider} (${model})`);
      return got.size;
    } catch (err) {
      log(`⚠️  ${provider}: ${err.message.slice(0, 140)}`);
      // Out of allowance / unreachable: rest it. A bad reply: just try the next one.
      if (isProviderUnavailable(err)) resting.set(provider, Date.now() + REST_MS);
    }
  }
  await revertToNew(posts.map((p) => p.id));
  return 0;
}

async function main() {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : fallback;
  };
  const until = Number(arg('until', 100));
  const deadline = Date.now() + Number(arg('max-minutes', 24 * 60)) * 60_000;
  const providers = String(arg('providers', process.env.DRAIN_LLM_PROVIDERS || 'cerebras,mistral,openrouter,gemini,groq'))
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  const resting = new Map();
  let total = 0;
  console.log(`🚀 Draining the translation backlog via ${providers.join(' → ')} (stops below ${until} left).`);

  while (Date.now() < deadline) {
    const left = await backlogSize();
    if (left < until) {
      console.log(`🏁 ${left} left — below ${until}. Translated ${total} in this run.`);
      return;
    }
    const claimed = await claimBatch({
      eligibleSql: `(status = 'new' OR (status = 'failed_translation' AND translation_attempts < 5))
                    AND dedup_status IN ('unique', 'update', 'legacy')`,
      claimStatus: 'translating',
      limit: BATCH * 3,
      returning: 'id, raw_text, telegram_date',
    });
    const posts = [];
    for (const item of claimed) if (!(await trySkip(item))) posts.push(item);
    const chunks = chunkForBatch(posts, BATCH, BATCH_MAX_CHARS);
    for (let c = 0; c < chunks.length; c++) {
      try {
        total += await drainBatch(chunks[c], providers, { resting });
      } catch (err) {
        if (!err.allResting) throw err;
        const wake = Math.min(...resting.values());
        // Only the batches not attempted yet go back to the queue.
        await revertToNew(chunks.slice(c).flat().map((p) => p.id));
        console.log(`⏳ Every provider is out of allowance for now — waiting until ${new Date(wake).toLocaleTimeString()}.`);
        await sleep(Math.max(wake - Date.now(), 60_000));
        break;
      }
      await sleep(PACING_MS);
    }
    console.log(`📉 ${await backlogSize()} left in the backlog (${total} translated in this run).`);
  }
  console.log(`⏱️  Time limit reached. Translated ${total} in this run.`);
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
