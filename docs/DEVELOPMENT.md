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

```bash
cd server && npm test
```
