import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../db/pool.js';
import { getStyleContext } from './style.js';
import { buildDraftMessages, compactReport } from './prompt.js';

after(() => pool.end());

const examples = [
  '🔴 BREAKING | STORM CLOSES THE COASTAL ROAD\nThree people were hurt as the storm hit the town.\n\n📡 NEWS CHANNEL',
  '🔴 THE PORT AUTHORITY SAID TWO SHIPS DOCKED\nNo delays were reported.\n\n📡 NEWS CHANNEL',
];

test('style card: built once from the example posts, reused, rebuilt when the posts change', async () => {
  const channel = { key: 'cardtest', name: 'Card Test', telegram: `@cardtest${Date.now()}`, styleGuide: 'Caps headline', styleExamples: 8 };
  let built = 0;
  const makeCard = async () => `card v${++built}: 🔴 [HEADLINE IN CAPS] / [one sentence] / "📡 NEWS CHANNEL"`;
  let posts = examples;
  const fetchExamples = async () => posts;

  const a = await getStyleContext(channel, { fetchExamples, makeCard });
  assert.match(a.card, /card v1/);
  const b = await getStyleContext(channel, { fetchExamples, makeCard });
  assert.equal(b.card, a.card);
  assert.equal(built, 1, 'cached, not rebuilt for every draft');

  // New example posts (next daily refresh) -> new card.
  channel.styleGuide = 'Caps headline, no hashtags';
  const c = await getStyleContext(channel, { fetchExamples, makeCard });
  assert.match(c.card, /card v2/);
});

test('style card: if it cannot be built, drafting falls back to the example posts', async () => {
  const channel = { key: 'cardfail', name: 'Fail', telegram: `@cardfail${Date.now()}`, styleGuide: '', styleExamples: 8 };
  const ctx = await getStyleContext(channel, { fetchExamples: async () => examples, makeCard: async () => { throw new Error('quota'); } });
  assert.equal(ctx.card, null);
  const msgs = buildDraftMessages({
    item: { raw_text: 'x', translated_text: 'Text', telegram_date: new Date() },
    targets: [{ channel, style: ctx }],
  });
  assert.match(msgs[0].content, /Recent posts from this channel/);
});

test('compact drafting: the card replaces the example posts, so the request is much smaller', () => {
  const channel = { key: 'main', name: 'Main', telegram: '@main' };
  const long = Array.from({ length: 6 }, (_, i) => `🔴 EXAMPLE ${i} ${'word '.repeat(50)}\n📡 NEWS CHANNEL`);
  const item = { raw_text: 'نص '.repeat(400), translated_text: 'Text '.repeat(200), telegram_date: new Date() };
  const withExamples = buildDraftMessages({ item, targets: [{ channel, style: { guide: '', examples: long } }] });
  const withCard = buildDraftMessages({
    item,
    targets: [{ channel, style: { guide: '', examples: [...long, '🔴 SHORT ONE\n📡 NEWS CHANNEL'], card: '🔴 [HEADLINE] / [body] / 📡 NEWS CHANNEL' } }],
  });
  const size = (m) => m.reduce((n, x) => n + x.content.length, 0);
  assert.ok(size(withCard) < size(withExamples) * 0.75, `${size(withCard)} vs ${size(withExamples)}`);
  assert.match(withCard[0].content, /House style of this channel[\s\S]*🔴 SHORT ONE/);
  assert.doesNotMatch(withCard[0].content, /EXAMPLE 3/);
});

test('long reports are cut for drafting; official statements never are', () => {
  const text = 'word '.repeat(1000);
  assert.ok(compactReport(text, false).length <= 2502);
  assert.equal(compactReport(text, true), text.trim());
});
