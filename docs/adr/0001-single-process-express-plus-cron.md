# ADR 0001: Ingestion and processing run inside the Express process

**Status:** Accepted (v1)

**Context:** Telegram polling and the processing pipeline (translation,
classification) need scheduled execution. A separate worker process is the
conventional "production" answer.

**Update (Oct 2026):** still a single process, but the cron jobs became continuous, non-overlapping worker loops — see `docs/PIPELINE.md`.

**Decision:** Run `node-cron` jobs inside the same Express process that
serves the API, for v1.

**Reasoning:** single operator, one-to-a-few channels, low volume — no
throughput case for isolation. GramJS wants one persistent MTProto
connection; one process is simpler to deploy/monitor/restart than two.
Concurrency safety uses Postgres advisory locks (not in-memory locks), so
extracting a `worker/` process later is a deployment change, not a
correctness rewrite.

**Consequences:** if ingestion volume or translation load grows
significantly, splitting `ingestion/` and `processing/` into a separate
`worker/` entrypoint sharing the same `db/` package is the natural next
step — deferred until there's a concrete reason.
