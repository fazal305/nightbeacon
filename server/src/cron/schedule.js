import cron from 'node-cron';
import { pollAllEnabledSources } from '../ingestion/pollSource.js';
import { runTranslationTick } from '../processing/translate.js';
import { runClassificationTick } from '../processing/classify.js';
import { recordRun } from '../subsystems/recordRun.js';

const POLL_SCHEDULE = process.env.POLL_CRON_SCHEDULE || '*/2 * * * *'; // every 2 minutes
const TRANSLATE_SCHEDULE = process.env.TRANSLATE_CRON_SCHEDULE || '*/1 * * * *'; // every 1 minute
const CLASSIFY_SCHEDULE = process.env.CLASSIFY_CRON_SCHEDULE || '*/1 * * * *'; // every 1 minute

export function startCronJobs() {
  cron.schedule(POLL_SCHEDULE, async () => {
    try {
      const results = await recordRun('ingestion', async () => {
        const raw = await pollAllEnabledSources();
        return raw.map((r) => ({ ...r, outcome: r.error ? 'failed' : 'success' }));
      });
      const inserted = results.reduce((sum, r) => sum + (r.inserted || 0), 0);
      console.log(`[ingestion] poll tick: ${results.length} source(s), ${inserted} new item(s)`);
    } catch (err) {
      console.error('[ingestion] poll tick failed:', err.message);
    }
  });

  cron.schedule(TRANSLATE_SCHEDULE, async () => {
    try {
      const results = await recordRun('translation', runTranslationTick);
      if (results.length > 0) {
        const translated = results.filter((r) => r.outcome === 'translated').length;
        const skipped = results.filter((r) => r.outcome === 'skipped').length;
        const failed = results.filter((r) => r.outcome === 'failed').length;
        console.log(
          `[translation] tick: ${results.length} item(s) — ${translated} translated, ${skipped} skipped, ${failed} failed`
        );
      }
    } catch (err) {
      console.error('[translation] tick failed:', err.message);
    }
  });

  cron.schedule(CLASSIFY_SCHEDULE, async () => {
    try {
      const results = await recordRun('classification', runClassificationTick);
      if (results.length > 0) {
        const ready = results.filter((r) => r.outcome === 'ready').length;
        const failed = results.filter((r) => r.outcome === 'failed').length;
        console.log(`[classification] tick: ${results.length} item(s) — ${ready} ready, ${failed} failed`);
      }
    } catch (err) {
      console.error('[classification] tick failed:', err.message);
    }
  });

  console.log(`[cron] ingestion poll scheduled: ${POLL_SCHEDULE}`);
  console.log(`[cron] translation tick scheduled: ${TRANSLATE_SCHEDULE}`);
  console.log(`[cron] classification tick scheduled: ${CLASSIFY_SCHEDULE}`);
}
