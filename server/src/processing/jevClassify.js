import { TypeSafeClient, choice, score, RateLimitError } from '@typesafe-ai/sdk';
import { CATEGORIES } from './classificationRules.js';

// Ascending order, index 0-3 — matches Jev's `score()` rubric, which is
// zero-indexed. `PRIORITIES` in routes/taxonomy.js is deliberately in
// display order (high -> informational), which is why this isn't reused
// from there.
const PRIORITY_LEVELS = ['informational', 'low', 'medium', 'high'];

const NO_CATEGORY = 'none';

const PRIORITY_RUBRIC = [
  'Informational — routine update, no urgency or risk implied.',
  'Low — a minor development worth noting, not urgent.',
  'Medium — a notable event (protest, sanctions, ceasefire, arrest, curfew) analysts should track.',
  'High — an acute incident (attack, casualties, explosion, assassination) with immediate operational relevance.',
];

let client = null;
function getClient() {
  // Constructed lazily, not at import time, so a missing TYPESAFE_API_KEY
  // only breaks classification when the "jev" provider is actually selected
  // (CLASSIFICATION_PROVIDER=rule, the default, never touches this file).
  if (!client) client = new TypeSafeClient();
  return client;
}

// choice() has no built-in "none of these" — CATEGORIES only lists topics
// that ARE a category (see classificationRules.js), so an explicit "none"
// label is added here to preserve the rule-based path's existing behavior
// of leaving raw_items.category NULL for posts that don't fit any of them.
function categoryCriteria() {
  const criteria = { [NO_CATEGORY]: 'Does not clearly fit any of the other categories.' };
  for (const cat of CATEGORIES) {
    criteria[cat.name] = `Topics like: ${cat.keywords.slice(0, 6).join(', ')}, etc.`;
  }
  return criteria;
}

export async function classifyWithJev(text) {
  const { answers } = await getClient().systemOne({
    state: text,
    questions: {
      category: choice('What category best describes this OSINT/news post?', categoryCriteria()),
      priority: score(
        'How urgent or operationally significant is this post for an OSINT analyst?',
        PRIORITY_RUBRIC
      ),
    },
  });

  const category = answers.category.choice === NO_CATEGORY ? null : answers.category.choice;
  const priorityIndex = Math.max(
    0,
    Math.min(PRIORITY_LEVELS.length - 1, Math.round(answers.priority.score))
  );

  return { category, priority: PRIORITY_LEVELS[priorityIndex] };
}

// The SDK already retries 429s internally (default: 2 retries with backoff —
// see RetryPolicy in the SDK types) before throwing RateLimitError, so by
// the time this is true the account is genuinely rate-limited for now, not
// just a transient blip.
export function isJevRateLimit(err) {
  return err instanceof RateLimitError;
}
