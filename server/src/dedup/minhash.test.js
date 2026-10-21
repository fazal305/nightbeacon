import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signature, jaccard, containment, MinHashIndex } from './minhash.js';
import { normalizeText } from './normalize.js';
import { decide, dedupThresholds } from './decide.js';

const post = 'غارة جوية على بلدة عيتا الشعب في جنوب لبنان أسفرت عن سقوط شهيدين وثلاثة جرحى وفق المصادر المحلية';

test('minhash: relays with small edits match; different stories do not', () => {
  const a = signature(normalizeText(post));
  const relay = signature(normalizeText(`🔴 عاجل | ${post} 📡 تابعونا @somechannel`));
  const other = signature(normalizeText('اجتماع لوزراء الخارجية العرب في القاهرة لبحث الأوضاع الاقتصادية في المنطقة'));
  assert.ok(Math.max(jaccard(a, relay), containment(a, relay)) >= 0.85, `relay ${jaccard(a, relay)}`);
  assert.ok(jaccard(a, other) < 0.2, `other ${jaccard(a, other)}`);
});

test('minhash: a relay that adds a long footer is still matched by containment', () => {
  const a = signature(normalizeText(post));
  const footer = ' اشتركوا في قناتنا لمتابعة آخر الأخبار العاجلة والتغطية المباشرة على مدار الساعة من الميدان';
  const b = signature(normalizeText(post + footer + footer));
  assert.ok(jaccard(a, b) < 0.7, 'plain similarity is low');
  assert.ok(containment(a, b) >= 0.85, `containment ${containment(a, b)}`);
});

test('minhash index: finds the best candidate through LSH buckets, respects a filter, forgets removed stories', () => {
  const idx = new MinHashIndex();
  idx.add(1, signature(normalizeText(post)), { id: 1, ok: true });
  idx.add(2, signature(normalizeText('اجتماع لوزراء الخارجية العرب في القاهرة')), { id: 2, ok: true });
  const q = signature(normalizeText(`عاجل ${post}`));
  assert.equal(idx.best(q).id, 1);
  assert.equal(idx.best(q, (m) => m.id !== 1)?.id ?? null, null);
  idx.remove(1);
  assert.equal(idx.best(q), null);
  assert.equal(idx.size, 1);
});

test('decide: a MinHash match is a duplicate, or an update when it brings new numbers', () => {
  const t = dedupThresholds();
  const story = { id: 9, numbers: ['12'], first_seen_at: new Date(Date.now() - 600_000), last_seen_at: new Date() };
  const dup = decide({ item: { telegramDate: new Date(), numbers: ['12'] }, minhash: { story, jaccard: 0.8, containment: 0.9, shorter: 100 } }, t);
  assert.deepEqual([dup.decision, dup.method], ['duplicate', 'minhash']);
  const upd = decide({ item: { telegramDate: new Date(), numbers: ['12', '15'] }, minhash: { story, jaccard: 0.5, containment: 0.95, shorter: 100 } }, t);
  assert.deepEqual([upd.decision, upd.method, upd.newNumbers], ['update', 'minhash-contained', ['15']]);
  const shortPost = decide({ item: { telegramDate: new Date(), numbers: [] }, minhash: { story, jaccard: 0.4, containment: 0.95, shorter: 20 } }, t);
  assert.equal(shortPost.decision, 'unique', 'containment not trusted for very short posts');
});
