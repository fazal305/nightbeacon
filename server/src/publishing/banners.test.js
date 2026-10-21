import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pool } from '../db/pool.js';
import { pickBanner, isHeadlinePost, applyBanners } from './banners.js';
import { ffmpegAvailable } from './mediaCompare.js';

const dir = path.resolve('channels/banners/r3syst');
const channel = { key: 'r3syst', banners: { dir, replace: true, textPosts: true, digest: true } };

after(() => pool.end());

test('the banner is picked from the post\'s wording', () => {
  assert.equal(pickBanner('🔴 BREAKING: IOF strikes south Lebanon'), 'breaking.jpg');
  assert.equal(pickBanner('⚡ URGENT | Explosion at the port'), 'urgent.jpg');
  assert.equal(pickBanner('🚨 Sirens sounding in the north'), 'alert.jpg');
  assert.equal(pickBanner('🔴 LIVE: coverage from the border'), 'live.jpg');
  assert.equal(pickBanner('DEVELOPING: more details soon'), 'developing.jpg');
  assert.equal(pickBanner('UPDATE: toll rises to 12'), 'update.jpg');
  assert.equal(pickBanner('Some news', { official: true }), 'statement.jpg');
  assert.equal(pickBanner('anything', { digest: true }), 'summary.jpg');
  assert.equal(isHeadlinePost('🔴 BREAKING: x'), true);
  assert.equal(isHeadlinePost('The ministry said on Tuesday that talks continue.'), false);
});

test('banners exist for every template name', () => {
  for (const n of ['breaking', 'urgent', 'live', 'developing', 'statement', 'update', 'alert', 'summary']) {
    assert.ok(fs.existsSync(path.join(dir, `${n}.jpg`)), n);
  }
});

test('headline post without media gets a banner; plain posts and real photos stay as they are; digest gets the summary banner', async () => {
  let r = await applyBanners({ channel, media: [], text: '⚡ URGENT | Explosion at the port' });
  assert.equal(path.basename(r.media[0].file), 'urgent.jpg');
  r = await applyBanners({ channel, media: [], text: 'Talks resumed in Doha, the ministry said.' });
  assert.equal(r.media.length, 0);
  r = await applyBanners({ channel, media: [], text: 'x', digest: true });
  assert.equal(path.basename(r.media[0].file), 'summary.jpg');
  const photo = [{ kind: 'photo', file: '/tmp/real.jpg' }];
  r = await applyBanners({ channel, media: photo, text: '🔴 BREAKING' }, { hashFn: async () => Array(64).fill(0), knownFn: async () => [Array(64).fill(1)], load: async () => null, save: async () => {} });
  if (ffmpegAvailable()) assert.equal(r.media, photo, 'a photo unlike any card is kept');
});

test('another channel\'s generic card is swapped for our banner (recognised from banners/known)', { skip: !ffmpegAvailable() && 'ffmpeg not installed' }, async () => {
  // A re-encoded, resized copy of the known card, as a channel would post it.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-banner-'));
  const card = path.join(tmp, 'card.jpg');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', path.resolve('channels/banners/known/akhbarjm-khabar-fori.jpg'), '-vf', 'scale=1280:-2', '-q:v', '8', card]);
  const r = await applyBanners(
    { channel, media: [{ kind: 'photo', file: card }], text: '🔴 BREAKING | Strike on the port', storyId: 1 },
    { load: async () => null, save: async () => {} }
  );
  assert.equal(path.basename(r.media[0].file), 'breaking.jpg');
  assert.match(r.note, /generic news card/);

  // A real news photo (test pattern here) is not touched.
  const real = path.join(tmp, 'real.jpg');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:duration=1', '-frames:v', '1', real]);
  const kept = await applyBanners({ channel, media: [{ kind: 'photo', file: real }], text: '🔴 BREAKING', storyId: 2 }, { load: async () => null, save: async () => {} });
  assert.equal(kept.media[0].file, real);
});

test('a picture that keeps coming with different stories is learned as a template card', { skip: !ffmpegAvailable() && 'ffmpeg not installed' }, async () => {
  let saved = null;
  const deps = { knownFn: async () => [], hashFn: async () => Array(64).fill(0).map((_, i) => i % 2), load: async () => (saved ? { value: saved } : null), save: async (_k, v) => { saved = v; } };
  const photo = [{ kind: 'photo', file: '/tmp/x.jpg' }];
  for (const story of [11, 12]) assert.equal((await applyBanners({ channel, media: photo, text: 'x', storyId: story }, deps)).media, photo);
  const third = await applyBanners({ channel, media: photo, text: 'LIVE: x', storyId: 13 }, deps);
  assert.equal(path.basename(third.media[0].file), 'live.jpg');
});
