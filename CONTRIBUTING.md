# Contributing

Nightbeacon is currently a single-operator project, not built for outside
contribution as a primary workflow — but issues and pull requests are
welcome.

## Before opening a PR

- Read `docs/ARCHITECTURE.md` and `docs/DATABASE.md` first — the polling and
  processing design in particular has non-obvious correctness requirements
  (see `docs/POLLING.md`).
- Keep changes small and vertical; this project deliberately avoids building
  speculative infrastructure ahead of a working feature.
- Never commit `.env`, session strings, or API keys. Only `.env.example`
  placeholders belong in the repository.

## Local setup

See `docs/DEVELOPMENT.md`.
