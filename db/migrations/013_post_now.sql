-- "Post now" is the only way past a channel's hourly limit (besides scheduled
-- summaries); posts you approve wait for a free slot like automatic ones,
-- first in line.
ALTER TABLE publications ADD COLUMN post_now boolean NOT NULL DEFAULT false;
UPDATE publications SET post_now = true WHERE status = 'approved' AND origin = 'manual' AND approved_at < now() - interval '20 hours';
