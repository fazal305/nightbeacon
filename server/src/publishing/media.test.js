import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Api } from 'telegram';
import { pool } from '../db/pool.js';
import { describeMedia, loadItemMedia, loadBestMedia, uploadAttributes } from './media.js';

// Real Postgres; the Telegram client is a fake.
let sourceId;
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-media-test-'));

const photoMsg = (id, groupedId) =>
  Object.assign(new Api.Message({ id, peerId: new Api.PeerChannel({ channelId: 1n }), message: '', date: 0 }), {
    groupedId,
    media: new Api.MessageMediaPhoto({
      photo: new Api.Photo({ id: 1n, accessHash: 1n, fileReference: Buffer.alloc(0), date: 0, dcId: 2, sizes: [new Api.PhotoSize({ type: 'y', w: 1280, h: 720, size: 90000 })] }),
    }),
  });
const videoMsg = (id, groupedId, size = 2_000_000, extra = []) =>
  Object.assign(new Api.Message({ id, peerId: new Api.PeerChannel({ channelId: 1n }), message: '', date: 0 }), {
    groupedId,
    media: new Api.MessageMediaDocument({
      document: new Api.Document({
        id: 2n, accessHash: 2n, fileReference: Buffer.alloc(0), date: 0, dcId: 2, mimeType: 'video/mp4', size: BigInt(size),
        attributes: [new Api.DocumentAttributeVideo({ duration: 31, w: 1920, h: 1080, supportsStreaming: true }), ...extra],
      }),
    }),
  });

function fakeClient(messages) {
  const calls = { getMessages: 0, download: 0 };
  return {
    calls,
    getMessages: async (peer, { ids }) => (calls.getMessages++, ids.map((id) => messages.find((m) => m.id === id)).filter(Boolean)),
    downloadMedia: async (m) => (calls.download++, Buffer.from(`file-${m.id}`)),
  };
}

async function item(messageId, hasMedia = true, { src = sourceId, minutesAgo = 0 } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO raw_items (source_id, telegram_message_id, telegram_date, raw_text, has_media)
     VALUES ($1, $2, now() - make_interval(mins => $4), 'x', $3) RETURNING id`,
    [src, messageId, hasMedia, minutesAgo]
  );
  return rows[0].id;
}

before(async () => {
  process.env.PUBLISH_MEDIA_CACHE_DIR = cacheDir;
  sourceId = (
    await pool.query(
      `INSERT INTO sources (channel_username, display_name, telegram_channel_id, telegram_access_hash) VALUES ($1, 'Src', 1, 2) RETURNING id`,
      [`media_src_${Date.now()}`]
    )
  ).rows[0].id;
});
after(async () => {
  await pool.query('DELETE FROM raw_items WHERE source_id = $1', [sourceId]);
  await pool.query('DELETE FROM sources WHERE id = $1', [sourceId]);
  fs.rmSync(cacheDir, { recursive: true, force: true });
  delete process.env.PUBLISH_MEDIA_CACHE_DIR;
  await pool.end();
});

test('media: photos, videos and GIFs can be reposted; stickers, round videos and files cannot', () => {
  assert.equal(describeMedia(photoMsg(1)).kind, 'photo');
  const v = describeMedia(videoMsg(2));
  assert.deepEqual([v.kind, v.duration, v.w, v.h, v.size], ['video', 31, 1920, 1080, 2_000_000]);
  assert.equal(describeMedia(videoMsg(3, null, 10, [new Api.DocumentAttributeAnimated()])).kind, 'gif');
  const sticker = videoMsg(4, null, 10, [new Api.DocumentAttributeSticker({ alt: '', stickerset: new Api.InputStickerSetEmpty() })]);
  assert.equal(describeMedia(sticker), null);
  const pdf = videoMsg(5);
  pdf.media.document.mimeType = 'application/pdf';
  pdf.media.document.attributes = [];
  assert.equal(describeMedia(pdf), null);
  assert.equal(describeMedia({ media: null }), null);
});

test('media: a whole album is downloaded once (then served from the cache); oversized files are left out', async () => {
  const g = 777n;
  const client = fakeClient([photoMsg(50, g), videoMsg(51, g), videoMsg(52, g, 500 * 1024 * 1024), photoMsg(53, 999n)]);
  const id = await item(51);
  const media = await loadItemMedia(id, { client });
  assert.deepEqual(media.map((m) => m.kind), ['photo', 'video'], 'album order kept; 500 MB video and other album left out');
  assert.equal(fs.readFileSync(media[1].file, 'utf8'), 'file-51');
  assert.equal(client.calls.download, 2);

  const again = await loadItemMedia(id, { client });
  assert.equal(again.length, 2);
  assert.equal(client.calls.download, 2, 'second request served from the cache');
});

test('media: a post without media needs no Telegram call; upload attributes make videos playable', async () => {
  const client = fakeClient([]);
  assert.deepEqual(await loadItemMedia(await item(60, false), { client }), []);
  assert.equal(client.calls.getMessages, 0);
  assert.deepEqual(uploadAttributes({ kind: 'photo' }), []);
  const attrs = uploadAttributes({ kind: 'gif', name: '1.mp4', duration: 5, w: 10, h: 20 });
  assert.ok(attrs[0] instanceof Api.DocumentAttributeVideo && attrs[0].duration === 5 && attrs[0].supportsStreaming);
  assert.ok(attrs.some((a) => a instanceof Api.DocumentAttributeAnimated));
});

test('media: the cleanest copy of a story is used — official channel first, then the earliest poster', async () => {
  const other = (
    await pool.query(`INSERT INTO sources (channel_username, display_name) VALUES ($1, 'Official') RETURNING id, channel_username`, [`official_${Date.now()}`])
  ).rows[0];
  try {
    const repost = await item(70, true, { minutesAgo: 5 });
    const original = await item(71, true, { minutesAgo: 20 });
    const official = await item(72, true, { src: other.id, minutesAgo: 1 });
    const noMedia = await item(73, false, { minutesAgo: 60 });
    const story = (
      await pool.query(`INSERT INTO stories (canonical_item_id, normalized_text, content_hash, first_seen_at, last_seen_at) VALUES ($1, 'm', md5(random()::text), now(), now()) RETURNING id`, [repost])
    ).rows[0].id;
    await pool.query('UPDATE raw_items SET story_id = $2 WHERE id = ANY($1)', [[repost, original, official, noMedia], story]);
    const tried = [];
    const loadMedia = async (id) => (tried.push(id), [{ kind: 'photo', name: '1.jpg' }]);

    assert.equal((await loadBestMedia(repost, { loadMedia })).rawItemId, Number(original), 'earliest poster');
    assert.equal((await loadBestMedia(repost, { officialUsernames: [other.channel_username], loadMedia })).rawItemId, Number(official));

    const failing = async (id) => (id === Number(official) ? Promise.reject(new Error('gone')) : [{ kind: 'photo', name: '1.jpg' }]);
    assert.equal((await loadBestMedia(repost, { officialUsernames: [other.channel_username], loadMedia: failing })).rawItemId, Number(original), 'falls back to the next copy');
    await pool.query(`DELETE FROM raw_items WHERE story_id = $1`, [story]);
    await pool.query(`DELETE FROM stories WHERE id = $1`, [story]);
  } finally {
    await pool.query('DELETE FROM raw_items WHERE source_id = $1', [other.id]);
    await pool.query('DELETE FROM sources WHERE id = $1', [other.id]);
  }
});
