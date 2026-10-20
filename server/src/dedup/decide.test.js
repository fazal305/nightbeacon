import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeText, contentHash, extractNumbers } from './normalize.js';
import { decide, dedupThresholds } from './decide.js';
import { cosine, l2normalize } from './embeddings.js';

const T = dedupThresholds();
const now = new Date('2026-10-20T12:00:00Z');
const story = (over = {}) => ({
  id: 1,
  numbers: [],
  first_seen_at: new Date(now.getTime() - 10 * 60_000),
  last_seen_at: new Date(now.getTime() - 10 * 60_000),
  ...over,
});

test('normalizeText: relays with different links, mentions, emoji and letter variants hash identically', () => {
  const a = '🔴 عاجل: مقتل ١٢ شخصاً في غارة على مدينة غزة https://t.me/chan_a/123 @chan_a';
  const b = 'عاجل - مقتل 12 شخصا في غارة علی مدینة غزة\n\n👉 t.me/chan_b';
  assert.equal(normalizeText(a), normalizeText(b));
  assert.equal(contentHash(normalizeText(a)), contentHash(normalizeText(b)));
});

test('normalizeText: keeps the words and numbers that make two reports different', () => {
  assert.notEqual(normalizeText('3 killed in strike on Kharkiv'), normalizeText('7 killed in strike on Kharkiv'));
  assert.equal(normalizeText('1,200 troops deployed'), '1200 troops deployed');
});

test('extractNumbers: language-agnostic event figures, ignoring clock times and single digits', () => {
  assert.deepEqual(extractNumbers('مقتل ١٢ شخصاً و٤٥ جريحاً'), ['12', '45']);
  assert.deepEqual(extractNumbers('12 killed, 45 injured — updated 14:30'), ['12', '45']);
  assert.deepEqual(extractNumbers('2 sources say'), []);
});

test('decide: exact hash match is a duplicate', () => {
  const r = decide({ item: { telegramDate: now, numbers: ['12'] }, exact: { story: story() } }, T);
  assert.equal(r.decision, 'duplicate');
  assert.equal(r.method, 'exact');
});

test('decide: exact match outside the time window is NOT merged (recurring boilerplate days apart)', () => {
  const old = story({ last_seen_at: new Date(now.getTime() - (T.exactWindowHours + 1) * 3_600_000) });
  assert.equal(decide({ item: { telegramDate: now, numbers: [] }, exact: { story: old } }, T).decision, 'unique');
});

test('decide: fuzzy near-duplicate with a changed figure is an UPDATE, not a discard', () => {
  const r = decide(
    { item: { telegramDate: now, numbers: ['17'] }, fuzzy: { story: story({ numbers: ['13'] }), similarity: 0.86 } },
    T
  );
  assert.equal(r.decision, 'update');
  assert.deepEqual(r.newNumbers, ['17']);
});

test('decide: a late-arriving OLDER report with different figures is a duplicate, not an update', () => {
  const r = decide(
    {
      item: { telegramDate: new Date(now.getTime() - 60 * 60_000), numbers: ['13'] },
      fuzzy: { story: story({ numbers: ['17'] }), similarity: 0.9 },
    },
    T
  );
  assert.equal(r.decision, 'duplicate');
});

test('decide: fuzzy similarity below threshold is unique', () => {
  assert.equal(
    decide({ item: { telegramDate: now, numbers: [] }, fuzzy: { story: story(), similarity: T.fuzzyDuplicate - 0.05 } }, T)
      .decision,
    'unique'
  );
});

test('decide: very high semantic similarity matches across languages', () => {
  const r = decide(
    { item: { telegramDate: now, numbers: [] }, semantic: { story: story(), similarity: T.semanticDuplicate + 0.02 } },
    T
  );
  assert.equal(r.decision, 'duplicate');
  assert.equal(r.method, 'semantic');
});

test('decide: mid-band semantic similarity is NOT enough on its own (same place/topic, different event)', () => {
  const s = (T.semanticCandidate + T.semanticDuplicate) / 2;
  const r = decide({ item: { telegramDate: now, numbers: ['45'] }, semantic: { story: story({ numbers: ['12'] }), similarity: s } }, T);
  assert.equal(r.decision, 'unique');
});

test('decide: mid-band semantic similarity corroborated by a shared figure is a match', () => {
  const s = (T.semanticCandidate + T.semanticDuplicate) / 2;
  const r = decide({ item: { telegramDate: now, numbers: ['12'] }, semantic: { story: story({ numbers: ['12'] }), similarity: s } }, T);
  assert.equal(r.decision, 'duplicate');
  assert.equal(r.method, 'semantic+numbers');
});

test('decide: semantic match outside its time window is unique', () => {
  const old = story({ last_seen_at: new Date(now.getTime() - (T.semanticWindowHours + 1) * 3_600_000) });
  assert.equal(
    decide({ item: { telegramDate: now, numbers: [] }, semantic: { story: old, similarity: 0.99 } }, T).decision,
    'unique'
  );
});

test('thresholds are configurable via env', () => {
  process.env.DEDUP_SEMANTIC_THRESHOLD = '0.95';
  try {
    assert.equal(dedupThresholds().semanticDuplicate, 0.95);
  } finally {
    delete process.env.DEDUP_SEMANTIC_THRESHOLD;
  }
});

test('cosine of L2-normalized vectors', () => {
  const a = l2normalize([1, 2, 3]);
  assert.ok(Math.abs(cosine(a, a) - 1) < 1e-9);
  assert.ok(Math.abs(cosine(l2normalize([1, 0]), l2normalize([0, 1]))) < 1e-9);
});
