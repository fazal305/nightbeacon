import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { ffmpegAvailable } from './mediaCompare.js';

// Puts the channel's logo (banners/<channel>/watermark.png) on reposted
// photos and videos, without hiding anything that matters:
//   - small (about a quarter of the picture's shorter side for a wide logo,
//     a fifth for a round one) and 70% opaque;
//   - in the corner with the least going on — measured on a few frames — so
//     it doesn't cover faces, text or action, and skips a corner where
//     another channel already put its logo (logos are busy, detailed areas).
// The channel's own banners are never watermarked. Videos are re-encoded
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

// Returns the media with the logo added where possible (same order).
export async function applyWatermark(channel, media) {
  const logoFile = channel.banners?.watermark && channel.banners.dir ? path.join(channel.banners.dir, 'watermark.png') : null;
  if (!logoFile || !fs.existsSync(logoFile) || media.length === 0 || !ffmpegAvailable()) return media;
  const out = [];
  for (const m of media) {
    // Our own banners already carry the logo.
    if (path.resolve(path.dirname(m.file)) === path.resolve(channel.banners.dir)) {
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
