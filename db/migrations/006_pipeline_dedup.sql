-- Pipeline overhaul: dedup-before-translation, stage timestamps for latency
-- measurement, persisted channel access hashes, adaptive per-source polling,
-- and explicit historical-gap tracking (live vs backfill ingestion).
-- See docs/PIPELINE.md for the design and the measurements behind it.

-- pg_trgm is a trusted contrib extension (PG13+), so the database owner can
-- create it without superuser. Used for fuzzy duplicate matching.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------- sources --
ALTER TABLE sources
  -- Persisted so a restart never needs contacts.ResolveUsername again (the
  -- method that flood-waited the account for ~18h; GramJS's StringSession
  -- does not persist its entity cache across restarts).
  ADD COLUMN telegram_access_hash  bigint,
  ADD COLUMN next_poll_at          timestamptz,
  ADD COLUMN poll_interval_seconds integer NOT NULL DEFAULT 120,
  ADD COLUMN last_message_at       timestamptz;

-- The scheduler's "which source is due next" query.
CREATE INDEX idx_sources_due ON sources (next_poll_at NULLS FIRST) WHERE enabled;

-- --------------------------------------------------------------- stories --
-- One row per distinct real-world report. Every raw_item that dedup decides
-- is "the same story" points here via raw_items.story_id; provenance (which
-- channel said it, when) stays on the raw_items rows themselves.
CREATE TABLE stories (
  id                 bigserial PRIMARY KEY,
  canonical_item_id  bigint NOT NULL,
  normalized_text    text NOT NULL,
  content_hash       text NOT NULL,
  numbers            text[] NOT NULL DEFAULT '{}',
  embedding          real[],
  embedding_model    text,
  first_seen_at      timestamptz NOT NULL,
  last_seen_at       timestamptz NOT NULL,
  item_count         integer NOT NULL DEFAULT 1,
  update_count       integer NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_stories_last_seen ON stories (last_seen_at DESC);
CREATE INDEX idx_stories_normalized_trgm ON stories USING gin (normalized_text gin_trgm_ops);

-- -------------------------------------------------------------- raw_items --
ALTER TABLE raw_items DROP CONSTRAINT IF EXISTS raw_items_status_check;
ALTER TABLE raw_items ADD CONSTRAINT raw_items_status_check CHECK (status IN (
  'new', 'translating', 'translated', 'failed_translation',
  'tagging', 'ready', 'failed_tagging', 'duplicate'
));

ALTER TABLE raw_items
  -- When the poller/live handler first saw the message (before the DB write).
  -- collected_at remains the commit time.
  ADD COLUMN observed_at     timestamptz,
  ADD COLUMN ingest_path     text NOT NULL DEFAULT 'poll' CHECK (ingest_path IN ('poll', 'live', 'backfill')),
  ADD COLUMN normalized_text text,
  ADD COLUMN content_hash    text,
  ADD COLUMN dedup_status    text NOT NULL DEFAULT 'pending'
                               CHECK (dedup_status IN ('pending', 'unique', 'duplicate', 'update', 'legacy')),
  ADD COLUMN dedup_method    text,
  ADD COLUMN dedup_score     real,
  ADD COLUMN story_id        bigint REFERENCES stories (id) ON DELETE SET NULL,
  ADD COLUMN dedup_at        timestamptz,
  ADD COLUMN translated_at   timestamptz,
  ADD COLUMN ready_at        timestamptz;

ALTER TABLE stories
  ADD CONSTRAINT fk_stories_canonical FOREIGN KEY (canonical_item_id) REFERENCES raw_items (id) ON DELETE CASCADE;

-- Rows that already went past 'new' before dedup existed are left alone
-- ('legacy'); rows still waiting for translation go through dedup first, so
-- the existing backlog stops paying for translating duplicates too.
UPDATE raw_items SET dedup_status = 'legacy' WHERE status <> 'new';

CREATE INDEX idx_raw_items_content_hash ON raw_items (content_hash, telegram_date DESC) WHERE content_hash IS NOT NULL;
CREATE INDEX idx_raw_items_story ON raw_items (story_id) WHERE story_id IS NOT NULL;
-- Work queues: small partial indexes so claim queries never scan the whole table.
CREATE INDEX idx_raw_items_dedup_queue ON raw_items (telegram_date DESC) WHERE dedup_status = 'pending';
CREATE INDEX idx_raw_items_translate_queue ON raw_items (telegram_date DESC)
  WHERE status IN ('new', 'failed_translation') AND dedup_status IN ('unique', 'update', 'legacy');
CREATE INDEX idx_raw_items_classify_queue ON raw_items (telegram_date DESC)
  WHERE status IN ('translated', 'failed_tagging');

-- --------------------------------------------------------- ingestion_gaps --
-- When a channel posts more than one poll batch between polls, the live
-- poller takes the newest batch immediately and records the skipped id range
-- here; the backfill worker fills it at lower priority. Nothing is silently
-- lost (previously those messages were skipped forever).
CREATE TABLE ingestion_gaps (
  id          bigserial PRIMARY KEY,
  source_id   uuid NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  -- Exclusive bounds: messages with min_id < id < max_id are missing.
  min_id      bigint NOT NULL,
  max_id      bigint NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  attempts    integer NOT NULL DEFAULT 0,
  last_error  text,
  CHECK (max_id > min_id)
);
CREATE INDEX idx_ingestion_gaps_open ON ingestion_gaps (created_at) WHERE completed_at IS NULL;

-- ------------------------------------------------------- subsystem_status --
ALTER TABLE subsystem_status DROP CONSTRAINT IF EXISTS subsystem_status_subsystem_name_check;
ALTER TABLE subsystem_status ADD CONSTRAINT subsystem_status_subsystem_name_check
  CHECK (subsystem_name IN ('ingestion', 'deduplication', 'translation', 'classification', 'backfill'));
