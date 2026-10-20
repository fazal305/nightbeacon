# Local Development

## Prerequisites

- Node.js 20+
- PostgreSQL 17 (local install; see `docs/DEPLOYMENT.md` for production)
- A Telegram API ID/hash from https://my.telegram.org

## Setup

```bash
cp .env.example .env
# fill in DATABASE_URL, TELEGRAM_API_ID, TELEGRAM_API_HASH, SESSION_SECRET,
# OPERATOR_USERNAME, OPERATOR_PASSWORD

createdb nightbeacon   # or use pgAdmin / psql

cd server && npm install
npm run migrate
npm run seed:operator
npm run seed:source

cd ../web && npm install
```

## Telegram proxy (optional)

If Telegram is blocked on your network, set a proxy in `.env` before running
the login script or the server — both the login script and the runtime
ingestion client read the same config (`server/src/ingestion/proxyConfig.js`):

```bash
# SOCKS5 proxy
TELEGRAM_PROXY_IP=203.0.113.5
TELEGRAM_PROXY_PORT=1080
TELEGRAM_PROXY_SOCKS_TYPE=5
# optional: TELEGRAM_PROXY_USERNAME / TELEGRAM_PROXY_PASSWORD
```

or an MTProxy (`TELEGRAM_PROXY_SECRET` instead of a SOCKS type). Leave all
`TELEGRAM_PROXY_*` vars empty to connect directly, no proxy.

```bash
# MTProxy — copy server/port/secret from the tg://proxy?server=…&port=…&secret=… link
TELEGRAM_PROXY_IP=proxy.example.com
TELEGRAM_PROXY_PORT=443
TELEGRAM_PROXY_SECRET=ee0123456789abcdef0123456789abcdef7777772e676f6f676c652e636f6d
```

All three MTProxy secret types work: plain (32 hex), `dd…` (padded) and
`ee…` (Fake-TLS — the hex after the first 32 key characters is the disguise
domain). GramJS itself has no Fake-TLS support, so `ee` secrets go through
Nightbeacon's own transport (`server/src/ingestion/fakeTlsConnection.js`).
Hex and base64 secrets are both accepted.

### Several proxies with automatic failover

Free/public MTProxies die often, so you can give Nightbeacon a whole list.
Put the share links (`https://t.me/proxy?…`, `tg://proxy?…`, `https://t.me/socks?…`)
in `server/.env`, comma-separated:

```bash
TELEGRAM_PROXY_LINKS=https://t.me/proxy?server=…&port=443&secret=ee…,https://t.me/proxy?server=…
```

or one per line in a file (`#` comments allowed; `proxies.txt` is gitignored):

```bash
TELEGRAM_PROXY_LINKS_FILE=proxies.txt
```

Routes are tried in order at startup; the first one that completes a real
Telegram request is used. If `TELEGRAM_PROXY_FAILOVER_AFTER` (3) requests in
a row get no answer, Nightbeacon drops that route and moves to the next.
Every Telegram request has a timeout (`TELEGRAM_REQUEST_TIMEOUT_MS`), so a
dead proxy can't freeze polling. The active route and the failover count
are shown in Live Monitor's Pipeline panel.

### Test the routes

No login needed — for each route it does a real MTProto key exchange and
one request, 6 routes at a time:

```bash
cd server
npm run telegram:check-proxy                     # routes from .env
npm run telegram:check-proxy -- proxies.txt      # or a file of links
```

It prints the working routes fastest first and a ready-to-paste
`TELEGRAM_PROXY_LINKS=` line.

Fake-TLS proxies reject handshakes whose timestamp is more than a few
seconds off, so keep the server clock synced (NTP — on by default on GCP
VMs). A "proxy closed the connection during the TLS handshake" error almost
always means a wrong secret or a skewed clock.

## Telegram session (one-time, interactive)

```bash
cd server
npm run telegram:login
```

Follow the prompts (phone number, login code, 2FA password if set). Copy the
printed session string into `.env` as `TELEGRAM_SESSION`. Never commit it.

## Running

```bash
# terminal 1
cd server && npm run dev

# terminal 2
cd web && npm run dev
```

Frontend: http://localhost:5173 (proxies `/api` to the backend on port 4000).

## Tests

Tests run against a **separate database** from your dev `DATABASE_URL` —
never against a database that might hold real ingested data (a 128-channel
backlog crowding out a test's own rows in a claim query is exactly the kind
of flaky failure this avoids). One-time setup:

```bash
createdb nightbeacon_test
cd server
echo "DATABASE_URL=postgres://nightbeacon:<password>@localhost:5432/nightbeacon_test" > .env.test
DATABASE_URL=postgres://nightbeacon:<password>@localhost:5432/nightbeacon_test node src/db/migrate.js
```

Then just:

```bash
cd server && npm test
```

(`npm test` preloads `.env.test` via `--import ./src/testSetup.mjs`, so it
always targets the test database regardless of what `.env` points at.)
