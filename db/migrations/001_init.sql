-- Phase 1 schema: sources, raw_items, auth (users, sessions).
-- Translations, tags, item_tags, alerts, subsystem_status are created in later phases
-- (their columns are already designed in docs/DATABASE.md, but we don't create tables
-- before a phase actually needs them).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE sources (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_username    text NOT NULL UNIQUE,
  telegram_channel_id bigint,
  display_name        text NOT NULL,
  description         text,
  reliability_note    text,
  language            text,
  enabled             boolean NOT NULL DEFAULT true,
  first_tracked_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_id        bigint NOT NULL DEFAULT 0,
  last_poll_at        timestamptz,
  last_success_at     timestamptz,
  last_error          text,
  poll_error_count    integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_sources_enabled ON sources (enabled);

CREATE TABLE raw_items (
  id                    bigserial PRIMARY KEY,
  source_id             uuid NOT NULL REFERENCES sources (id) ON DELETE RESTRICT,
  telegram_message_id   bigint NOT NULL,
  telegram_date         timestamptz NOT NULL,
  collected_at          timestamptz NOT NULL DEFAULT now(),
  raw_text              text,
  raw_metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  has_media             boolean NOT NULL DEFAULT false,
  status                text NOT NULL DEFAULT 'new'
                          CHECK (status IN (
                            'new', 'translating', 'translated', 'failed_translation',
                            'tagging', 'ready', 'failed_tagging'
                          )),
  translation_attempts  integer NOT NULL DEFAULT 0,
  tagging_attempts      integer NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_source_message UNIQUE (source_id, telegram_message_id)
);

-- Feed queries filter by status and order by recency within a source, and across all sources.
CREATE INDEX idx_raw_items_status ON raw_items (status);
CREATE INDEX idx_raw_items_collected_at ON raw_items (collected_at DESC);
CREATE INDEX idx_raw_items_source_date ON raw_items (source_id, telegram_date DESC);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Session store table matching connect-pg-simple's expected schema.
CREATE TABLE "session" (
  "sid"    varchar NOT NULL COLLATE "default" PRIMARY KEY,
  "sess"   json NOT NULL,
  "expire" timestamp(6) NOT NULL
);
CREATE INDEX idx_session_expire ON "session" ("expire");
