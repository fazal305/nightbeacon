import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../db/pool.js';
import { runTranslationTick, translationRotation, translationProviders } from './translate.js';
import { parseGoogleReply, splitText } from './webTranslate.js';

// Real Postgres; the web translators' HTTP is faked.
let sourceId;
let msg = 1;
const realFetch = globalThis.fetch;

function fakeFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const host = new URL(url).hostname;
    calls.push(host);
    const [status, body] = handler(host, url, init);
    return {
      ok: status === 200,
      status,
      headers: { get: () => null },
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      json: async () => body,
    };
  };
  return calls;
}
const googleOk = (text) => [200, [[[text, 'orig']], null, 'ar']];
const lingvaOk = (text) => [200, { translation: text, info: { detectedSource: 'fa' } }];

async function newItem(text = 'خبر عاجل من المنطقة') {
  const { rows } = await pool.query(
    `INSERT INTO raw_items (source_id, telegram_message_id, telegram_date, raw_text, dedup_status)
     VALUES ($1, $2, now(), $3, 'unique') RETURNING id`,
    [sourceId, msg++, text]
  );
  return rows[0].id;
}
const state = async (id) =>
  (await pool.query(
    `SELECT ri.status, t.translated_text, t.model, t.source_language FROM raw_items ri
     LEFT JOIN translations t ON t.raw_item_id = ri.id WHERE ri.id = $1`,
    [id]
  )).rows[0];

before(async () => {
  sourceId = (
    await pool.query(`INSERT INTO sources (channel_username, display_name) VALUES ($1, 'Src') RETURNING id`, [`rot_src_${Date.now()}`])
  ).rows[0].id;
  process.env.GOOGLE_TRANSLATE_PER_MINUTE = '60000';
  process.env.LINGVA_TRANSLATE_PER_MINUTE = '60000';
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  translationRotation.reset();
  await pool.query('DELETE FROM raw_items WHERE source_id = $1', [sourceId]);
});
after(async () => {
  delete process.env.TRANSLATION_PROVIDER;
  await pool.query('DELETE FROM sources WHERE id = $1', [sourceId]);
  await pool.end();
});

test('rotation: google rate-limited -> rested, posts go to lingva; next tick skips google', async () => {
  process.env.TRANSLATION_PROVIDER = 'google,lingva';
  const a = await newItem();
  const b = await newItem();
  const calls = fakeFetch((host) => (host.includes('googleapis') ? [429, 'Too Many Requests'] : lingvaOk('Breaking news')));
  const res = await runTranslationTick();
  assert.equal(res.filter((r) => r.outcome === 'translated' && r.provider === 'lingva').length, 2);
  for (const id of [a, b]) {
    const s = await state(id);
    assert.deepEqual([s.status, s.translated_text, s.model, s.source_language], ['translated', 'Breaking news', 'lingva', 'fa']);
  }
  assert.equal(calls.filter((h) => h.includes('googleapis')).length, 1, 'google tried once, then rested');
  assert.ok(translationRotation.resting('google'));

  const c = await newItem();
  calls.length = 0;
  await runTranslationTick();
  assert.equal((await state(c)).model, 'lingva');
  assert.equal(calls.filter((h) => h.includes('googleapis')).length, 0, 'resting provider not called');
});

test('rotation: google works and is used first', async () => {
  process.env.TRANSLATION_PROVIDER = 'google,lingva';
  const a = await newItem();
  fakeFetch((host) => (host.includes('googleapis') ? googleOk('Air raid sirens in the north') : [500, 'should not be called']));
  await runTranslationTick();
  const s = await state(a);
  assert.deepEqual([s.translated_text, s.model, s.source_language], ['Air raid sirens in the north', 'google', 'ar']);
});

test('rotation: every provider unavailable -> posts go back to the queue untouched; nothing claimed while all rest', async () => {
  process.env.TRANSLATION_PROVIDER = 'google,lingva';
  const a = await newItem();
  fakeFetch(() => [503, 'down']);
  await runTranslationTick();
  assert.equal((await state(a)).status, 'new');
  assert.deepEqual(await runTranslationTick(), [], 'all resting: does not claim');
});

test('rotation: a post one provider rejects is offered to the next; rejected by all -> counted attempt', async () => {
  process.env.TRANSLATION_PROVIDER = 'google,lingva';
  const a = await newItem();
  fakeFetch((host) => (host.includes('googleapis') ? [400, 'bad request'] : lingvaOk('Fixed')));
  await runTranslationTick();
  assert.equal((await state(a)).model, 'lingva');

  const b = await newItem();
  fakeFetch(() => [400, 'bad request']);
  await runTranslationTick();
  assert.equal((await state(b)).status, 'failed_translation');
});

test('web translators: google reply parsing, long text splitting, provider list', () => {
  assert.deepEqual(parseGoogleReply([[['Hello ', 'مرحبا'], ['world', 'عالم']], null, 'AR']), { text: 'Hello world', lang: 'ar' });
  const long = 'Sentence one. '.repeat(500);
  const parts = splitText(long, 1500);
  assert.ok(parts.every((p) => p.length <= 1500));
  assert.equal(parts.join(''), long);
  assert.deepEqual(translationProviders({ TRANSLATION_PROVIDER: ' Telegram, google ,lingva' }), ['telegram', 'google', 'lingva']);
});
