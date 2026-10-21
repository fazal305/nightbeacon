import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../db/pool.js';
import { triagePriority, triageBatch, requeueCorroborated, normalizeForTriage } from './triage.js';
import { runTranslationTick, translationRotation } from './translate.js';

let sourceId;
let msg = 1;
const realFetch = globalThis.fetch;

const newStory = async (count, canonical) =>
  (await pool.query(
    `INSERT INTO stories (canonical_item_id, normalized_text, content_hash, first_seen_at, last_seen_at, item_count)
     VALUES ($2, 'x', md5(random()::text), now(), now(), $1) RETURNING id`,
    [count, canonical]
  )).rows[0].id;

async function newItem(text, { storyCount } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO raw_items (source_id, telegram_message_id, telegram_date, raw_text, dedup_status)
     VALUES ($1, $2, now(), $3, 'unique') RETURNING id`,
    [sourceId, msg++, text]
  );
  if (storyCount) {
    await pool.query('UPDATE raw_items SET story_id = $2 WHERE id = $1', [rows[0].id, await newStory(storyCount, rows[0].id)]);
  }
  return rows[0].id;
}
const row = async (id) =>
  (await pool.query(
    `SELECT ri.status, ri.priority, ri.triage_priority, ri.translation_skipped, t.translated_text
     FROM raw_items ri LEFT JOIN translations t ON t.raw_item_id = ri.id WHERE ri.id = $1`,
    [id]
  )).rows[0];

before(async () => {
  sourceId = (await pool.query(`INSERT INTO sources (channel_username, display_name) VALUES ($1, 'Src') RETURNING id`, [`tri_${Date.now()}`])).rows[0].id;
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  translationRotation.reset();
  process.env.TRANSLATE_MIN_PRIORITY = 'off';
  await pool.query('UPDATE raw_items SET story_id = NULL WHERE source_id = $1', [sourceId]);
  await pool.query('DELETE FROM stories WHERE canonical_item_id IN (SELECT id FROM raw_items WHERE source_id = $1)', [sourceId]);
  await pool.query('DELETE FROM raw_items WHERE source_id = $1', [sourceId]);
});
after(async () => {
  delete process.env.TRANSLATION_PROVIDER;
  await pool.query('DELETE FROM sources WHERE id = $1', [sourceId]);
  await pool.end();
});

test('triage: priority guessed from the original text in the sources\' languages', () => {
  assert.equal(triagePriority('عاجل: غارة إسرائيلية على جنوب لبنان'), 'high');
  assert.equal(triagePriority('غارةٌ على الضاحية'), 'high', 'diacritics ignored');
  assert.equal(triagePriority('حمله پهپادی به پایگاه'), 'high');
  assert.equal(triagePriority('Взрыв в порту, есть раненые'), 'high');
  assert.equal(triagePriority('פיצוץ בנמל'), 'high');
  assert.equal(triagePriority('اعتقال ناشطين في الضفة'), 'medium');
  assert.equal(triagePriority('مفاوضات وقف إطلاق النار'), 'medium');
  assert.equal(triagePriority('صباح الخير يا متابعين، تابعوا قناتنا'), 'low');
  assert.equal(triagePriority(''), 'informational');
  assert.equal(normalizeForTriage('کشته'), normalizeForTriage('كشته'), 'Persian and Arabic letter forms match');
});

test('classify first: only posts that clear the bar are translated; the rest go to the feed untranslated', async () => {
  process.env.TRANSLATE_MIN_PRIORITY = 'medium';
  process.env.TRANSLATION_PROVIDER = 'google';
  process.env.GOOGLE_TRANSLATE_PER_MINUTE = '60000';
  const translated = [];
  globalThis.fetch = async (url, init = {}) => {
    const q = new URLSearchParams(String(init.body || '')).get('q') || '';
    translated.push(q);
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => [[[`EN: ${q}`, q]], null, 'ar'], text: async () => '' };
  };
  const important = await newItem('عاجل: غارة على جنوب لبنان');
  const chatter = await newItem('صباح الخير يا متابعين، تابعوا قناتنا');
  const corroborated = await newItem('تابعوا التغطية المباشرة', { storyCount: 4 });
  const english = await newItem('Good morning everyone, follow our channel');

  await runTranslationTick();

  assert.equal((await row(important)).status, 'translated');
  assert.equal((await row(important)).triage_priority, 'high');
  const c = await row(chatter);
  assert.deepEqual([c.status, c.priority, c.translation_skipped, c.translated_text], ['ready', 'low', true, null]);
  assert.equal((await row(corroborated)).status, 'translated', 'reported by several channels: translated anyway');
  assert.notEqual((await row(english)).status, 'new', 'English needs no translation');
  assert.ok(!translated.some((q) => q.includes('صباح')), 'chatter never sent to a translator');
});

test('a skipped post is translated after all when its story grows to 3+ channels', async () => {
  process.env.TRANSLATE_MIN_PRIORITY = 'medium';
  const id = await newItem('تابعوا التغطية');
  const { skipped } = await triageBatch([{ id, raw_text: 'تابعوا التغطية' }]);
  assert.equal(skipped.length, 1);
  const story = await newStory(3, id);
  await pool.query('UPDATE raw_items SET story_id = $2 WHERE id = $1', [id, story]);
  assert.equal(await requeueCorroborated(), 1);
  assert.deepEqual([(await row(id)).status, (await row(id)).translation_skipped], ['new', false]);
});

test('TRANSLATE_MIN_PRIORITY=off translates everything', async () => {
  process.env.TRANSLATE_MIN_PRIORITY = 'off';
  const id = await newItem('صباح الخير');
  const { translate } = await triageBatch([{ id, raw_text: 'صباح الخير' }]);
  assert.equal(translate.length, 1);
});
