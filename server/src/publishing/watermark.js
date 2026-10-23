import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { ffmpegAvailable, hamming } from './mediaCompare.js';
import { getState, setState } from '../db/appState.js';

// Puts the channel's logo (banners/<channel>/watermark.png) on reposted
// photos and videos, without hiding anything that matters:
//   - small (about a quarter of the picture's shorter side for a wide logo,
//     a fifth for a round one) and 70% opaque;
//   - in the corner with the least going on — measured on a few frames — so
//     it doesn't cover faces, text or action, and skips a corner where
//     another channel already put its logo (logos are busy, detailed areas).
// Never watermarked: the channel's own banners; media from official channels
// (official-sources.md); media that already carries someone's logo:
//   - videos: a logo stays put while the footage moves, so a detailed patch
//     along the edge that doesn't change across frames is a watermark;
//   - photos: a source channel whose videos carry a watermark stamps its
//     photos too; and a photo whose corner looks the same as that corner on
//     other photos from the same channel (while the photos differ) has one.
// Videos are re-encoded
// (H.264, sound copied); very long or large ones are posted as they are.
// Needs ffmpeg; any problem means the original file is posted.
const FFMPEG = () => process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = () => process.env.FFPROBE_PATH || (process.env.FFMPEG_PATH ? process.env.FFMPEG_PATH.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1') : 'ffprobe');
const OPACITY = Number(process.env.WATERMARK_OPACITY || 0.7);
const MAX_VIDEO_SECONDS = Number(process.env.WATERMARK_MAX_VIDEO_SECONDS || 600);
const MAX_VIDEO_MB = Number(process.env.WATERMARK_MAX_VIDEO_MB || 80);
const GW = 160; // analysis frame width

function run(cmd, args, timeout = 600000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout }, (err, stdout, stderr) =>
      err ? reject(new Error(`${String(stderr || err.message).trim().split('\n').pop()}`)) : resolve(stdout)
    );
  });
}

async function dimensions(file) {
  const out = (await run(FFPROBE(), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], 30000)).toString();
  const [w, h] = out.trim().split(',').map(Number);
  if (!w || !h) throw new Error('no picture size');
  return { w, h };
}

async function grayFrame(file, seconds, gh) {
  const buf = await run(FFMPEG(), ['-v', 'error', ...(seconds > 0 ? ['-ss', String(seconds)] : []), '-i', file, '-frames:v', '1',
    '-vf', `scale=${GW}:${gh},format=gray`, '-f', 'rawvideo', '-'], 60000);
  return buf.length >= GW * gh ? buf : null;
}

// Watermark size and margin in pixels for a picture of w×h.
export function placement(w, h, logo) {
  const short = Math.min(w, h);
  const wide = logo.w / logo.h > 1.6;
  let lw = Math.round(short * (wide ? 0.3 : 0.21));
  lw = Math.max(64, Math.min(lw, Math.round(w * 0.35)));
  const lh = Math.round((lw * logo.h) / logo.w);
  return { lw, lh, margin: Math.max(8, Math.round(short * 0.03)) };
}

// Detail (sum of brightness changes) inside each corner box, over all frames.
export function cornerScores(frames, gh, box) {
  const corners = { tl: [0, 0], tr: [GW - box.w, 0], bl: [0, gh - box.h], br: [GW - box.w, gh - box.h] };
  const scores = {};
  for (const [name, [x0, y0]] of Object.entries(corners)) {
    let s = 0;
    for (const f of frames) {
      for (let y = y0; y < y0 + box.h - 1; y++) {
        for (let x = x0; x < x0 + box.w - 1; x++) {
          const v = f[y * GW + x];
          s += Math.abs(v - f[y * GW + x + 1]) + Math.abs(v - f[(y + 1) * GW + x]);
        }
      }
    }
    scores[name] = s;
  }
  return scores;
}

// Bottom corners first on ties: viewers expect a logo there.
export function quietestCorner(scores) {
  const order = ['br', 'bl', 'tr', 'tl'];
  return order.reduce((best, c) => (scores[c] < scores[best] * 0.97 ? c : best), order[0]);
}

const OVERLAY = { tl: 'M:M', tr: 'W-w-M:M', bl: 'M:H-h-M', br: 'W-w-M:H-h-M' };

export async function watermarkFile(m, logoFile, outFile) {
  const { w, h } = await dimensions(m.file);
  const logo = await dimensions(logoFile);
  const { lw, lh, margin } = placement(w, h, logo);
  const gh = Math.max(16, Math.round((GW * h) / w));
  const times = m.kind === 'photo' ? [0] : [0.15, 0.5, 0.85].map((f) => Math.max(0.3, (m.duration || 0) * f));
  const frames = (await Promise.all(times.map((t) => grayFrame(m.file, m.kind === 'photo' ? 0 : t, gh).catch(() => null)))).filter(Boolean);
  const box = { w: Math.max(2, Math.round(((lw + margin) * GW) / w)), h: Math.max(2, Math.round(((lh + margin) * gh) / h)) };
  const corner = frames.length ? quietestCorner(cornerScores(frames, gh, box)) : 'br';
  const pos = OVERLAY[corner].replace(/M/g, String(margin));
  const graph = `[1]scale=${lw}:-1,format=rgba,colorchannelmixer=aa=${OPACITY}[l];[0:v][l]overlay=${pos}`;
  const args = ['-v', 'error', '-y', '-i', m.file, '-i', logoFile, '-filter_complex'];
  if (m.kind === 'photo') {
    await run(FFMPEG(), [...args, graph, '-q:v', '2', outFile]);
  } else {
    await run(FFMPEG(), [...args, `${graph},format=yuv420p`, '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21',
      '-c:a', 'copy', '-movflags', '+faststart', ...(m.kind === 'gif' ? ['-an'] : []), outFile]);
  }
  return { corner, size: fs.statSync(outFile).size };
}

// ---- existing watermark detection ----------------------------------------

const VIDEO_FRAMES = 8;
const GRID_X = 8;
const GRID_Y = 6;

// Video: a detailed patch on the picture's edge that stays still while the
// rest moves. Returns true / false, or null when the clip barely moves (a
// static shot can't tell a logo from the scene).
export function staticOverlay(frames, gw, gh) {
  const n = frames.length;
  const px = gw * gh;
  const std = new Float64Array(px);
  for (let p = 0; p < px; p++) {
    let m = 0;
    for (const f of frames) m += f[p];
    m /= n;
    let v = 0;
    for (const f of frames) v += (f[p] - m) ** 2;
    std[p] = Math.sqrt(v / n);
  }
  const motion = std.reduce((a, b) => a + b, 0) / px;
  if (motion < 6) return null;
  // Pixels that stay put and have sharp detail (letters, logo edges).
  const mark = new Uint8Array(px);
  for (let y = 0; y < gh - 1; y++) {
    for (let x = 0; x < gw - 1; x++) {
      const p = y * gw + x;
      if (std[p] > Math.max(3, motion * 0.15)) continue;
      let d = 0;
      for (const f of frames) d += Math.abs(f[p] - f[p + 1]) + Math.abs(f[p] - f[p + gw]);
      if (d / n > 18) mark[p] = 1;
    }
  }
  const cw = gw / GRID_X;
  const ch = gh / GRID_Y;
  for (let gy = 0; gy < GRID_Y; gy++) {
    for (let gx = 0; gx < GRID_X; gx++) {
      if (gy > 0 && gy < GRID_Y - 1 && gx > 0 && gx < GRID_X - 1) continue; // edge cells only
      let hits = 0;
      let count = 0;
      for (let y = Math.floor(gy * ch); y < Math.floor((gy + 1) * ch); y++) {
        for (let x = Math.floor(gx * cw); x < Math.floor((gx + 1) * cw); x++) {
          hits += mark[y * gw + x];
          count++;
        }
      }
      if (hits / count > 0.06) return true;
    }
  }
  return false;
}

// Generic 9×8 difference hash of a patch of a gray frame.
function patchHash(f, gw, x0, y0, w, h) {
  const cells = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 9; c++) {
      let s = 0;
      let k = 0;
      for (let y = y0 + Math.floor((r * h) / 8); y < y0 + Math.floor(((r + 1) * h) / 8); y++) {
        for (let x = x0 + Math.floor((c * w) / 9); x < x0 + Math.floor(((c + 1) * w) / 9); x++) {
          s += f[y * gw + x];
          k++;
        }
      }
      cells.push(k ? s / k : 0);
    }
  }
  const bits = [];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) bits.push(cells[r * 9 + c] < cells[r * 9 + c + 1] ? 1 : 0);
  return { bits, spread: Math.max(...cells) - Math.min(...cells) };
}

// Corner patches of a photo: { tl, tr, bl, br } -> hash bits, or null for a
// plain corner (sky, wall), which says nothing either way.
export function cornerHashes(f, gw, gh) {
  const w = Math.round(gw * 0.28);
  const h = Math.round(gh * 0.22);
  const at = { tl: [0, 0], tr: [gw - w, 0], bl: [0, gh - h], br: [gw - w, gh - h] };
  const out = {};
  for (const [k, [x, y]] of Object.entries(at)) {
    const { bits, spread } = patchHash(f, gw, x, y, w, h);
    out[k] = spread > 25 ? bits : null;
  }
  out.whole = patchHash(f, gw, 0, 0, gw, gh).bits;
  return out;
}

const SOURCES_KEY = 'watermark_sources';
async function loadSources() {
  try {
    return JSON.parse((await getState(SOURCES_KEY))?.value || '{}');
  } catch {
    return {};
  }
}

// A corner that matches the same corner of 2+ earlier, different photos from
// this channel is its watermark.
export function matchesEarlierCorners(hashes, earlier) {
  for (const k of ['tl', 'tr', 'bl', 'br']) {
    if (!hashes[k]) continue;
    const same = earlier.filter((e) => e[k] && hamming(e[k], hashes[k]) <= 8 && hamming(e.whole, hashes.whole) > 16);
    if (same.length >= 2) return true;
  }
  return false;
}

const toBits = (hex) => (hex ? BigInt(`0x${hex}`).toString(2).padStart(64, '0').split('').map(Number) : null);
const toHex = (bits) => (bits ? BigInt(`0b${bits.join('')}`).toString(16) : null);

// True when the file already carries someone's logo. Learns per source channel.
export async function hasWatermark(m, source, deps = {}) {
  const load = deps.loadSources || loadSources;
  const save = deps.saveSources || ((v) => setState(SOURCES_KEY, JSON.stringify(v)).catch(() => {}));
  const sources = await load();
  const entry = (source && sources[source]) || { marked: 0, corners: [] };
  // Its videos carry a logo: so do its photos.
  if (m.kind === 'photo' && entry.marked >= 1) return true;
  const { w, h } = await dimensions(m.file);
  const gh = Math.max(16, Math.round((GW * h) / w));
  let found;
  if (m.kind === 'photo') {
    const f = await grayFrame(m.file, 0, gh);
    if (!f) return false;
    const hashes = cornerHashes(f, GW, gh);
    const earlier = entry.corners.map((c) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, toBits(v)])));
    found = matchesEarlierCorners(hashes, earlier);
    entry.corners = [Object.fromEntries(Object.entries(hashes).map(([k, v]) => [k, toHex(v)])), ...entry.corners].slice(0, 30);
  } else {
    const d = m.duration || 0;
    const times = Array.from({ length: VIDEO_FRAMES }, (_, i) => Math.max(0.2, (d * (i + 0.5)) / VIDEO_FRAMES));
    const frames = (await Promise.all(times.map((t) => grayFrame(m.file, t, gh).catch(() => null)))).filter(Boolean);
    found = frames.length >= 4 ? staticOverlay(frames, GW, gh) : null;
    if (found) entry.marked = (entry.marked || 0) + 1;
  }
  if (source) {
    sources[source] = entry;
    await save(sources);
  }
  return Boolean(found);
}

// Returns the media with the logo added where possible (same order).
// `source` is the source channel's username, `official` whether it is an
// official channel (official-sources.md).
export async function applyWatermark(channel, media, { source = null, official = false, detect = hasWatermark } = {}) {
  const logoFile = channel.banners?.watermark && channel.banners.dir ? path.join(channel.banners.dir, 'watermark.png') : null;
  if (!logoFile || !fs.existsSync(logoFile) || media.length === 0 || !ffmpegAvailable()) return media;
  // The organisation's own photos/videos are posted as they are.
  if (official) return media;
  const out = [];
  for (const m of media) {
    // Our own banners already carry the logo.
    if (path.resolve(path.dirname(m.file)) === path.resolve(channel.banners.dir)) {
      out.push(m);
      continue;
    }
    // Already carries a logo (another channel's or anyone's): leave it.
    if (await detect(m, source).catch(() => false)) {
      console.log(`[publishing] ${m.name || 'media'} already has a watermark — not adding ours`);
      out.push(m);
      continue;
    }
    const tooBig = m.kind !== 'photo' && ((m.duration || 0) > MAX_VIDEO_SECONDS || (m.size || 0) > MAX_VIDEO_MB * 1048576);
    if (tooBig) {
      out.push(m);
      continue;
    }
    const ext = m.kind === 'photo' ? 'jpg' : 'mp4';
    const name = `wm-${channel.key}-${path.basename(m.name || m.file, path.extname(m.name || m.file))}.${ext}`;
    const outFile = path.join(path.dirname(m.file), name);
    try {
      let size;
      if (fs.existsSync(outFile)) size = fs.statSync(outFile).size;
      else ({ size } = await watermarkFile(m, logoFile, outFile));
      out.push({ ...m, file: outFile, name, size, mime: m.kind === 'photo' ? 'image/jpeg' : 'video/mp4' });
    } catch (err) {
      console.warn(`[publishing] could not add the watermark to ${m.name || m.file}: ${err.message} — posting it without`);
      fs.rmSync(outFile, { force: true });
      out.push(m);
    }
  }
  return out;
}
