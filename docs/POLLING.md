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

5. **Retries happen on the next scheduled tick**, not an immediate in-process
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

## Backfill

Not automated. A historical backfill is a manual, explicit operation (passing a
specific `minId`/`maxId` range) — never triggered automatically, since it could
pull unbounded volume without operator intent.

## Deleted messages

GramJS's `getMessages` only returns messages that currently exist. Nightbeacon
has no deletion-detection mechanism — a raw item, once collected, remains the
historical record even if later deleted upstream. This is treated as a feature
for OSINT use, not a gap to close.
