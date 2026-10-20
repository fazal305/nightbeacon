import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../db/pool.js';
import { runDedupTick, _resetSemanticIndex } from './dedupWorker.js';
import { runTranslationTick } from '../processing/translate.js';
import { l2normalize } from './embeddings.js';

// Real Postgres (pg_trgm, advisory lock, story writes); only the embedding
// model is faked — deterministic vectors stand in for "these two texts in
// different languages mean the same thing".

let sourceA;
let sourceB;
let msgId = 1;

async function insertItem(sourceId, text, { minutesAgo = 0 } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO raw_items (source_id, telegram_message_id, telegram_date, raw_text)
     VALUES ($1, $2, now() - make_interval(mins => $4), $3) RETURNING id`,
    [sourceId, msgId++, text, minutesAgo]
  );
  return rows[0].id;
}

async function getItem(id) {
  const { rows } = await pool.query(
    'SELECT status, dedup_status, dedup_method, story_id FROM raw_items WHERE id = $1',
    [id]
  );
  return rows[0];
}

before(async () => {
  // Neutralise pending rows left by other runs so ticks only see ours.
  await pool.query(`UPDATE raw_items SET dedup_status = 'legacy' WHERE dedup_status = 'pending'`);
  const mk = async (name) =>
    (
      await pool.query(`INSERT INTO sources (channel_username, display_name) VALUES ($1, $1) RETURNING id`, [
        `${name}_${Date.now()}`,
      ])
    ).rows[0].id;
  sourceA = await mk('dedup_a');
  sourceB = await mk('dedup_b');
});

beforeEach(() => {
  delete process.env.EMBEDDING_PROVIDER;
  _resetSemanticIndex();
});

after(async () => {
  await pool.query('DELETE FROM raw_items WHERE source_id = ANY($1)', [[sourceA, sourceB]]);
  await pool.query('DELETE FROM sources WHERE id = ANY($1)', [[sourceA, sourceB]]);
  await pool.end();
});

test('exact relay in another channel becomes a duplicate of the first story and skips translation', async () => {
  const first = await insertItem(sourceA, '🔴 عاجل: انفجار قوي يهز ميناء المدينة الشمالي صباح اليوم https://t.me/a/1', {
    minutesAgo: 5,
  });
  const relay = await insertItem(sourceB, 'عاجل - انفجار قوي يهز ميناء المدينة الشمالي صباح اليوم\n@relay_channel');

  const results = await runDedupTick();
  assert.ok(results.length >= 2);

  const a = await getItem(first);
  const b = await getItem(relay);
  assert.equal(a.dedup_status, 'unique');
  assert.equal(b.dedup_status, 'duplicate');
  assert.equal(b.dedup_method, 'exact');
  assert.equal(b.story_id, a.story_id);
  assert.equal(b.status, 'duplicate');

  const story = await pool.query('SELECT item_count FROM stories WHERE id = $1', [a.story_id]);
  assert.equal(story.rows[0].item_count, 2);

  // Translation only claims the unique one.
  await runTranslationTick();
  assert.equal((await getItem(relay)).status, 'duplicate');
});

test('pending (not yet deduped) items are never claimed for translation', async () => {
  const id = await insertItem(sourceA, 'خبر لم يمر بعد على فحص التكرار في النظام الجديد');
  await runTranslationTick();
  const row = await getItem(id);
  assert.equal(row.dedup_status, 'pending');
  assert.equal(row.status, 'new');
  await runDedupTick();
});

test('near-duplicate with an updated casualty figure is recorded as an update to the same story', async () => {
  const first = await insertItem(sourceA, 'Missile strike on Kharkiv railway station: 14 killed, dozens injured, rescue ongoing', {
    minutesAgo: 10,
  });
  await runDedupTick();
  const update = await insertItem(sourceB, 'Missile strike on Kharkiv railway station: 19 killed, dozens injured, rescue ongoing');
  await runDedupTick();

  const a = await getItem(first);
  const u = await getItem(update);
  assert.equal(u.dedup_status, 'update');
  assert.equal(u.dedup_method, 'fuzzy');
  assert.equal(u.story_id, a.story_id);
  assert.equal(u.status, 'new', 'updates continue to translation/classification');

  const story = await pool.query('SELECT numbers, update_count FROM stories WHERE id = $1', [a.story_id]);
  assert.deepEqual(story.rows[0].numbers, ['14', '19']);
  assert.equal(story.rows[0].update_count, 1);
});

test('cross-language duplicate is matched semantically from the ORIGINAL texts (no translation)', async () => {
  process.env.EMBEDDING_PROVIDER = 'ollama';
  const event = l2normalize([1, 0.1, 0, 0]);
  const other = l2normalize([0, 0, 1, 0.2]);
  const vectors = {
    'Israeli army announces withdrawal of armored brigade from the northern sector tonight': event,
    'ارتش اسرائیل از خروج تیپ زرهی از بخش شمالی در امشب خبر داد': event,
    'Heavy rain causes flooding in the capital, schools closed tomorrow across the region': other,
  };
  const seenTexts = [];
  const embed = async (texts) => {
    seenTexts.push(...texts);
    return texts.map((t) => vectors[t] ?? l2normalize([0, 1, 0, 0]));
  };

  const en = await insertItem(sourceA, 'Israeli army announces withdrawal of armored brigade from the northern sector tonight', {
    minutesAgo: 3,
  });
  await runDedupTick({ embed });
  const fa = await insertItem(sourceB, 'ارتش اسرائیل از خروج تیپ زرهی از بخش شمالی در امشب خبر داد');
  const unrelated = await insertItem(sourceB, 'Heavy rain causes flooding in the capital, schools closed tomorrow across the region');
  await runDedupTick({ embed });

  const faRow = await getItem(fa);
  assert.equal(faRow.dedup_status, 'duplicate');
  assert.equal(faRow.dedup_method, 'semantic');
  assert.equal(faRow.story_id, (await getItem(en)).story_id);
  assert.equal((await getItem(unrelated)).dedup_status, 'unique');
  // The Persian text itself was embedded — not a translation of it.
  assert.ok(seenTexts.includes('ارتش اسرائیل از خروج تیپ زرهی از بخش شمالی در امشب خبر داد'));
});

test('embedding provider failure does not block dedup: cheap checks still run and items move on', async () => {
  process.env.EMBEDDING_PROVIDER = 'ollama';
  const id = await insertItem(sourceA, 'A completely new and unrelated report about a port closure in the south');
  await runDedupTick({ embed: async () => null });
  assert.equal((await getItem(id)).dedup_status, 'unique');
});
