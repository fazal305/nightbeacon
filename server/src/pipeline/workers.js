import { recordRun } from '../subsystems/recordRun.js';
import { runDedupTick } from '../dedup/dedupWorker.js';
import { runTranslationTick } from '../processing/translate.js';
import { runClassificationTick } from '../processing/classify.js';
import { startIngestionScheduler } from '../ingestion/scheduler.js';
import { runDraftingTick } from '../publishing/drafter.js';
import { runPublishingTick } from '../publishing/sender.js';
import { sleep } from './rateGate.js';

// Each stage is an independent, non-overlapping loop over a persistent queue
// (raw_items status/dedup_status columns): it works continuously while its
// queue has items and idles briefly when empty. This replaces the previous
// node-cron jobs, which (a) only ran once a minute regardless of backlog and
// (b) used node-cron's default noOverlap=false, so a slow tick could run
// concurrently with the next one — for ingestion that meant two full poll
// cycles hitting Telegram at once.
//
// Ingestion never waits on any of these: a slow translation provider only
// grows the translation queue, it can't delay new posts reaching the DB.

const HEARTBEAT_MS = 60_000;
const SYSTEMIC_BACKOFF_MS = Number(process.env.PIPELINE_SYSTEMIC_BACKOFF_MS || 60_000);
const loops = [];

function startWorker(name, tick, { idleMs }) {
  const state = { name, running: true, lastRecorded: 0, lastTickAt: null, lastProcessed: 0 };
  loops.push(state);

  (async () => {
    while (state.running) {
      let results = [];
      try {
        const recordEmpty = Date.now() - state.lastRecorded >= HEARTBEAT_MS;
        results = await recordRun(name, tick, { recordEmpty });
        if (recordEmpty || results.length > 0) state.lastRecorded = Date.now();
        state.lastTickAt = new Date().toISOString();
        state.lastProcessed = results.length;
        if (results.length > 0) {
          const counts = {};
          for (const r of results) counts[r.outcome] = (counts[r.outcome] || 0) + 1;
          console.log(`[${name}] ${results.length} item(s) — ${JSON.stringify(counts)}`);
        }
      } catch (err) {
        console.error(`[${name}] tick failed:`, err.message);
        await sleep(idleMs * 5);
        continue;
      }
      // A systemic failure (provider quota / flood-wait) put its items back;
      // retrying immediately would just fail again.
      if (results.some((r) => r.systemic)) await sleep(SYSTEMIC_BACKOFF_MS);
      else if (results.length === 0) await sleep(idleMs);
    }
  })();
}

export function startPipeline() {
  startIngestionScheduler();
  startWorker('deduplication', runDedupTick, { idleMs: 1000 });
  startWorker('translation', runTranslationTick, { idleMs: 2000 });
  startWorker('classification', runClassificationTick, { idleMs: 1000 });
  // Publishing: drafts (automatic per PUBLISH_MODE, or requested from the
  // dashboard) and the paced bot sender. Both idle cheaply when unused.
  startWorker('drafting', runDraftingTick, { idleMs: 5000 });
  startWorker('publishing', runPublishingTick, { idleMs: 3000 });
  console.log('[pipeline] ingestion scheduler + dedup/translation/classification/drafting/publishing workers started');
}

export function workerStates() {
  return loops.map(({ name, lastTickAt, lastProcessed }) => ({ name, lastTickAt, lastProcessed }));
}
