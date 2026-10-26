import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { applyWatermark, quietestCorner, placement, cornerScores, hasWatermark, cornerHashes, matchesEarlierCorners } from './watermark.js';
import { ffmpegAvailable } from './mediaCompare.js';

const hasFfmpeg = ffmpegAvailable();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-wm-'));
const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'ignore' });
// The demo channel's test banners and logo (src/publishing/fixtures/banners/demo).
const channel = (key) => ({ key, banners: { dir: path.resolve('src/publishing/fixtures/banners/demo'), watermark: true } });

test('placement: small, never wider than a third of the picture', () => {
  const wide = placement(1280, 720, { w: 980, h: 361 });
  assert.ok(wide.lw <= 1280 * 0.35 && wide.lw >= 64);
  const round = placement(720, 1280, { w: 780, h: 806 });
  assert.ok(round.lw <= 720 * 0.22, 'round logo stays small');
});

test('the quietest corner wins; bottom-right on a tie', () => {
  assert.equal(quietestCorner({ tl: 10, tr: 10, bl: 10, br: 10 }), 'br');
  assert.equal(quietestCorner({ tl: 1, tr: 50, bl: 50, br: 50 }), 'tl');
  const f = Buffer.alloc(160 * 90, 128);
  for (let y = 60; y < 90; y++) for (let x = 110; x < 160; x++) f[y * 160 + x] = (x + y) % 2 ? 0 : 255; // busy bottom-right
  const s = cornerScores([f], 90, { w: 40, h: 20 });
  assert.notEqual(quietestCorner(s), 'br');
});

test('photo: logo goes in an empty corner, not over another channel\'s logo or the busy part', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  // Plain sky with detail on the left half and another channel's logo bottom-right.
  const file = path.join(dir, 'photo.jpg');
  ff(['-f', 'lavfi', '-i', 'color=c=0x6699cc:s=1280x720', '-f', 'lavfi', '-i', 'testsrc2=size=640x720', '-filter_complex',
    '[0][1]overlay=0:0,drawbox=x=1060:y=600:w=200:h=100:color=white@1:t=fill,drawtext=text=LOGO:x=1090:y=630:fontsize=40:fontcolor=red',
    '-frames:v', '1', file]);
  const [out] = await applyWatermark(channel('demo'), [{ kind: 'photo', file, name: 'photo.jpg' }]);
  assert.notEqual(out.file, file);
  assert.ok(fs.existsSync(out.file));
  // The top-right corner (the only empty one) changed; the left half didn't.
  const crop = (f, x, y) => execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-vf', `crop=200:120:${x}:${y},scale=20:12,format=gray`, '-f', 'rawvideo', '-']);
  const diff = (x, y) => crop(file, x, y).reduce((s, v, i) => s + Math.abs(v - crop(out.file, x, y)[i]), 0);
  assert.ok(diff(1060, 10) > 500, `top-right got the logo (${diff(1060, 10)})`);
  assert.ok(diff(1060, 590) < 300, 'the other logo is left alone');
  assert.ok(diff(10, 590) < 300, 'busy area untouched');
});

test('video: watermarked, sound kept, our own banner never watermarked', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const file = path.join(dir, 'clip.mp4');
  // Fully moving picture (no fixed overlay), so nothing counts as an existing logo.
  ff(['-f', 'lavfi', '-i', 'mandelbrot=s=640x360:rate=15', '-f', 'lavfi', '-i', 'sine=duration=3', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file]);
  const banner = { kind: 'photo', file: path.resolve('src/publishing/fixtures/banners/demo/breaking.jpg'), name: 'breaking.jpg' };
  const [v, b] = await applyWatermark(channel('other'), [{ kind: 'video', file, name: 'clip.mp4', duration: 3 }, banner]);
  assert.match(path.basename(v.file), /^wm-other-clip\.mp4$/);
  const streams = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', v.file]).toString();
  assert.match(streams, /video/);
  assert.match(streams, /audio/);
  assert.equal(b.file, banner.file);
});

test('official channels\' photos/videos are posted without our logo', async () => {
  const media = [{ kind: 'photo', file: '/tmp/x.jpg', name: 'x.jpg' }];
  const out = await applyWatermark(channel('demo'), media, { source: 'someofficial', official: true, detect: async () => false });
  assert.equal(out[0].file, '/tmp/x.jpg');
});

test('video: a logo that stays put while the footage moves is detected; a clean moving clip is not', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const clean = path.join(dir, 'moving.mp4');
  const stamped = path.join(dir, 'stamped.mp4');
  ff(['-f', 'lavfi', '-i', 'mandelbrot=s=640x360:rate=10', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clean]);
  ff(['-i', clean, '-vf', "drawbox=x=500:y=300:w=130:h=50:color=black@0.6:t=fill,drawtext=text='@OtherChannel':x=508:y=312:fontsize=18:fontcolor=white",
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', stamped]);
  let saved = {};
  const deps = { loadSources: async () => saved, saveSources: async (v) => { saved = v; } };
  assert.equal(await hasWatermark({ kind: 'video', file: clean, duration: 4 }, 'cleanchan', deps), false);
  assert.equal(await hasWatermark({ kind: 'video', file: stamped, duration: 4 }, 'stampchan', deps), true);
  // That channel stamps its media: its photos are left alone too.
  assert.equal(await hasWatermark({ kind: 'photo', file: '/nope.jpg' }, 'stampchan', deps), true);
  const out = await applyWatermark(channel('demo'), [{ kind: 'video', file: stamped, name: 'stamped.mp4', duration: 4 }], {
    source: 'stampchan', detect: (m, s) => hasWatermark(m, s, deps),
  });
  assert.equal(out[0].file, stamped, 'not watermarked again');
});

test('photo: a corner that looks the same on a channel\'s different photos is its watermark', () => {
  const gw = 160;
  const gh = 90;
  const photo = (seed, stamp) => {
    const f = Buffer.alloc(gw * gh);
    for (let i = 0; i < f.length; i++) f[i] = (Math.sin(i * 0.37 * seed) * 60 + 128 + ((i % gw) * seed) % 40) | 0;
    if (stamp) for (let y = 70; y < 90; y++) for (let x = 115; x < 160; x++) f[y * gw + x] = ((x >> 2) + (y >> 2)) % 2 ? 250 : 10;
    return f;
  };
  const earlier = [cornerHashes(photo(1.3, true), gw, gh), cornerHashes(photo(2.1, true), gw, gh)];
  assert.equal(matchesEarlierCorners(cornerHashes(photo(3.7, true), gw, gh), earlier), true);
  assert.equal(matchesEarlierCorners(cornerHashes(photo(3.7, false), gw, gh), earlier), false);
});
