// Tries every translation provider once with a short sample, so you can see
// which ones work from your network before (or while) rotating them:
//   npm run translate:check
// Prints a TRANSLATION_PROVIDER line with the working ones, Telegram first.
import 'dotenv/config';
import { WEB_TRANSLATORS } from './webTranslate.js';
import { translateBatch } from './telegramTranslate.js';
import { callLLM } from './llmClient.js';

const SAMPLE = 'عاجل: انفجار في الميناء وإصابة 12 شخصا';
const llm = (providerName) => async () =>
  ({ text: (await callLLM([{ role: 'user', content: `Translate to English, reply with the translation only: ${SAMPLE}` }], { providerName })).content });
const checks = {
  telegram: async () => ({ text: (await translateBatch([SAMPLE]))[0] }),
  ...Object.fromEntries(Object.entries(WEB_TRANSLATORS).map(([name, fn]) => [name, () => fn(SAMPLE)])),
  gemini: llm('gemini'),
  cerebras: llm('cerebras'),
  mistral: llm('mistral'),
  openrouter: llm('openrouter'),
  groq: llm('groq'),
};

const working = [];
for (const [name, run] of Object.entries(checks)) {
  const started = Date.now();
  try {
    const r = await Promise.race([run(), new Promise((_, rej) => setTimeout(() => rej(new Error('no answer in 30s')), 30000))]);
    console.log(`  OK   ${name.padEnd(15)} ${Date.now() - started} ms  "${String(r.text).slice(0, 60)}"`);
    working.push(name);
  } catch (err) {
    console.log(`  --   ${name.padEnd(15)} ${String(err.message).slice(0, 110)}`);
  }
}
// Free translators first, local ones next, LLMs (whose allowance drafting
// also needs) last; Groq is left out — keep it for writing posts.
const order = ['telegram', 'google', 'bing', 'yandex', 'microsoft', 'deepl', 'lingva', 'cloudflare', 'nllb', 'libretranslate',
  'huggingface', 'mymemory', 'cerebras', 'mistral', 'gemini', 'openrouter'];
const line = order.filter((n) => working.includes(n));
console.log(line.length ? `\nPut this in server/.env:\nTRANSLATION_PROVIDER=${line.join(',')}` : '\nNo free translator worked from this network.');
setTimeout(() => process.exit(0), 300);
