-- Phase 2: translations. raw_items.raw_text is never overwritten by this stage —
-- translation failure must never destroy the original source record.

CREATE TABLE translations (
  id               bigserial PRIMARY KEY,
  raw_item_id      bigint NOT NULL REFERENCES raw_items (id) ON DELETE CASCADE,
  source_language  text,
  target_language  text NOT NULL DEFAULT 'en',
  translated_text  text,
  model            text,
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'done', 'failed', 'skipped_same_language')),
  error_message    text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_translation_raw_item UNIQUE (raw_item_id)
);

-- A retry overwrites this single row via UPSERT (ON CONFLICT (raw_item_id) DO UPDATE),
-- never inserts a second one — one active translation per item.
