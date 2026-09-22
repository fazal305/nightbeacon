# ADR 0003: Groq as the default translation provider, OpenRouter as fallback

**Status:** Accepted

**Context:** OpenRouter's free-tier models were the original translation
provider (see the STACK-MAP entry and Phase 2 implementation). Once
Nightbeacon scaled from one channel to 445 real sources, the real backlog
volume (12,000+ items) exposed a limit that per-minute rate testing hadn't
caught: OpenRouter's free tier caps at **50 requests/day, account-wide,
across all `:free` models** — not just a per-minute limit as originally
assumed. The account exhausted its daily quota within minutes of real
multi-channel volume, and every subsequent translation attempt failed with
`Rate limit exceeded: free-models-per-day` until the next UTC day.

**Decision:** Switch the default translation provider to Groq
(`openai/gpt-oss-20b`), keeping OpenRouter available as a configurable
fallback via `LLM_PROVIDER`. Both are OpenAI-compatible chat-completions
APIs, so `server/src/processing/llmClient.js` handles either through one
function — switching providers is a config change, not a code change.

**Reasoning:** Confirmed via Groq's own rate-limit response headers:
~1000 requests/10min (~100/min sustained) and ~30k tokens/min on the free
tier — roughly two orders of magnitude more headroom than OpenRouter's
50/day, with no separate daily cap observed. Verified with real production
translations (Arabic/Russian OSINT posts) producing accurate, fluent output.

**Update:** at real ingestion volume, the binding constraint turned out to be
Groq's **tokens-per-minute** limit (8000 TPM), not the request-count limit —
`gpt-oss-20b` is a reasoning model that spends a large share of its output on
an internal chain-of-thought trace by default (measured ~260 reasoning
tokens for translating a single sentence, more than the answer itself).
Setting `reasoning_effort: 'low'` for this model family cut total tokens per
call by ~60% (389 → 162, measured) with identical output quality — a
translation task doesn't need heavy reasoning. See
`server/src/processing/llmClient.js`.

**Consequences:**
- `translate.js`'s `BATCH_SIZE` raised from 15 to 50/min accordingly.
- A related bug this exposed was fixed independently of the provider switch:
  `isSystemicFailure()` in `translate.js` now recognizes rate-limit/quota
  errors as not the item's fault, reverting the item to `status = 'new'`
  instead of consuming its `translation_attempts` retry budget — a systemic,
  account-wide outage was, before this fix, capable of permanently
  stranding many items in `failed_translation` within ~5 minutes (5
  attempts × ~1min ticks) over something no per-item retry could fix.
- If Groq's free tier ever becomes insufficient or changes terms,
  `LLM_PROVIDER=openrouter` (or a third provider added to `llmClient.js`'s
  `PROVIDERS` map) is a one-line config change away.
