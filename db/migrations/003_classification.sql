-- Phase 3: deterministic classification.
--
-- category / priority live directly on raw_items (not a separate table) because
-- every item has exactly one of each and both are used for indexed feed
-- filtering — a join would cost more than it buys. Descriptive tags (which are
-- many-to-many) get their own tags/item_tags tables.
--
-- Deliberately NOT added here (see docs/ARCHITECTURE.md's product assessment):
-- severity and confidence. Both are speculative until real classified data
-- shows they're needed beyond category + priority.

ALTER TABLE raw_items
  ADD COLUMN category text,
  ADD COLUMN priority text CHECK (priority IN ('high', 'medium', 'low', 'informational'));

-- Feed filtering by category/priority (see docs/API-CONTRACT.md ?category=&priority=).
CREATE INDEX idx_raw_items_category ON raw_items (category);
CREATE INDEX idx_raw_items_priority ON raw_items (priority);

CREATE TABLE tags (
  id         bigserial PRIMARY KEY,
  name       text NOT NULL UNIQUE,
  type       text NOT NULL DEFAULT 'descriptive' CHECK (type IN ('category', 'descriptive')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE item_tags (
  raw_item_id bigint NOT NULL REFERENCES raw_items (id) ON DELETE CASCADE,
  tag_id      bigint NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  confidence  numeric,
  source      text NOT NULL DEFAULT 'rule' CHECK (source IN ('rule', 'llm')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (raw_item_id, tag_id)
);

-- Reverse lookup ("everything tagged X") and per-item tag listing.
CREATE INDEX idx_item_tags_tag_id ON item_tags (tag_id);
