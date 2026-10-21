// Tries every translation provider once with a short sample, so you can see
// which ones work from your network before (or while) rotating them:
//   npm run translate:check
// Prints a TRANSLATION_PROVIDER line with the working ones, Telegram first.
import 'dotenv/config';
import { WEB_TRANSLATORS } from './webTranslate.js';
import { translateBatch } from './telegramTranslate.js';
import { callLLM } from './llmClient.js';

const SAMPLE = 'عاجل: انفجار في الميناء وإصابة 12 شخصا';
const checks = {
  telegram: async () => ({ text: (await translateBatch([SAMPLE]))[0] }),
  google: () => WEB_TRANSLATORS.google(SAMPLE),
  lingva: () => WEB_TRANSLATORS.lingva(SAMPLE),
  libretranslate: () => WEB_TRANSLATORS.libretranslate(SAMPLE),
  groq: async () => ({ text: (await callLLM([{ role: 'user', content: `Translate to English: ${SAMPLE}` }], { providerName: 'groq' })).content }),
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
// Groq is best kept for drafting posts; list it last if at all.
const order = ['telegram', 'google', 'lingva', 'libretranslate', 'groq'];
const line = order.filter((n) => working.includes(n) && n !== 'groq');
console.log(line.length ? `\nPut this in server/.env:\nTRANSLATION_PROVIDER=${line.join(',')}` : '\nNo free translator worked from this network.');
setTimeout(() => process.exit(0), 300);
