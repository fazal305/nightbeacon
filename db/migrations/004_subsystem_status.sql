-- Phase 4: operational subsystem health, as an append-only run log — one row
-- per pipeline run, not one row overwritten per subsystem. "Current health"
-- is just the latest row per subsystem_name; Activity reads the full history.

CREATE TABLE subsystem_status (
  id               bigserial PRIMARY KEY,
  subsystem_name   text NOT NULL CHECK (subsystem_name IN ('ingestion', 'translation', 'classification')),
  status           text NOT NULL CHECK (status IN ('success', 'degraded', 'failed')),
  started_at       timestamptz NOT NULL,
  completed_at     timestamptz NOT NULL,
  duration_ms      integer NOT NULL,
  processed_count  integer NOT NULL DEFAULT 0,
  error_count      integer NOT NULL DEFAULT 0,
  last_error       text,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- "Current health" query: latest row per subsystem. Activity's reverse-chronological
-- history scan uses the PK order directly (see idx below).
CREATE INDEX idx_subsystem_status_name_started ON subsystem_status (subsystem_name, started_at DESC);
CREATE INDEX idx_subsystem_status_started ON subsystem_status (started_at DESC);
