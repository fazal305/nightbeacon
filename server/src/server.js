import { createApp } from './app.js';
import { startPipeline } from './pipeline/workers.js';
import { recoverOrphanedStatuses } from './db/recoverOrphanedStatuses.js';
import { describeError, connectionHint } from './db/describeError.js';
import { sleep } from './pipeline/rateGate.js';

const PORT = process.env.PORT || 4000;
const DB_RETRY_MS = 5000;
const app = createApp();

// The pipeline needs the database, so it starts only once Postgres answers.
// Until then the API stays up (/api/health reports dbConnected: false) and
// the problem is logged plainly — previously a database that wasn't running
// at boot crashed the process with an unhandled AggregateError.
async function startWhenDatabaseReady() {
  for (let attempt = 1; ; attempt++) {
    try {
      await recoverOrphanedStatuses();
      if (attempt > 1) console.log('[startup] database reachable — starting pipeline');
      startPipeline();
      return;
    } catch (err) {
      if (attempt === 1 || attempt % 12 === 0) {
        console.error(`[startup] database unavailable: ${describeError(err)}`);
        const hint = connectionHint(err);
        if (hint) console.error(`[startup] ${hint}`);
        console.error(`[startup] retrying every ${DB_RETRY_MS / 1000}s…`);
      }
      await sleep(DB_RETRY_MS);
    }
  }
}

app.listen(PORT, () => {
  console.log(`Nightbeacon API listening on port ${PORT}`);
  startWhenDatabaseReady();
});
