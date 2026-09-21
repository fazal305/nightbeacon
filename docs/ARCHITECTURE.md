# Architecture

Nightbeacon is a single-operator OSINT dashboard. It is intentionally **not**
multi-tenant, has no organizations/workspaces, and runs as one Express process
plus one Postgres database.

```
Telegram (public channels, read-only)
        |  GramJS (MTProto, user session)
        v
  node-cron poll job (per source, Postgres advisory-locked)
        |  INSERT ... ON CONFLICT DO NOTHING (dedup)
        v
   raw_items (Postgres)  -----------------------+
        |                                       |  subsystem_status
        v  translation job (OpenRouter)         |  written after every
   translations                                 |  run of every stage
        |                                       |  (Phase 4)
        v  classification job (rules + LLM)     |
   tags / item_tags / priority  -----------------+
        |
        v
   Express REST API (session-auth gated)
        |
        v  TanStack Query (polling / refetch)
        v
   React feed / inspector / dashboard
```

## Why one Express process, not a separate worker (v1)

- Single operator, one to a few channels, low message volume — no throughput
  reason to isolate ingestion into its own process.
- GramJS wants one persistent MTProto connection; keeping it in the same
  process that serves the API avoids managing two deployables for a workload
  this small.
- Failure isolation is achieved at the code level (try/catch per pipeline
  stage, `subsystem_status` recording), not the process level — sufficient
  because a stuck poll is async and can't block HTTP request handling.
- The concurrency design (Postgres advisory locks, not in-memory locks) means
  extracting a `worker/` process later requires no schema or locking changes —
  this is deliberately not a one-way door, just not needed yet.

## Processing lifecycle

See `docs/DATABASE.md` for the full `raw_items.status` state machine
(`new -> translating -> translated -> tagging -> ready`, with
`failed_translation` / `failed_tagging` side states). Each stage claims rows
via a conditional `UPDATE ... WHERE status = '<previous>' RETURNING`, so two
overlapping cron ticks for the same stage cannot double-process a row.

## Deployment target

Backend: a persistent-process host is required (GramJS holds a long-lived
MTProto connection, incompatible with serverless functions) — see
`docs/DEPLOYMENT.md` for the GCP Compute Engine plan. Frontend: a static Vite
build, served either from the same VM or a static host, talking to the API
over CORS.
