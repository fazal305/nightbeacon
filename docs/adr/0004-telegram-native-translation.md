# ADR 0004: Optional native-Telegram translation provider

**Status:** Accepted (opt-in, not yet the default)

**Context:** Even after the Groq switch (ADR 0003), Groq's free tier has a
hard **200,000 tokens/day** account-wide cap. At 424 real sources this is a
genuine backlog-clearing-speed bottleneck (~18,000+ item backlog observed) —
not something a `reasoning_effort` tweak or larger batch size fixes, since
the ceiling is per-day, not per-minute. The operator explicitly deferred
acting on this ("leave it as-is for now") until a real alternative existed.

Telegram's own clients translate messages via a documented MTProto method,
`messages.translateText`, which the GramJS session Nightbeacon already holds
open (for ingestion) can call directly — no separate account, API key, or
LLM involved.

**Decision:** Add `TRANSLATION_PROVIDER` (`groq` default, `telegram` opt-in).
When set to `telegram`, `runTranslationTick()` (`server/src/processing/translate.js`)
routes through `server/src/processing/telegramTranslate.js` instead of
`llmClient.js`. Deterministic skip logic (`detectLanguage.js`, English/mixed
content) is unchanged and shared by both paths — it never touches either
provider.

**Reasoning / design choices:**
- `translateText` is called in its **text-array form** (`text: [TextWithEntities]`),
  not the peer+message-id form. The peer form would make GramJS resolve the
  channel first — exactly the call (`contacts.ResolveUsername`) that
  flood-waited the ingestion session for ~12 hours in production. Passing
  raw text directly skips peer resolution entirely.
- The text-array form also accepts multiple texts in one call, so a tick
  translates a chunk of items (`TRANSLATE_CHUNK_SIZE = 20`) per MTProto
  round trip instead of one call per item — Telegram doesn't publish a cap
  for this form, so the chunk size is a conservative guess, not a measured
  limit.
- `messages.translateText`'s response has no detected-source-language field
  (unlike the LLM prompt, which is asked to report one) — `translations.source_language`
  stays `null` for Telegram-translated rows, the same "unknown but still
  usable" case already tolerated when an LLM skips the format.
- A flood-wait on this session-shared call fails a whole in-flight chunk at
  once (not a single item), so systemic-failure handling operates per-chunk:
  the chunk's items and any not-yet-attempted items revert to `status='new'`
  (preserving `translation_attempts`), same principle as ADR 0003's
  quota-vs-per-item-failure distinction, detected via
  `isTelegramFloodWait()` matching Telegram's `"A wait of N seconds is
  required"` error text instead of Groq's `429`/rate-limit text.

**Consequences:**
- Not switched on by default — MTProto rate limits for this specific method
  are undocumented, and the account was already in an active flood-wait from
  unrelated ingestion calls when this was built. Should only be enabled once
  that clears, and initially watched closely via the Activity page for new
  flood-waits before trusting it for the full backlog.
- If it proves reliable at volume, it removes the Groq daily-token
  bottleneck entirely for translation (classification remains rule-based
  and unaffected either way).
- `translations.model` is set to the literal string `'telegram'` for rows
  translated this way, so the UI/data can distinguish provider provenance
  the same way it already distinguishes `rule` vs `llm` tag sources.
