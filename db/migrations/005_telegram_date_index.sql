-- The main feed query (GET /api/items, no source filter) now sorts by
-- telegram_date DESC (when a post actually happened on Telegram), not id
-- (insertion/collection order) — with 400+ sources polling on staggered
-- cycles plus a historical backfill, those orderings diverge significantly.
-- The existing idx_raw_items_source_date only helps once a source_id filter
-- narrows the scan; the unfiltered global feed needs its own index.
CREATE INDEX idx_raw_items_telegram_date ON raw_items (telegram_date DESC, id DESC);
