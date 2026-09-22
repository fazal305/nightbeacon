import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../db/pool.js';
import { runTranslationTick } from './translate.js';
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
    `INSERT INTO raw_items (source_id, telegram_message_id, telegram_date, raw_text)
     VALUES ($1, 1, now(), $2) RETURNING id`,
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

test.after(async () => {
  await pool.end();
});
