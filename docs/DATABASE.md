# Database Design

PostgreSQL only (no MySQL support). Migrations are plain SQL files in
`db/migrations/`, applied in filename order and tracked in a
`schema_migrations` table by `server/src/db/migrate.js` — no ORM, since the
schema is small and explicit SQL keeps the constraints (the actual correctness
mechanism) visible and reviewable.

## Phase 1 tables

### `sources`
One row per monitored Telegram channel. `UNIQUE(channel_username)`.
Polling state (`last_seen_id`, `last_poll_at`, `last_success_at`, `last_error`,
`poll_error_count`) lives here — see `docs/POLLING.md`. A source is disabled
via `enabled = false`, never hard-deleted while it has `raw_items` (FK
`ON DELETE RESTRICT`).

### `raw_items`
The immutable source-of-truth record. Write-once except for `status` and the
retry-attempt counters.

- `UNIQUE (source_id, telegram_message_id)` — the dedup boundary. Telegram
  message IDs are only unique within a channel, hence the composite key.
- `raw_metadata jsonb` stores the full raw Telegram message object from day
  one, even before anything reads specific fields from it — OSINT tooling
  regularly needs a field nobody anticipated (forwarded-from, view count,
  reply-to), and it can't be backfilled once a message is gone upstream.
- `status` is a single enum column (see Processing Lifecycle below), not
  several boolean flags — the states are strictly sequential and mutually
  exclusive, so separate booleans would only create combinations that are
  logically impossible to reach.

Indexes:
- `idx_raw_items_status` — the tagging/translation claim queries and status
  filters both hit this.
- `idx_raw_items_collected_at` (`DESC`) — the default feed ordering.
- `idx_raw_items_source_date` (`source_id, telegram_date DESC`) — per-source
  recency, used by the Source Inspector and per-source feed filtering.

### `users` / `session`
Single operator credential (bcrypt hash) and a server-side session store
table matching `connect-pg-simple`'s expected schema (httpOnly cookie, not a
bare JWT — see `docs/SECURITY.md`).

## `translations` (Phase 2)

`raw_item_id` FK, `UNIQUE(raw_item_id)` — a retry does `ON CONFLICT (raw_item_id)
DO UPDATE`, overwriting this row, never touching `raw_items.raw_text`.
`status`: `pending` / `done` / `failed` / `skipped_same_language` (the last
covers both "already English" and "no text to translate", decided
deterministically by `detectLanguage.js` — a script-detection regex, not an
LLM call, per the project's "prefer deterministic rules" principle). The
translation job claims rows with `FOR UPDATE SKIP LOCKED` from
`raw_items WHERE status = 'new' OR (status = 'failed_translation' AND
translation_attempts < 5)`, batches 5 per tick to stay under OpenRouter's
free-tier rate limit, and a failed translation increments
`translation_attempts` and leaves `raw_items.raw_text` completely untouched.

## Classification (Phase 3)

`raw_items.category` and `raw_items.priority` live directly on the row (not
a join) since every item has exactly one of each and both need indexed feed
filtering. `tags` / `item_tags` are separate many-to-many tables for
descriptive tags; `item_tags.source` (`rule`/`llm`) lets the UI distinguish
deterministic from LLM-suggested classification, per the provenance
requirement (never present generated output as verified fact — see
`docs/ARCHITECTURE.md`'s product assessment on why severity/confidence were
deliberately deferred rather than added speculatively).

Classification is entirely rule-based (`classificationRules.js` — keyword
lists, no LLM call) per the project's principle: prefer deterministic rules
where they're reliable, reserve the LLM for translation where it earns its
keep. The classification job claims `translated` (or retriable
`failed_tagging`) rows with `FOR UPDATE SKIP LOCKED`, same pattern as
translation.

## Tables added in later phases (schema already designed, not yet created)

- **`alerts`** — includes a `reason` column so every alert is explainable.
- **`subsystem_status`** — append-only run log (one row per pipeline run, not
  one row overwritten per subsystem), so Activity can show history and
  "current health" is just the latest row per `subsystem_name`.

## Processing lifecycle (`raw_items.status`)

```
new -> translating -> translated -> tagging -> ready
              \-> failed_translation      \-> failed_tagging
```

Each stage claims a batch via
`UPDATE raw_items SET status = 'translating' WHERE status = 'new' ... RETURNING`
so two overlapping cron ticks for the same stage can't double-process a row.
Failure states never block the item from appearing in the feed — the UI shows
original text with a "translation failed" badge. Retries operate purely on
`status` + the `translations`/`item_tags` tables and never re-trigger a
Telegram fetch — ingestion and processing are fully decoupled.

## Relationships

```
sources 1---* raw_items 1---1 translations
                   |
                   *---* item_tags *---1 tags
                   |
                   1---* alerts

subsystem_status  (independent — operational log)
users 1---* session
```
