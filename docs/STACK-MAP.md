# Stack Map

Every dependency here has a specific job. Nothing is included to look
impressive.

| Technology | Why it's here |
|---|---|
| React + Vite | Dashboard UI; Vite for fast local dev/build. |
| Tailwind CSS (v4) | Styling, via the CSS-first `@theme` config — no separate config file needed. |
| TanStack Query | All server state: fetching, polling, caching, invalidation. |
| Zustand | UI-only state (active filters, selections) — never a copy of server data. |
| React Router | Client-side routes (Dashboard, Live Monitor, Sources, Activity, Content, Settings). |
| react-i18next | Localization scaffold + RTL/LTR `document.documentElement.dir` switching. |
| Node.js + Express | The only API surface the browser talks to. The browser never touches Postgres or Telegram directly. |
| PostgreSQL (`pg`) | Relational persistence; constraints (not application code) enforce Telegram-message dedup. |
| `telegram` (GramJS) | MTProto client for read-only Telegram polling — see `docs/SECURITY.md` for its maintenance-status risk note. |
| ~~`node-cron`~~ | Removed (Oct 2026): replaced by non-overlapping worker loops in `server/src/pipeline/workers.js` — see `docs/PIPELINE.md`. |
| `pg_trgm` (Postgres contrib) | Fuzzy duplicate matching on normalized post text. |
| Ollama (optional, external process) | Local multilingual embeddings for cross-language dedup; plain HTTP, no npm dependency. |
| Groq (`openai/gpt-oss-20b` default) | Translation of non-English posts; the primary LLM provider — swapped in after OpenRouter's free tier turned out to cap at 50 req/day account-wide (not per-minute as first assumed), which a 400+ source backlog exhausted within minutes. Selected via `LLM_PROVIDER`, with OpenRouter kept as a configurable fallback (`server/src/processing/llmClient.js` — both are OpenAI-compatible chat-completions APIs, so switching providers is a config change, not a code change). |
| `bcryptjs` | Password hashing for the single operator account. |
| `express-session` + `connect-pg-simple` | httpOnly cookie sessions backed by Postgres, not a bare JWT. |
| `zod` | Request validation at the API boundary. |
| `helmet`, `cors`, `express-rate-limit` | Standard API hardening. |

Not used, and why: Redis/Kafka/microservices (no throughput need at this
scale), Docker for local dev (Postgres installed natively for simplicity),
OmniRoute (a local dev-tool AI gateway, not a fit for a deployed backend —
OpenRouter direct access already satisfies the translation requirement),
`public-apis` enrichment (no genuine v1 use case found during research).
