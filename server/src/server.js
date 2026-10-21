import { createApp } from './app.js';
import { startPipeline } from './pipeline/workers.js';
import { recoverOrphanedStatuses } from './db/recoverOrphanedStatuses.js';
import { describeError, connectionHint } from './db/describeError.js';
import { sleep } from './pipeline/rateGate.js';
import { isLocalDatabase, startLocalDb } from './db/localDb.js';

const PORT = process.env.PORT || 4000;
const DB_RETRY_MS = 5000;
const LOCAL_DB_START_EVERY = 12; // attempts (~1 minute) between start tries
const app = createApp();

// The pipeline needs the database, so it starts only once Postgres answers.
// Until then the API stays up (/api/health reports dbConnected: false) and
// the problem is logged plainly — previously a database that wasn't running
// at boot crashed the process with an unhandled AggregateError. A local
// portable Postgres (PG_BIN_DIR set, DATABASE_URL on localhost) is started
// automatically, so `npm run dev` alone is enough.
async function tryStartLocalDb() {
  try {
    console.log('[startup] starting local PostgreSQL (PG_BIN_DIR)…');
    const outcome = await startLocalDb();
    console.log(`[startup] local PostgreSQL ${outcome === 'running' ? 'was already running' : 'started'}`);
  } catch (err) {
    console.error(`[startup] could not start local PostgreSQL: ${err.message}`);
  }
}

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
      if (connectionHint(err) && isLocalDatabase() && (attempt - 1) % LOCAL_DB_START_EVERY === 0) {
        await tryStartLocalDb();
        continue;
      }
      await sleep(DB_RETRY_MS);
    }
  }
}

const server = app.listen(PORT, () => {
  console.log(`Nightbeacon API listening on port ${PORT}`);
  startWhenDatabaseReady();
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[startup] port ${PORT} is already in use — another Nightbeacon server is probably still running.`);
    console.error('[startup] Close that window (or stop it with Ctrl+C) and run npm run dev again.');
    process.exit(1);
  }
  throw err;
});
