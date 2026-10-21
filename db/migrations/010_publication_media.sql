-- What happened to the source's photos/videos when a post was sent: how many
-- went out with it, and why a post went out as text only (shown on the
-- Publishing page).
ALTER TABLE publications
  ADD COLUMN media_count integer,
  ADD COLUMN media_note  text;
