import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ffmpegAvailable, chooseCleanest, dhash, hamming, correlation } from './mediaCompare.js';

const hasFfmpeg = ffmpegAvailable();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-media-'));
const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'ignore' });

// A 6 s test clip with sound; reposts stamp a white "logo" box in a corner.
function clip(name, { logo = null, scale = '320:180', tone = 440, pattern = 'testsrc2' } = {}) {
  const file = path.join(dir, name);
  const vf = [`scale=${scale}`, logo ? `drawbox=${logo}:color=white@1:t=fill` : null].filter(Boolean).join(',');
  ff(['-f', 'lavfi', '-i', `${pattern}=size=320x180:rate=15:duration=6`, '-f', 'lavfi', '-i', `sine=frequency=${tone}:duration=6:beep_factor=4`,
    '-vf', vf, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file]);
  const [w, h] = scale.split(':').map(Number);
  return [{ kind: 'video', file, duration: 6, w, h, name }];
}

test('dhash / hamming / correlation basics', () => {
  const flat = Buffer.alloc(64 * 36, 100);
  const ramp = Buffer.from(Array.from({ length: 64 * 36 }, (_, i) => (i % 64) * 3));
  assert.equal(hamming(dhash(flat), dhash(flat)), 0);
  assert.ok(hamming(dhash(flat), dhash(ramp)) > 20);
  assert.ok(correlation([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]) > 0.99);
});

test('the copy without a channel logo is picked; a different clip is never swapped in', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const stampedEarly = clip('a.mp4', { logo: 'x=230:y=8:w=80:h=40' });
  const clean = clip('b.mp4');
  const stampedOther = clip('c.mp4', { logo: 'x=8:y=130:w=90:h=40' });
  const copies = [stampedEarly, clean, stampedOther].map((media, i) => ({ rawItemId: 100 + i, media, order: i }));
  const { pick, note } = await chooseCleanest(copies);
  assert.equal(pick.rawItemId, 101, 'the clean copy');
  assert.match(note, /cleanest of 3 copies/);

  // A different video (other picture and sound) is not "the same clip".
  const different = clip('d.mp4', { tone: 900, pattern: 'rgbtestsrc' });
  const r = await chooseCleanest([{ rawItemId: 1, media: stampedEarly, order: 0 }, { rawItemId: 2, media: different, order: 1 }]);
  assert.equal(r.pick.rawItemId, 1);
  assert.equal(r.note, null);
});

test('two copies of the same clip: the higher-resolution one wins, otherwise the earlier one', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const small = clip('e.mp4', { scale: '320:180' });
  const big = clip('f.mp4', { scale: '640:360' });
  const r = await chooseCleanest([{ rawItemId: 1, media: small, order: 0 }, { rawItemId: 2, media: big, order: 1 }]);
  assert.equal(r.pick.rawItemId, 2);
});

test('fingerprinting failures keep the first copy', async () => {
  const copies = [{ rawItemId: 1, media: [{ kind: 'video', file: '/nope/1.mp4', duration: 5 }], order: 0 }, { rawItemId: 2, media: [{ kind: 'video', file: '/nope/2.mp4', duration: 5 }], order: 1 }];
  const r = await chooseCleanest(copies, { fingerprintFn: async () => { throw new Error('bad file'); } });
  assert.equal(r.pick.rawItemId, 1);
});

test('photos: the copy without a logo is picked', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const photo = (name, logo) => {
    const file = path.join(dir, name);
    ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:duration=1', '-frames:v', '1', ...(logo ? ['-vf', `drawbox=${logo}:color=white@1:t=fill`] : []), file]);
    return [{ kind: 'photo', file, w: 640, h: 360 }];
  };
  const copies = [photo('p1.jpg', 'x=500:y=10:w=130:h=60'), photo('p2.jpg', 'x=10:y=290:w=150:h=60'), photo('p3.jpg', null)]
    .map((media, i) => ({ rawItemId: 200 + i, media, order: i }));
  assert.equal((await chooseCleanest(copies)).pick.rawItemId, 202);
});
