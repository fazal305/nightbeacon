# Deployment

**Status: planned, not yet executed.** This document will be updated with the
real, verified live URL once Phase 8 actually deploys the application — no
URL is claimed here until it's been checked to work.

## Target

A GCP Compute Engine VM, chosen because the backend holds a persistent
MTProto connection (GramJS) and runs scheduled cron jobs in-process — both
incompatible with serverless/edge platforms. PostgreSQL runs on the same VM
(or Cloud SQL, revisit at deployment time based on cost/complexity trade-off)
and is never exposed to the public internet.

## Planned shape

- One Compute Engine VM running the Express process (`server/`) via a process
  manager (e.g. `systemd` or `pm2`), reverse-proxied by `nginx` with TLS.
- The frontend (`web/`) built statically (`vite build`) and served either
  from the same VM/nginx or a separate static host — decided at deployment
  time.
- Firewall: only 443 (and 22 for admin) open; Postgres port not exposed
  externally.
- Secrets (`TELEGRAM_SESSION`, `OPENROUTER_API_KEY`, `SESSION_SECRET`,
  `DATABASE_URL`) set as VM environment variables / a secrets manager, never
  committed.

This section will be filled in with exact `gcloud` commands and the verified
live URL when Phase 8 is reached.
