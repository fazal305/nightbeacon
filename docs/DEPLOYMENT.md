# Deployment

**Status: scripts are ready and reviewed, not yet run against a real GCP
account.** This document will be updated with the real, verified live URL
once the VM is actually provisioned and checked to work — no URL is claimed
here until it's been verified.

## Target

A GCP Compute Engine VM (`e2-small`, Debian 12), chosen because the backend
holds a persistent MTProto connection (GramJS) and runs scheduled cron jobs
in-process — both incompatible with serverless/edge platforms. PostgreSQL
runs natively on the same VM (not Cloud SQL — for a single-operator, low-
volume app, Cloud SQL's minimum cost isn't justified, and this app already
handles its own migrations/backups simply). Postgres is never exposed to the
public internet — only reachable from `localhost` on the VM itself.

## Shape

```
Internet (443) → nginx (TLS via certbot) → Express (127.0.0.1:4000, systemd)
                       │                          │
                       └─ static web/dist          └─ Postgres (127.0.0.1:5432)
```

- One VM running the Express process via `systemd` (not `pm2` — no extra
  npm dependency, integrates with `journalctl` for logs, restarts on crash).
- The frontend is a static `vite build` output served directly by nginx from
  the same VM (no separate static host — one VM is simpler to operate for
  this scale, and nginx already needs to run for the reverse proxy anyway).
- Firewall: only 443/80 (80 required for Let's Encrypt's HTTP-01 challenge)
  and 22 — and 22 is restricted to the operator's own IP, not open to the
  internet. Postgres (5432) and the raw Express port (4000) are never opened
  in the firewall at all; nginx reverse-proxies to Express over localhost.
- Secrets (`TELEGRAM_SESSION`, `OPENROUTER_API_KEY`, `SESSION_SECRET`,
  `DATABASE_URL`, etc.) live only in `server/.env` on the VM, loaded by
  systemd's `EnvironmentFile=` — never committed, never passed as CLI args
  (which would leak into `ps` output).

## Scripts

All in `deploy/`, meant to run in order:

1. **`01-gcloud-provision.sh`** — run **locally** with `gcloud` authenticated
   to your GCP account. Creates the VM and firewall rules. Requires
   `PROJECT_ID` and `SSH_SOURCE_IP` (your own public IP) as env vars; this is
   the only script that touches billing/infrastructure.
2. **`02-setup-vm.sh`** — run **on the VM** once, after getting the repo onto
   it (`git clone` with a short-lived fine-grained PAT since the repo is
   private, or `gcloud compute scp --recurse`). Installs Node.js 20,
   PostgreSQL, nginx, certbot, creates the `nightbeacon` system user and
   database role, and prints the generated DB password (put it straight into
   `server/.env`, don't leave it in your terminal scrollback longer than
   needed).
3. **`03-deploy.sh`** — run **on the VM**, from the repo root, after
   `server/.env` is filled in (copy from `.env.example`, and set
   `NODE_ENV=production` — the session cookie's `Secure` flag depends on it).
   Installs dependencies, runs migrations, builds the frontend, installs the
   `systemd` service and `nginx` config, and restarts both. Safe to re-run
   for subsequent deploys (it does a `git pull` first).
4. **TLS**: once your domain's DNS A record points at the VM's external IP,
   run `sudo certbot --nginx -d your-domain.example` on the VM. Certbot
   rewrites the nginx config to add the HTTPS server block and redirect.

## What's not done yet

- No GCP project has actually been provisioned — these scripts are ready to
  run once there's account access.
- Telegram ingestion needs `TELEGRAM_SESSION` generated first (see
  `docs/DEVELOPMENT.md`) — do this locally before deploying, then copy the
  session string into the VM's `server/.env` (never regenerate it via a
  script that could log it).
- Domain/DNS is not yet chosen — `nginx-nightbeacon.conf` ships with
  `server_name _;` (catch-all) until one is picked.
