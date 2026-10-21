import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../db/pool.js';
import { packPosts, unpackPosts, drainBatch } from './drainBacklog.js';

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

test('drain: first available provider wins; missing posts go back to the queue; out-of-allowance provider is rested', async () => {
  const a = await post('خبر أول');
  const b = await post('خبر ثان');
  const resting = new Map();
  const tried = [];
  const llm = async (messages, { providerName }) => {
    tried.push(providerName);
    if (providerName === 'cerebras') throw new Error('Cerebras rate limit: every configured model reached its daily limit');
    return { content: '<POST ID="1" LANG="ar">First news</POST>', model: 'm' };
  };
  const n = await drainBatch([a, b], ['cerebras', 'mistral'], { llm, resting, log: quiet });
  assert.equal(n, 1);
  assert.deepEqual(tried, ['cerebras', 'mistral']);
  assert.ok(resting.get('cerebras') > Date.now());
  const sa = await statusOf(a.id);
  assert.deepEqual([sa.status, sa.translated_text, sa.source_language], ['translated', 'First news', 'ar']);
  assert.equal((await statusOf(b.id)).status, 'new', 'left out by the model: back to the queue');

  await assert.rejects(drainBatch([b], ['cerebras'], { llm, resting, log: quiet }), /every provider is resting/);
});
