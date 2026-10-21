import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../db/pool.js';
import { packPosts, unpackPosts, translateWith } from './drainBacklog.js';

let sourceId;
const quiet = () => {};
async function post(text) {
  const { rows } = await pool.query(
    `INSERT INTO raw_items (source_id, telegram_message_id, telegram_date, raw_text, status, dedup_status)
     VALUES ($1, (random() * 1e9)::int, now(), $2, 'translating', 'unique') RETURNING id, raw_text`,
    [sourceId, text]
  );
  return rows[0];
}
const statusOf = async (id) =>
  (await pool.query('SELECT ri.status, t.translated_text, t.model, t.source_language FROM raw_items ri LEFT JOIN translations t ON t.raw_item_id = ri.id WHERE ri.id = $1', [id])).rows[0];

before(async () => {
  sourceId = (await pool.query(`INSERT INTO sources (channel_username, display_name) VALUES ($1, 'D') RETURNING id`, [`drain_${Date.now()}`])).rows[0].id;
});
after(async () => {
  await pool.query('DELETE FROM raw_items WHERE source_id = $1', [sourceId]);
  await pool.query('DELETE FROM sources WHERE id = $1', [sourceId]);
  await pool.end();
});

test('drain: posts are tagged with short numbers, line breaks kept; replies parsed defensively', () => {
  assert.equal(packPosts([{ raw_text: 'سطر\nثاني' }, { raw_text: 'b' }]), '<POST ID="1">سطر\nثاني</POST>\n<POST ID="2">b</POST>');
  const got = unpackPosts('junk <POST ID="2" LANG="FA">Two</POST>\n<POST ID="1">Line\nnext</POST><POST ID="9">out of range</POST><POST ID="1">dup</POST>', 2);
  assert.deepEqual(Object.fromEntries(got), { 2: { en: 'Two', lang: 'fa' }, 1: { en: 'Line\nnext', lang: null } });
});

test('drain: an LLM provider translates its batch; posts it leaves out go back; out of allowance means rest', async () => {
  const a = await post('خبر أول');
  const b = await post('خبر ثان');
  const llm = async () => ({ content: '<POST ID="1" LANG="ar">First news</POST>', model: 'm' });
  const r = await translateWith('mistral', [a, b], { llm });
  assert.equal(r.done, 1);
  assert.deepEqual(r.failedIds, [b.id], 'this provider will not be handed the same post again');
  const sa = await statusOf(a.id);
  assert.deepEqual([sa.status, sa.translated_text, sa.source_language], ['translated', 'First news', 'ar']);
  assert.equal((await statusOf(b.id)).status, 'new');

  const c = await post('خبر ثالث');
  const tired = await translateWith('mistral', [c], { llm: async () => { throw new Error('Mistral rate limit: every configured model reached its daily limit'); } });
  assert.ok(tired.restMs > 0);
  assert.deepEqual(tired.failedIds, [], 'a rest is not the post\'s fault');
  assert.equal((await statusOf(c.id)).status, 'new');
});

test('drain: a web translator (e.g. DeepL) goes through the shared provider runner', async () => {
  const a = await post('Срочно');
  const b = await post('Ещё');
  const web = async (name, items) => ({ done: new Map([[items[0].id, { text: 'Urgent', lang: 'ru', model: name }]]), errors: new Map(), restMs: null });
  const r = await translateWith('deepl', [a, b], { web });
  assert.equal(r.done, 1);
  const sa = await statusOf(a.id);
  assert.deepEqual([sa.translated_text, sa.model], ['Urgent', 'deepl']);
  assert.equal((await statusOf(b.id)).status, 'new');
});
