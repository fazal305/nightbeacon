-- Publishing: posts for the operator's own Telegram channels, written by the
-- LLM in each channel's style from processed stories. One row per (report,
-- channel). Channels with delivery "bot" are sent by the bot after approval
-- (or auto-approval); "manual" channels are copied and posted by hand, then
-- marked as sent. Channels are configured in server/publish-channels.json.
-- See docs/PUBLISHING.md.

CREATE TABLE publications (
  id                  bigserial PRIMARY KEY,
  raw_item_id         bigint NOT NULL REFERENCES raw_items (id) ON DELETE CASCADE,
  story_id            bigint REFERENCES stories (id) ON DELETE SET NULL,
  channel_key         text NOT NULL,
  -- requested: operator asked for a draft; drafting: claimed by the drafter;
  -- draft: waiting for review; approved: queued for the bot; sending: claimed
  -- by the sender; published (by the bot) / sent_manually (copied and posted
  -- by hand) / rejected / failed / expired: final.
  status              text NOT NULL DEFAULT 'requested'
                        CHECK (status IN ('requested', 'drafting', 'draft', 'approved', 'sending',
                                          'published', 'sent_manually', 'rejected', 'failed', 'expired')),
  origin              text NOT NULL DEFAULT 'auto' CHECK (origin IN ('auto', 'manual')),
  draft_text          text,
  final_text          text,          -- what was / will be sent (operator edits land here)
  model               text,
  priority            text,
  attempts            integer NOT NULL DEFAULT 0,
  last_error          text,
  telegram_message_id bigint,
  created_at          timestamptz NOT NULL DEFAULT now(),
  drafted_at          timestamptz,
  approved_at         timestamptz,
  published_at        timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- One post per report per channel: a story's first report and each of its
  -- updates can each go to every channel once.
  CONSTRAINT uq_publication_item_channel UNIQUE (raw_item_id, channel_key)
);

CREATE INDEX idx_publications_status ON publications (status, created_at);
CREATE INDEX idx_publications_channel ON publications (channel_key, status);
CREATE INDEX idx_publications_story ON publications (story_id) WHERE story_id IS NOT NULL;

-- Small key/value store for runtime state that must survive restarts — e.g.
-- the bot's MTProto session (so it logs in once, not on every start).
CREATE TABLE app_state (
  key         text PRIMARY KEY,
  value       text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE subsystem_status DROP CONSTRAINT IF EXISTS subsystem_status_subsystem_name_check;
ALTER TABLE subsystem_status ADD CONSTRAINT subsystem_status_subsystem_name_check
  CHECK (subsystem_name IN ('ingestion', 'deduplication', 'translation', 'classification', 'backfill',
                            'drafting', 'publishing'));
