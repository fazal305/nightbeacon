import { recordRun } from '../subsystems/recordRun.js';
import { onTelegramClient, requestGate, resolveGate } from './telegramClient.js';
import { nextDueSource, pollSource } from './pollSource.js';
import { runBackfillStep } from './backfill.js';
import { startLiveUpdates } from './liveUpdates.js';
import { sleep } from '../pipeline/rateGate.js';

// Continuous ingestion loop, replacing the old "poll all 424 sources every 5
// minutes" cron job. That job was the main source of feed latency:
//   - a full sequential pass took longer than its own 5-minute interval
//     (424 × (750ms spacing + request round-trip through the proxy)), and
//     node-cron started the next pass on top of the running one, so two
//     passes hit Telegram concurrently;
//   - every channel waited a full pass between polls regardless of activity.
// Now one request at a time goes to whichever source is most overdue
// (adaptive per-source intervals, see pollSource.js), at the same overall
// request rate as before. Backfill of recorded gaps only gets a request
// when no live poll is due, plus a small guaranteed share so it can't starve.

const IDLE_MS = 1000;
const BACKFILL_SHARE = Number(process.env.BACKFILL_EVERY_N_POLLS || 10);
const FLUSH_MS = 60_000;

export const schedulerStats = {
  startedAt: null,
  polls: 0,
  pollErrors: 0,
  backfillSteps: 0,
  lastPollAt: null,
  lastSuccessfulPollAt: null,
};

export function startIngestionScheduler() {
  schedulerStats.startedAt = new Date().toISOString();
  let pending = [];
  let lastFlush = Date.now();
  let sinceBackfill = 0;

  async function flush(force) {
    if (!force && Date.now() - lastFlush < FLUSH_MS) return;
    const batch = pending;
    pending = [];
    lastFlush = Date.now();
    await recordRun('ingestion', async () => batch).catch((err) =>
      console.error('[ingestion] failed to record run:', err.message)
    );
    const inserted = batch.reduce((n, r) => n + (r.inserted || 0), 0);
    if (batch.length > 0) console.log(`[ingestion] last minute: ${batch.length} poll(s), ${inserted} new item(s)`);
  }

  // Live updates are registered on whichever client is active — at first
  // connect, and again after every proxy failover (the old client's handlers
  // die with it). The connection itself is opened by the first poll.
  onTelegramClient((client) => startLiveUpdates(client));

  (async () => {
    for (;;) {
      try {
        await flush(false);
        if (requestGate.isPaused()) {
          await sleep(Math.min(5000, requestGate.pausedUntil - Date.now()));
          continue;
        }

        const forceBackfill = sinceBackfill >= BACKFILL_SHARE;
        const source = forceBackfill ? null : await nextDueSource({ resolvedOnly: resolveGate.isPaused() });
        if (source) {
          sinceBackfill++;
          schedulerStats.polls++;
          schedulerStats.lastPollAt = new Date().toISOString();
          try {
            const r = await pollSource(source);
            if (!r.skipped) schedulerStats.lastSuccessfulPollAt = new Date().toISOString();
            pending.push({ sourceId: source.id, ...r, outcome: 'success' });
          } catch (err) {
            schedulerStats.pollErrors++;
            pending.push({ sourceId: source.id, outcome: 'failed', error: err.message });
          }
          continue;
        }

        sinceBackfill = 0;
        const didBackfill = await runBackfillStep();
        if (didBackfill) {
          schedulerStats.backfillSteps++;
          continue;
        }
        if (!forceBackfill) await sleep(IDLE_MS);
      } catch (err) {
        // DB unavailable etc. — never let the loop die.
        console.error('[ingestion] scheduler error:', err.message);
        await sleep(5000);
      }
    }
  })();
}
