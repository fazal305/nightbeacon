// Pure decision logic: given an incoming item and the best candidate story
// found by each matcher, decide unique / duplicate / update. Kept free of I/O
// so the thresholds can be tested directly (see decide.test.js).
//
// Similarity is treated as evidence, not proof:
//   - an exact hash match is conclusive;
//   - a fuzzy (trigram) match must be high AND close in time;
//   - a semantic (embedding) match must be very high, or high AND
//     corroborated by shared event numbers — never merged just because two
//     posts are about the same place, conflict, or person.
// A match whose numbers disagree with the story's (casualty count went from
// 3 to 7, a new date) is recorded as an UPDATE to that story rather than
// silently discarded as a duplicate.

function num(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

export function dedupThresholds() {
  return {
    exactWindowHours: num('DEDUP_EXACT_WINDOW_HOURS', 72),
    fuzzyWindowHours: num('DEDUP_FUZZY_WINDOW_HOURS', 24),
    fuzzyDuplicate: num('DEDUP_FUZZY_THRESHOLD', 0.75),
    semanticWindowHours: num('DEDUP_SEMANTIC_WINDOW_HOURS', 12),
    // Above this, cosine alone is enough (given the time window).
    semanticDuplicate: num('DEDUP_SEMANTIC_THRESHOLD', 0.9),
    // Between this and semanticDuplicate, a match needs a shared number.
    semanticCandidate: num('DEDUP_SEMANTIC_CANDIDATE_THRESHOLD', 0.82),
    semanticMaxCandidates: num('DEDUP_SEMANTIC_MAX_CANDIDATES', 3000),
  };
}

function hoursBetween(a, b) {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 3_600_000;
}

// New numbers the story hasn't seen yet → this report adds information.
export function newNumbers(itemNumbers, storyNumbers) {
  const known = new Set(storyNumbers || []);
  return (itemNumbers || []).filter((n) => !known.has(n));
}

function sharesNumber(itemNumbers, storyNumbers) {
  const known = new Set(storyNumbers || []);
  return (itemNumbers || []).some((n) => known.has(n));
}

function matched(method, score, story, item) {
  // Only a report at least as recent as the story's first report can be an
  // update; an older report with different figures (seen late, e.g. while
  // working through a backlog) is just another, earlier source for it.
  const isLater = new Date(item.telegramDate) >= new Date(story.first_seen_at);
  const added = isLater ? newNumbers(item.numbers, story.numbers) : [];
  return {
    decision: added.length > 0 ? 'update' : 'duplicate',
    method,
    score,
    storyId: story.id,
    newNumbers: added,
  };
}

// item:   { telegramDate, numbers }
// exact:  { story } | null                         — same content hash in window
// fuzzy:  { story, similarity } | null             — best trigram candidate
// semantic: { story, similarity } | null           — best embedding candidate
export function decide({ item, exact, fuzzy, semantic }, t = dedupThresholds()) {
  if (exact?.story && hoursBetween(item.telegramDate, exact.story.last_seen_at) <= t.exactWindowHours) {
    // Identical normalized text cannot carry new numbers, so this is always
    // a plain duplicate.
    return { decision: 'duplicate', method: 'exact', score: 1, storyId: exact.story.id, newNumbers: [] };
  }

  if (
    fuzzy?.story &&
    fuzzy.similarity >= t.fuzzyDuplicate &&
    hoursBetween(item.telegramDate, fuzzy.story.last_seen_at) <= t.fuzzyWindowHours
  ) {
    return matched('fuzzy', fuzzy.similarity, fuzzy.story, item);
  }

  if (semantic?.story && hoursBetween(item.telegramDate, semantic.story.last_seen_at) <= t.semanticWindowHours) {
    const s = semantic.similarity;
    if (s >= t.semanticDuplicate) {
      return matched('semantic', s, semantic.story, item);
    }
    if (s >= t.semanticCandidate && sharesNumber(item.numbers, semantic.story.numbers)) {
      return matched('semantic+numbers', s, semantic.story, item);
    }
  }

  return { decision: 'unique', method: null, score: null, storyId: null, newNumbers: [] };
}
