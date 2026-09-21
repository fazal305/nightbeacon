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
