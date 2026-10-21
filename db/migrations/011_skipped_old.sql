-- Untranslated posts too old to be worth translating (npm run translate:skip-old)
-- leave the translation queue with this status; the original text stays as is.
ALTER TABLE raw_items DROP CONSTRAINT IF EXISTS raw_items_status_check;
ALTER TABLE raw_items ADD CONSTRAINT raw_items_status_check CHECK (status IN (
  'new', 'translating', 'translated', 'failed_translation',
  'tagging', 'ready', 'failed_tagging', 'duplicate', 'skipped_old'
));
