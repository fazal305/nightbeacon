-- Why a story was picked for automatic drafting (see publishing/drafter.js):
-- its score at selection time and a short human-readable breakdown.
ALTER TABLE publications
  ADD COLUMN score        real,
  ADD COLUMN score_detail text;
