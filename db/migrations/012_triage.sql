-- Classify-before-translate: the priority guessed from the ORIGINAL text, and
-- whether translation was skipped because it fell below the bar
-- (TRANSLATE_MIN_PRIORITY). Skipped posts go straight to 'ready', original only.
ALTER TABLE raw_items
  ADD COLUMN triage_priority     text CHECK (triage_priority IN ('high', 'medium', 'low', 'informational')),
  ADD COLUMN translation_skipped boolean NOT NULL DEFAULT false;
