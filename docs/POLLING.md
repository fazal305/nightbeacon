# Polling Architecture

Nightbeacon ingests public Telegram channels via **scheduled polling** (GramJS/MTProto,
user session, read-only), not push updates or bot webhooks. This document is the
single source of truth for why the polling design is correct under crashes,
concurrency, and partial failure.

## State

Each row in `sources` tracks polling state for one channel:

- `last_seen_id` — highest `telegram_message_id` successfully persisted.
- `last_poll_at` / `last_success_at` — observability, not correctness-critical.
- `poll_error_count` / `last_error` — surfaced in the Sources UI.

## Correctness guarantees

1. **Duplicate prevention is a database constraint, not application logic.**
   `raw_items` has `UNIQUE (source_id, telegram_message_id)`. Every insert uses
   `INSERT ... ON CONFLICT (source_id, telegram_message_id) DO NOTHING`. Telegram
   message IDs are only unique *within* a channel, so the constraint is composite.

2. **Insert + `last_seen_id` update are one transaction.** `pollSource.js`
   wraps the batch insert and the `sources` update in a single `BEGIN`/`COMMIT`.
   If the process crashes between them, the transaction never commits — nothing
   is lost, and nothing is half-applied. The next poll simply re-fetches from the
   old `last_seen_id`; any messages already inserted are no-ops via the unique
   constraint.

3. **`last_seen_id` is computed as `MAX(telegram_message_id)` across the batch**,
   never "the last item returned by the API" — Telegram's ordering is not trusted.
   The update uses `GREATEST(last_seen_id, $maxId)` as an extra guard.

4. **Concurrency is prevented with a Postgres advisory lock**
   (`pg_try_advisory_lock`, keyed by a hash of the source's UUID), acquired before
   any Telegram call and released in a `finally` block. If a lock can't be
   acquired, that source is skipped for this tick, not queued or blocked. This is
   a database-level lock, so it stays correct if ingestion is later split into a
   separate worker process — no in-memory lock would survive that split safely.

5. **A small inter-source delay** (`POLL_INTER_SOURCE_DELAY_MS`, default 750ms)
   separates sequential per-source polls within a tick. With one source this
   doesn't matter; once the source count grows into the hundreds (Nightbeacon
   currently monitors 128 channels resolved from operator-provided Telegram
   chat-folder invite links), firing that many `getMessages` calls back-to-
   back on one MTProto connection risks Telegram's flood-wait rate limiting —
   which would then penalize every source, not just the ones polled late in
   the loop. The default poll schedule was widened from 2 to 5 minutes to
   give a full cycle across all sources enough headroom
   (`POLL_CRON_SCHEDULE`).
6. **Retries happen on the next scheduled tick**, not an immediate in-process
   retry loop. A failed poll increments `poll_error_count` and records
   `last_error`; it does not hammer Telegram. (A cooldown/backoff after N
   consecutive failures is a natural extension, not required for the single
   Phase-1 channel.)

## Failure scenarios

| Scenario | Behavior |
|---|---|
| Telegram request fails | Caught per-source; `last_error` + `poll_error_count` recorded; other sources unaffected. |
| Zero messages returned | No-op; `last_success_at` still updates (a healthy poll that found nothing is still healthy). |
| N messages returned | Batch-inserted transactionally, `last_seen_id` advances to the batch max. |
| Crash after insert, before `last_seen_id` update | Cannot happen — same transaction. |
| Duplicate message returned | No-op via the unique constraint. |
| Two poll ticks overlap for the same source | Second tick can't acquire the advisory lock, skips. |
| Channel becomes inaccessible | Caught as a Telegram API error; recorded, not retried immediately. |
| Telegram session expires | Caught, recorded distinctly; the ingestion subsystem should be visibly degraded (Phase 4) rather than silently retried forever. Recovery requires re-running `npm run telegram:login` and updating `TELEGRAM_SESSION`. |
| Database unavailable | The poll attempt fails outright (can't open a transaction); nothing partial was ever committed. |
| Translation provider unavailable | Does not touch ingestion — decoupled pipeline stage (see `docs/DATABASE.md` processing lifecycle). |

## A real flood-wait, and what actually caused it

At 442 real sources, 184 hit a genuine Telegram flood-wait (`A wait of ~64500
seconds is required (caused by contacts.ResolveUsername)` — ~18 hours) on
2026-09-22. Two contributing causes, both understood after the fact:

1. **`ResolveUsername` has its own, much stricter rate limit** than message
   fetching. It only runs once per username per process lifetime (GramJS
   caches the resolved entity afterward), but adding ~440 sources in two
   large batches meant ~440 first-time resolutions competing for that
   budget within a short window — the existing 750ms
   `POLL_INTER_SOURCE_DELAY_MS` throttle wasn't tuned with this
   Telegram-side method-specific limit in mind, only the general
   flood-wait risk on `getMessages` itself.
2. **Manual verification scripts compounded it.** Several one-off
   `pollSource`/`pollAllEnabledSources` invocations were run directly
   (outside the cron schedule) to verify behavior during development,
   stacking additional resolve attempts on top of the live server's own
   scheduled ticks. Operationally: avoid manually triggering extra poll
   attempts against the real Telegram account while the live server is
   already polling — the throttling is designed around one active poller,
   not two running concurrently.

No code changes were needed for this specific incident — it resolves on its
own once the wait period elapses, and already-resolved sources are
unaffected (GramJS's entity cache survives). If Nightbeacon grows well
beyond ~450 sources, revisit whether `ResolveUsername` calls need their own,
separate, more conservative pacing from `getMessages` calls.

## Source curation: removing redundant/relay channels

With 445 sources spanning overlapping Telegram chat-folder lists, some
channels turned out to be pure relays of another channel already
monitored — either explicitly labeled "mirror" backups, or different
official accounts (e.g. a group's separate city/battalion channels)
broadcasting identical centralized statements. Rather than guessing from
channel names, this was detected empirically from real ingested content:
for every pair of channels sharing ≥5 identical `raw_text` posts, computed
what fraction of *each* channel's own total content that shared set
represents. Only pairs where **both** channels were ≥80% overlapping with
each other specifically were treated as duplicates — a channel that shares
one viral/boilerplate post with many others doesn't qualify, only ones that
are almost entirely relaying the same content. For each duplicate pair, the
earlier-tracked channel was kept and the other removed (with its raw_items,
since the content is preserved via the surviving channel). 18 channels were
removed this way, from 445 down to 424. The 3 explicitly "mirror"-named
channels were included regardless of whether they cleared the statistical
threshold, since the account owner's own naming was already unambiguous
evidence.

This is a one-time manual analysis, not an automated pipeline stage —
`classify.js`/`translate.js` remain untouched by it. If the source list
grows again, the same method (compare real ingested content, not names) is
the reliable way to find genuine relays without risking removal of a
channel that merely shares one common announcement.

## Crash recovery for processing stages (not ingestion-specific, but related)

Ingestion itself is already crash-safe via the transactional insert (see
above). The translation/classification stages have an analogous concern:
their claim-in-progress statuses (`translating`, `tagging`) can be orphaned
if the process crashes or restarts mid-claim. Fixed via
`recoverOrphanedStatuses()`, run on every boot — see `docs/DATABASE.md`.

## Backfill

Not automated. A historical backfill is a manual, explicit operation (passing a
specific `minId`/`maxId` range) — never triggered automatically, since it could
pull unbounded volume without operator intent.

## Deleted messages

GramJS's `getMessages` only returns messages that currently exist. Nightbeacon
has no deletion-detection mechanism — a raw item, once collected, remains the
historical record even if later deleted upstream. This is treated as a feature
for OSINT use, not a gap to close.
