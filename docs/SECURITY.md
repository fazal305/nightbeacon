# Security

## Reporting

Report security issues to **fazalabbas2002@gmail.com**. Do not open a public
issue for anything involving a live credential leak.

## Sensitive credentials

- `TELEGRAM_SESSION` — an MTProto user-session string. Treat as equivalent to
  full Telegram account access. Never committed, logged, printed outside the
  one-time `npm run telegram:login` output, or included in screenshots,
  README examples, or CI logs. Env var only.
- `OPENROUTER_API_KEY`, `DATABASE_URL`, `SESSION_SECRET` — same treatment.
- `.env` is git-ignored; only `.env.example` (placeholders) is committed.

## Known dependency risk

The `telegram` npm package (GramJS) is an **archived, unmaintained**
repository; development moved to `teleproto`, an actively maintained,
largely-compatible fork. We start with `telegram` (pinned to an exact
version) because MTProto itself is a stable protocol and GramJS is the more
widely documented implementation. This is a tracked risk, not an oversight —
revisit if GramJS breaks against a future Telegram API change, or migrate
proactively if `teleproto` proves stable. See the ADR in `docs/adr/`.

## Dependency audit

`npm audit --production` is clean (0 vulnerabilities) on both `server/` and
`web/` as of the last hardening pass. A moderate `uuid` vulnerability
(transitive via `node-cron`'s old `uuid` dependency) was fixed by upgrading
`node-cron` to 4.x — verified as a safe upgrade for this project's usage
(`cron.schedule(pattern, fn)` only, no removed options). Re-run
`npm audit --production` periodically; don't force-upgrade majors without a
concrete vulnerability, since that risks destabilizing working code for no
security benefit.

## Session handling

A 401 from any authenticated endpoint (not just the initial session check)
is treated as "session expired mid-use" — `api.js` dispatches a
`nightbeacon:session-expired` event, which `App.jsx` catches to mark the
shared session state unauthenticated. `ProtectedRoute` then redirects to
`/login` with a clear "Your session expired" message, rather than each
query silently failing with a generic error. Verified by invalidating the
session server-side while mid-session and confirming the redirect + message
(not just testing a fresh page load, which follows a different, simpler
"never logged in" path).

## Application security

- Auth: single operator, bcrypt-hashed password, httpOnly + `Secure` (in
  production) + `SameSite=Lax` session cookie backed by a Postgres-stored
  session (`connect-pg-simple`) — not a bare JWT in localStorage.
- All SQL is parameterized (`pg` placeholders) — no string-built queries.
- Input validation via `zod` on every route accepting query/body parameters.
- `helmet` for standard security headers; `cors` locked to `WEB_ORIGIN`, not
  `*`.
- Rate limiting (`express-rate-limit`) on `/api/auth/login`.
- Request body size capped (`express.json({ limit: '100kb' })`).
- Error responses to clients are generic; full error detail stays in server
  logs only, and known secret env var names are never included in log lines.

## Telegram usage boundaries

The monitoring account is read-only by design: it does not join channels
automatically, send messages, react, or otherwise act outbound. It monitors
public channels only.
