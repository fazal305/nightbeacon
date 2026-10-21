# Processing Pipeline

How a Telegram post moves from a channel into the analyst feed, why it is
built this way, and how to see where time goes. Supersedes the cron-based
design described in earlier revisions of `POLLING.md`/`ARCHITECTURE.md`.

```
Telegram ──poll (adaptive, rate-gated)──┐
        └─push (joined channels only)───┤   Stage A: ingestion
                                        v
                      raw_items  (status=new, dedup_status=pending)  ← visible in the feed immediately
                                        |
                                        v   Stage B+C: dedup on ORIGINAL text
            exact hash ─> trigram fuzzy ─> multilingual embedding (optional, local)
               |                                        |
        duplicate ─> attached to story, status=duplicate, never translated
        update    ─> attached to story, continues (carries new figures)
        unique    ─> new story, continues
                                        |
                                        v   Stage D (only unique + update)
                          translation ─> classification ─> ready
```

Every stage is an independent worker loop over a persistent queue (columns
on `raw_items`), started from `server/src/pipeline/workers.js`. A slow or
failing stage only grows its own queue; nothing downstream can delay
ingestion.

## Audit findings (October 2026) — the actual causes of the feed backlog

Traced in code and, where noted, confirmed against the installed library
source (`telegram@2.26.22`, `node-cron@4.6.0`):

| # | Finding | Effect |
|---|---|---|
| 1 | One cron job polled all ~424 sources **sequentially** every 5 min with 750 ms spacing. A pass takes ≥ 424 × (0.75 s + request round-trip via proxy) ≈ 8–12 min. | Every channel waited 5–12+ min between polls, regardless of how active it was. |
| 2 | node-cron 4's `noOverlap` defaults to `false` (`dist/_shared.js`). | A new pass started every 5 min on top of the still-running one → two or more pollers hitting Telegram at once — exactly the "two concurrent pollers" pattern `POLLING.md` warned causes flood-waits. |
| 3 | `getMessages(channel, { minId, limit: 100 })` walks back from the **newest** message (`_MessagesIter`, non-reverse) — it returns the newest 100 above `minId`, and `last_seen_id` then jumped to the batch max. | Any channel posting >100 messages between polls **silently lost** the older ones forever. |
| 4 | Sources were polled by username string. GramJS's `StringSession` does not persist its entity cache, so every process restart re-ran `contacts.ResolveUsername` for every source. | ~424 resolves per restart — the method behind the documented ~18 h flood-wait. (The doc's claim that "GramJS's entity cache survives" was incorrect across restarts.) |
| 5 | `getTelegramClient()` stored the client **before** `connect()` resolved. | One failed connect (common on a blocked network) left a dead client cached until the process was restarted. |
| 6 | Translation and classification claimed `ORDER BY id` — oldest first. | With a 12,000+ item backlog, every new post queued behind all of it. |
| 7 | Classification was capped at 20 items/min although it is a sub-millisecond rule match; translation at 50/min with overlapping cron ticks. | Classification alone (≤ 1,200/h) was below real ingestion volume, so the "ready" backlog grew without bound. |
| 8 | No duplicate detection beyond `(source_id, telegram_message_id)`. | Every relay of a story was translated and classified separately. |

The frontend was **not** a cause: the feed already shows items in every
status, refetching every 15 s (Live Monitor) / configurable (Dashboard).

## What changed

**Ingestion** (`server/src/ingestion/`)
- `scheduler.js` — a continuous loop replaces the cron pass. Each iteration
  polls whichever source is most overdue. Never overlaps itself.
- Adaptive per-source intervals (`pollSource.js`): a channel that just posted
  is polled again after `POLL_MIN_INTERVAL_SECONDS` (60); quiet ones back off
  ×1.5 up to `POLL_MAX_INTERVAL_SECONDS` (600). **The global request rate is
  unchanged** — one MTProto request per `POLL_INTER_SOURCE_DELAY_MS` (750 ms)
  through a shared gate; adaptivity only decides which channels get those
  requests first. When everything is due, it degrades to fair round-robin.
- Gaps instead of loss: when a poll returns a full batch above
  `last_seen_id`, the newest batch is stored immediately and the skipped id
  range goes into `ingestion_gaps`. `backfill.js` fills gaps at lower
  priority (only when no live poll is due, plus 1 in every
  `BACKFILL_EVERY_N_POLLS` requests so it can't starve), resuming from where
  it stopped after a crash. Backfilled rows carry `ingest_path='backfill'`.
- Channel id + access hash are persisted on `sources` the first time a
  username is resolved (and by `seed:sources-bulk`, straight from the chat-
  folder preview). Polls use `InputPeerChannel` directly — no
  `ResolveUsername` after the first time, ever. Resolves that do happen go
  through their own slower gate (`TELEGRAM_RESOLVE_INTERVAL_MS`, 15 s). A
  `CHANNEL_INVALID`-type error clears the stored hash so it is re-resolved once.
- Flood-waits pause **all** ingestion requests for the required duration
  (they are account-wide) and reschedule the source without counting an
  error. GramJS's silent inline sleep is limited to 10 s
  (`TELEGRAM_FLOOD_SLEEP_THRESHOLD`) so longer waits are visible.
- Connectivity failures (proxy down, no connection) pause ingestion briefly
  instead of pushing hundreds of channels into hour-long error backoff.
  Genuine per-channel errors back off exponentially (60 s × 2ⁿ, max 1 h).
- Live push (`liveUpdates.js`): Telegram only pushes posts for channels the
  account has **joined**. For those, posts are persisted within seconds.
  Polling remains the checkpoint authority (a push never advances
  `last_seen_id`), so missed pushes are still caught.
- Each row records `observed_at` (when first seen) separately from
  `collected_at` (commit time).

**Deduplication** (`server/src/dedup/`) — runs before any translation/LLM call:
1. Exact: SHA-256 of normalized text (`normalize.js`: NFKC, strip links/
   @mentions/emoji/punctuation, fold Arabic/Persian/Urdu letter variants and
   digits — words and numbers are kept) within `DEDUP_EXACT_WINDOW_HOURS` (72).
2. Fuzzy: `pg_trgm` similarity against recent stories (GIN-indexed),
   ≥ `DEDUP_FUZZY_THRESHOLD` (0.75) within `DEDUP_FUZZY_WINDOW_HOURS` (24).
3. Semantic (optional): multilingual embeddings of the **original** text from
   a local Ollama model, compared against an in-memory index of stories from
   the last `DEDUP_SEMANTIC_WINDOW_HOURS` (12), capped at
   `DEDUP_SEMANTIC_MAX_CANDIDATES`. Cosine ≥ `DEDUP_SEMANTIC_THRESHOLD`
   (0.90) matches; between `DEDUP_SEMANTIC_CANDIDATE_THRESHOLD` (0.82) and
   that, a match also needs a shared event figure (numbers survive
   translation). Topic overlap alone never merges two reports.
4. A match whose figures differ from the story's (casualties 3 → 7) and is
   not older than the story becomes an **update**: attached to the story but
   still translated, classified and shown. Plain duplicates get
   `status='duplicate'` and skip stage D; their source, timestamp and link stay
   on their own `raw_items` row and are listed in the Content Inspector.

Very short posts (< 25 normalized chars) are only deduped by exact hash.
Dedup fails open: an item it can't process continues as unique. If the
embedder is down, dedup continues with exact + fuzzy for a cooldown period.
Thresholds are starting points, tested in `decide.test.js`; tune them against
real traffic.

**Processing** — translation/classification claim via `pipeline/claim.js`:
live window first (`PIPELINE_LIVE_WINDOW_HOURS`, 6), round-robin across
sources, newest first; old backlog afterwards. Translation spacing is
enforced per call (`TRANSLATE_MAX_PER_MINUTE`, 50) rather than by batch size.
Classification batch raised to 200.

## Measuring latency

`GET /api/pipeline/metrics` (and the collapsible **Pipeline** panel on Live
Monitor) reports, for live posts collected in the last hour, p50/p95 of:

| Stage | Columns |
|---|---|
| Telegram → seen | `observed_at − telegram_date` (polling cadence / push) |
| seen → saved | `collected_at − observed_at` (DB write) |
| saved → deduped | `dedup_at − collected_at` |
| deduped → translated | `translated_at − dedup_at` |
| translated → ready | `ready_at − translated_at` |
| end to end | `ready_at − telegram_date` |

plus queue depth and oldest item per stage, 15-minute throughput, dedup mix,
sources due/overdue, last successful fetch, open gaps, reconnect and
flood-wait counters. "Appears in the dashboard" is ≤ the feed refetch
interval after `collected_at` (items are shown from the moment they're saved).

## Running semantic dedup locally (optional, free)

```
# on the server
curl -fsSL https://ollama.com/install.sh | sh
ollama pull bge-m3          # multilingual; ~1.2 GB; CPU is fine at this volume
# .env
EMBEDDING_PROVIDER=ollama
EMBEDDING_MODEL=bge-m3
OLLAMA_URL=http://127.0.0.1:11434
```

`paraphrase-multilingual` is a smaller, faster alternative. Changing model
invalidates stored story embeddings for semantic matching (they are keyed by
`embedding_model`); exact and fuzzy matching are unaffected.

## Telegram access through a Fake-TLS MTProxy

Fake-TLS (`ee…` secret) MTProxies disguise MTProto as a TLS session to a
real website, which is why they keep working where Telegram is blocked.
GramJS — including its latest release, 2.26.22 — only supports plain and
`dd` secrets; before this change an `ee` secret failed deep inside the
connection ("MTProxy secret must be a hex-string representing 16 bytes").

`server/src/ingestion/fakeTlsConnection.js` adds the transport:
Chrome-like 517-byte ClientHello (SNI = the secret's domain) whose random is
HMAC-SHA256(key, hello) with the timestamp XORed in; verification of the
proxy's HMAC-signed ServerHello; then the obfuscated2 stream with the
"secure" padded-intermediate framing, carried in TLS ApplicationData
records. It is installed on the GramJS client (`applyProxyTransport`) for
ingestion, Telegram-native translation, the login script and
`npm run telegram:check-proxy`.

**How it was verified.** This development sandbox cannot reach Telegram
itself (outbound connections to Telegram are blocked by its network policy),
so the transport was tested against two independent, widely deployed
Fake-TLS proxy servers running locally, with their upstream routed (via
SOCKS5) to a stub data centre that decodes the obfuscated2 stream and
echoes every packet:

| Proxy | Result |
|---|---|
| alexbers/mtprotoproxy (Python, `tls`-only mode) | handshake accepted; 40 B – 40 KB packets round-trip byte-exact; secure tag `dddddddd` |
| 9seconds/mtg v2.2.8 (Go; 5 s time-skew limit, anti-replay on) | same; mtg logged the correct DC id from the header |
| either, wrong secret | clear error naming wrong secret / clock skew |

The full `TelegramClient` path was also checked: GramJS's first MTProto
packet (req_pq) arrived intact at the stub through mtg. A regression test
(`fakeTlsConnection.test.js`) runs the same round trip in CI against an
in-process port of mtprotoproxy's server handshake.

**Verified against real Telegram (Oct 2026):** from the operator's network in
Pakistan, `npm run telegram:check-proxy` completed the MTProto key exchange
and an encrypted request through 21 of 22 public proxies from a mixed list —
six Fake-TLS (`ee`), plus plain, `dd` and base64-encoded secrets — in
2.5–4.5 s each (the 22nd timed out). Run the same
command on the server before deploying, since free proxies come and go.

## Not yet verified against live Telegram

Everything above is covered by tests against real Postgres with a fake
Telegram client that mirrors GramJS's `minId`/`maxId` semantics. Not yet
observed in production: real-world latency numbers after the change, push
delivery for joined channels, real flood-wait behaviour of the new pacing,
and embedding thresholds on real multilingual traffic. Check the metrics
panel after deploying.

## Translation provider rotation

`TRANSLATION_PROVIDER` may list several providers, e.g.
`telegram,google,lingva,libretranslate`. Each claimed post goes to the first
provider that isn't resting. A provider that is rate-limited (HTTP 429 /
Telegram flood-wait), blocked (403), down (5xx) or unreachable is rested — for
the flood-wait or `Retry-After` time, otherwise `TRANSLATION_PROVIDER_REST_SECONDS`
(300) — and the remaining posts move on to the next. A post one provider rejects
is offered to the next too; only a post every provider rejected counts a retry
attempt. Posts that met only unavailable providers go back to the queue
untouched. The worker log shows `"via google": n` etc. `npm run translate:check`
tests each provider from your network.

Web providers (`src/processing/webTranslate.js`): Google Translate's free web
endpoint (`client=gtx`, no key, unofficial), [Lingva](https://github.com/thedaviddelta/lingva-translate)
public instances (`LINGVA_URLS`), and self-hosted
[LibreTranslate](https://github.com/LibreTranslate/LibreTranslate)
(`LIBRETRANSLATE_URL`, fully offline, no limits).
