import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../db/pool.js';
import { runTranslationTick, chunkForBatch, parseBatchReply, buildBatchMessages } from './translate.js';
import { looksLikeEnglish } from './detectLanguage.js';

test('looksLikeEnglish: deterministic script detection', () => {
  assert.equal(looksLikeEnglish('Breaking news from the region.'), true);
  assert.equal(looksLikeEnglish('هذا خبر عاجل'), false);
  assert.equal(looksLikeEnglish(''), null);
  assert.equal(looksLikeEnglish(null), null);
});

test('looksLikeEnglish: skips translation for meaningfully mixed-language content too', () => {
  // Mostly English with a couple of Arabic words mixed in — skip translation,
  // the analyst can already read the bulk of this without an LLM call.
  assert.equal(
    looksLikeEnglish('Breaking news from the region, sources say حرب عاجل near the border today morning.'),
    true
  );
  // A single English hashtag/mention buried in an otherwise fully
  // Arabic-script post is not "meaningful" English — still needs translating.
  assert.equal(
    looksLikeEnglish('هذا خبر عاجل جدا من المنطقة اليوم صباحا بالقرب من الحدود مباشرة #test'),
    false
  );
});

test('translation tick never overwrites raw_text, even on failure', async () => {
  const src = await pool.query(
    `INSERT INTO sources (channel_username, display_name) VALUES ($1, $2) RETURNING id`,
    [`test_translate_${Date.now()}`, 'Test Source']
  );
  const sourceId = src.rows[0].id;
  const originalText = 'اختبار حقيقي للنص الأصلي';

  const item = await pool.query(
    `INSERT INTO raw_items (source_id, telegram_message_id, telegram_date, raw_text, dedup_status)
     VALUES ($1, 1, now(), $2, 'unique') RETURNING id`,
    [sourceId, originalText]
  );

  await runTranslationTick();

  const after = await pool.query('SELECT raw_text, status FROM raw_items WHERE id = $1', [
    item.rows[0].id,
  ]);

  // No OPENROUTER_API_KEY in the test environment, so this must fail gracefully —
  // the important assertion is that raw_text is untouched either way. A
  // "not configured" failure isn't item-specific, so it's treated as systemic
  // and reverts to 'new' (preserving retry budget) rather than
  // 'failed_translation' — see isSystemicFailure in translate.js.
  assert.equal(after.rows[0].raw_text, originalText);
  assert.ok(['new', 'failed_translation', 'translated'].includes(after.rows[0].status));

  await pool.query('DELETE FROM raw_items WHERE source_id = $1', [sourceId]);
  await pool.query('DELETE FROM sources WHERE id = $1', [sourceId]);
});

test('batch translation: chunks respect item and character limits', () => {
  const items = Array.from({ length: 7 }, (_, i) => ({ id: i, raw_text: 'x'.repeat(i === 3 ? 900 : 100) }));
  const chunks = chunkForBatch(items, 3, 1000);
  assert.deepEqual(chunks.map((c) => c.map((i) => i.id)), [[0, 1, 2], [3, 4], [5, 6]]); // 900 + 100 chars is exactly the limit
  assert.deepEqual(chunkForBatch([{ id: 1, raw_text: 'y'.repeat(5000) }], 3, 1000).length, 1, 'an oversized post still gets its own chunk');
});

test('batch translation: prompt uses short indexes; reply parsing keeps only valid, in-range, first entries', () => {
  const msgs = buildBatchMessages([{ id: 900, raw_text: 'سلام' }, { id: 901, raw_text: 'مرحبا' }]);
  assert.deepEqual(JSON.parse(msgs[1].content), [{ i: 1, text: 'سلام' }, { i: 2, text: 'مرحبا' }]);

  const reply = 'Here you go:\n```json\n[{"i":1,"lang":"fa","en":"Hello"},{"i":1,"en":"dup"},{"i":3,"en":"out of range"},{"i":2,"en":""}]\n```';
  const got = parseBatchReply(reply, 2);
  assert.deepEqual([...got.entries()], [[1, { en: 'Hello', lang: 'fa' }]], 'item 2 (empty) is left for the one-by-one fallback');
  assert.throws(() => parseBatchReply('sorry, cannot help', 2), /not a JSON array/);
});

test.after(async () => {
  await pool.end();
});
