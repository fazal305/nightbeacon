-- Scheduled summary posts ("digests"): a roundup of the biggest stories since
-- the previous one, posted at fixed local times per channel (see
-- publishing/digest.js). A digest isn't tied to one report, so raw_item_id
-- becomes optional; each digest is identified by its channel + time slot.
ALTER TABLE publications ALTER COLUMN raw_item_id DROP NOT NULL;
ALTER TABLE publications
  ADD COLUMN kind        text NOT NULL DEFAULT 'post' CHECK (kind IN ('post', 'digest')),
  ADD COLUMN digest_slot timestamptz,
  ADD CONSTRAINT publication_kind_shape CHECK (
    (kind = 'post' AND raw_item_id IS NOT NULL) OR (kind = 'digest' AND digest_slot IS NOT NULL));
CREATE UNIQUE INDEX uq_publication_digest_slot ON publications (channel_key, digest_slot) WHERE kind = 'digest';
