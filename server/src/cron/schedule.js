import cron from 'node-cron';
import { pollAllEnabledSources } from '../ingestion/pollSource.js';

const POLL_SCHEDULE = process.env.POLL_CRON_SCHEDULE || '*/2 * * * *'; // every 2 minutes

export function startCronJobs() {
  cron.schedule(POLL_SCHEDULE, async () => {
    try {
      const results = await pollAllEnabledSources();
      const inserted = results.reduce((sum, r) => sum + (r.inserted || 0), 0);
      console.log(`[ingestion] poll tick: ${results.length} source(s), ${inserted} new item(s)`);
    } catch (err) {
      console.error('[ingestion] poll tick failed:', err.message);
    }
  });

  console.log(`[cron] ingestion poll scheduled: ${POLL_SCHEDULE}`);
}
