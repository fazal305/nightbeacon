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

## Features (Phase 1)

- Scheduled, deduplicated Telegram channel polling (GramJS/MTProto)
- Crash-safe ingestion — see [`docs/POLLING.md`](docs/POLLING.md)
- Session-authenticated single-operator dashboard
- Real-time-refreshing feed with source/status filtering
- Content inspector showing original source text and processing status
- Source inspector with real polling metrics (no hardcoded numbers)

Translation, classification/tagging, alerts, and the operational-subsystems
health panel land in later phases — see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md),
[`docs/DATABASE.md`](docs/DATABASE.md), and
[`docs/POLLING.md`](docs/POLLING.md) for the full design and the reasoning
behind it (advisory-lock concurrency control, transactional dedup, the
processing lifecycle state machine).

## Tech stack

See [`docs/STACK-MAP.md`](docs/STACK-MAP.md) for why each dependency exists.

React · Vite · Tailwind CSS · TanStack Query · Zustand · React Router ·
react-i18next · Node.js · Express · PostgreSQL · GramJS · node-cron ·
OpenRouter

## Project structure

```
web/       React + Vite frontend
server/    Express API + ingestion/processing pipeline
db/        SQL migrations and seed scripts
docs/      Architecture, database, API contract, security, deployment docs
```

## Local development

See [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

## Security

See [`SECURITY.md`](SECURITY.md) and [`docs/SECURITY.md`](docs/SECURITY.md).
Telegram session strings and API keys are never committed — only
`.env.example` placeholders are tracked.

## Limitations (Phase 1)

- Translation, tagging, and alerts are not yet implemented.
- Only one channel is currently monitored (seeded via `npm run seed:source`).
- No production deployment yet — see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Roadmap

See the Phase Plan in the architecture discussion for this project (Phases
2–8: translation, classification, operational subsystems, source/content
inspector polish, i18n/RTL, alerts, hardening and deployment).

## License

MIT — see [`LICENSE`](LICENSE).
