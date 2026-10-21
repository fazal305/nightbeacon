// Tries Telegram's built-in translation (messages.translateText) on this
// account, through the configured proxies, before switching
// TRANSLATION_PROVIDER=telegram. Uses the real session (read-only call).
// Run: npm run telegram:check-translate
import 'dotenv/config';
import { getTelegramClient } from '../ingestion/telegramClient.js';
import { translateBatch } from './telegramTranslate.js';

const SAMPLES = [
  'عاجل: انفجار قوي يهز ميناء المدينة صباح اليوم',
  'ارتش اعلام کرد که عملیات در منطقه شمالی ادامه دارد',
  'حکومت نے آج نئی پالیسی کا اعلان کیا',
];

async function main() {
  await getTelegramClient();
  const started = Date.now();
  const out = await translateBatch(SAMPLES);
  console.log(`Telegram translated ${out.length} posts in one call (${Date.now() - started} ms):\n`);
  SAMPLES.forEach((s, i) => console.log(`  ${s}\n  -> ${out[i]}\n`));
  console.log('Works. To use it: set TRANSLATION_PROVIDER=telegram in server/.env and restart the server.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`Telegram translation is not available on this account: ${err.errorMessage || err.message}`);
    process.exit(1);
  });
