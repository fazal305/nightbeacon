# Nightbeacon

A single-operator OSINT dashboard for monitoring public Telegram channels:
scheduled polling, automated translation, and classification, presented in a
live analyst feed.

> This repository is currently **private**.

## Overview

Nightbeacon tracks a curated list of public Telegram channels, polls them on
a schedule, stores raw posts immutably, translates non-English content, and
gives one analyst a filterable feed to triage incoming information — without
manually checking every channel. It is not a social network, generic
Telegram client, or multi-tenant SaaS product.

## Status

**Live.** Real Telegram ingestion, translation, and classification are
running end to end. Started with the Middle East Spectator channel (100
real messages), then expanded to 445 channels resolved from eight
operator-provided Telegram chat-folder invite links (read-only resolution
via `chatlists.CheckChatlistInvite` — never joins anything; re-run
`npm run seed:sources-bulk` any time to add more folders, it's idempotent).
Pruned to **424 channels** after identifying 18 that were pure relays —
different accounts (official local branches, "mirror" backups) reposting
≥80% identical content, confirmed by comparing real ingested post text
across channel pairs rather than guessing from names — see
`docs/POLLING.md`.
At this scale a full poll cycle covers a large, realistic backlog
(12,000+ real items and growing) — translation/classification work through
it continuously in the background rather than all at once; see
[`docs/POLLING.md`](docs/POLLING.md) for the flood-wait-safe throttling
this required.

## Features

- Adaptive, flood-wait-aware Telegram polling (GramJS/MTProto) with gap
  backfill and push updates for joined channels — see [`docs/PIPELINE.md`](docs/PIPELINE.md)
- Duplicate detection **before** translation: exact, fuzzy, and optional
  cross-language semantic matching (local multilingual embeddings) groups
  relays into stories; reports with new figures are kept as story updates
- Publishing: drafts in each of your channels' own style (one LLM call for
  all channels); the bot posts approved drafts to the channel it admins at a
  ban-safe pace, other channels get Copy + Mark as sent — see [`docs/PUBLISHING.md`](docs/PUBLISHING.md)
- Per-stage latency, queue depth and ingestion health metrics
  (`/api/pipeline/metrics`, Live Monitor's Pipeline panel)
- Crash-safe ingestion — see [`docs/POLLING.md`](docs/POLLING.md)
- Session-authenticated single-operator dashboard
- Real-time-refreshing feed with source/status filtering
- Live Monitor: a faster-refreshing (15s), priority-focused stream separate
  from the historical Dashboard, with a ticking "checked Ns ago" freshness
  indicator and a dismissible "N new items" banner instead of silently
  reordering the list under an analyst mid-read
- Content inspector: original text, translation, classification, retry
  attempt counts, and collapsible raw Telegram metadata for full provenance
- Dedicated Source Inspector page: reliability note, language, first-tracked
  date, real polling metrics, and a list of that source's recent items
- Real Settings page (language switcher with full Arabic RTL translation,
  feed refresh interval, default-filter persistence) — no fake toggles
- Genuine RTL support verified across every route: logical CSS properties
  (`border-e`, `ps-`/`pe-`) so borders/spacing flip correctly, directional
  arrows mirror, mobile drawer and sidebar both flip layout direction
- Offline detection, stale-data indicator, and a distinct "slow network"
  loading state (not just a generic spinner) on the feed
- Session expiration handled mid-use: a 401 on any query redirects to login
  with a clear explanation, not a silent broken feed
- Clean SEO/social metadata (`robots`, canonical, Open Graph, Twitter Card)
  and a private-dashboard-appropriate `noindex` directive
- Automated translation (Phase 2) — deterministic English-skip detection,
  pluggable LLM provider (Groq by default, OpenRouter as a fallback) for
  real translation, original text never overwritten on failure, visually
  distinct "Automated translation" provenance labeling
- Deterministic classification (Phase 3) — rule-based category/priority
  scoring and descriptive tags, with real database-level feed filtering by
  category and priority
- Operational Subsystems health (Phase 4) — every ingestion/translation/
  classification pipeline run is logged to `subsystem_status`; the dashboard
  health bar and Activity page read that table directly, nothing hardcoded

Alerts land in a later phase — see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md),
[`docs/DATABASE.md`](docs/DATABASE.md), and
[`docs/POLLING.md`](docs/POLLING.md) for the full design and the reasoning
behind it (advisory-lock concurrency control, transactional dedup, the
processing lifecycle state machine).

## Tech stack

See [`docs/STACK-MAP.md`](docs/STACK-MAP.md) for why each dependency exists.

React · Vite · Tailwind CSS · TanStack Query · Zustand · React Router ·
react-i18next · Node.js · Express · PostgreSQL (+ pg_trgm) · GramJS ·
Groq / OpenRouter

## Project structure

```
web/       React + Vite frontend
server/    Express API + ingestion/processing pipeline
db/        SQL migrations and seed scripts
deploy/    GCP provisioning + systemd/nginx deployment scripts
docs/      Architecture, database, API contract, security, deployment docs
```

## Local development

See [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

## Security

See [`SECURITY.md`](SECURITY.md) and [`docs/SECURITY.md`](docs/SECURITY.md).
Telegram session strings and API keys are never committed — only
`.env.example` placeholders are tracked.

## Limitations

- Alerts are not yet implemented.
- Only one channel is currently monitored; source management (add/edit from
  the UI) is deferred — sources are seeded via `npm run seed:source`.
- Deployment scripts are prepared (see `deploy/` and
  [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)) but not yet run against a live
  GCP account — the app currently runs locally only.
- The deterministic classifier is keyword-based and can false-positive on
  ambiguous phrasing (e.g. a press-conference story mentioning "attack" and
  "president" was scored Security Incident/High) — it's intentionally simple
  and transparent rather than a black box; tune `classificationRules.js` as
  real data surfaces patterns worth refining.

## Roadmap

See the Phase Plan in the architecture discussion for this project (Phases
2–8: translation, classification, operational subsystems, source/content
inspector polish, i18n/RTL, alerts, hardening and deployment).

## License

MIT — see [`LICENSE`](LICENSE).
