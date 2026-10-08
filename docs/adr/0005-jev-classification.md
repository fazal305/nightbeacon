# ADR 0005: Optional Jev-based classification provider

**Status:** Accepted (opt-in, not the default)

**Context:** Classification (category/priority) has always been rule-based
keyword matching (`classificationRules.js`) per the project's stated
principle: prefer deterministic rules over an LLM/API call where they're
reliable enough, since keyword matching is free, instant, and has no
external failure mode. The operator asked whether an alternative decision
model — TypeSafe AI's Jev, a non-generative model that returns typed,
probabilistic answers rather than text — could be used instead.

**Decision:** Add `CLASSIFICATION_PROVIDER` (`rule` default, `jev` opt-in).
When set to `jev`, `runClassificationTick()`
(`server/src/processing/classify.js`) routes through the new
`server/src/processing/jevClassify.js` instead of `classificationRules.js`.
Both providers write the same `raw_items.category`/`raw_items.priority`
columns; only the rule-based path produces `item_tags` rows, since Jev
answers bounded questions rather than extracting keywords.

**Reasoning / design choices:**
- `category` is a `choice()` question with one criterion per
  `classificationRules.js` category name, plus an explicit `"none"` option —
  Jev's `choice()` always selects one of the given labels, so `"none"`
  preserves the rule-based path's existing behavior of leaving `category`
  `NULL` for posts that don't clearly fit any listed topic.
- `priority` is a `score()` question over a 4-level ordered rubric
  (informational → low → medium → high), matching the existing
  `raw_items.priority` CHECK constraint values. `score()`'s response can
  fall between rubric levels (e.g. `2.4`), so it's rounded and clamped to
  the nearest valid index rather than stored as a raw float.
- A `RateLimitError` (the SDK already retries 429s internally before
  throwing this) is treated as systemic, the same way `translate.js`
  treats Groq's 429s — it reverts the item to `status = 'translated'`
  (not consuming `tagging_attempts`) instead of counting a provider-wide
  rate limit against the item's own retry budget.

**Consequences:**
- Not the default: this is a real per-request API cost against a rule-based
  path that's free, and Jev's judgment quality on this specific classification
  task hasn't been evaluated against the existing keyword rules yet.
- Requires `TYPESAFE_API_KEY` (from the TypeSafe console) and the
  `@typesafe-ai/sdk` npm dependency, added to `server/package.json` but not
  yet installed in this environment — `npm install` inside `server/` is
  needed before `CLASSIFICATION_PROVIDER=jev` can run.
- If enabled, `item_tags` stops growing for newly classified items (no
  `source = 'rule'` keyword tags from Jev-classified rows) — worth knowing
  before comparing tag-based search/filtering behavior across the switch.
