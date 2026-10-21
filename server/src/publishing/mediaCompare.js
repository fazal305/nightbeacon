import { execFile, execFileSync } from 'node:child_process';

// Finds the cleanest copy of a story's photo/video when several channels
// posted it. Reposting channels stamp their logo on it, so:
//   1. copies are confirmed to be the SAME picture/clip — perceptual hashes of
//      frames at 20/50/80% of the clip (overlays change only a small corner,
//      so the hashes stay close), the same length, and for videos the same
//      sound (a loudness fingerprint of the first 30 s);
//   2. among them, the copy that differs least from the pixel-wise median of
//      all copies is the one without an extra logo (each logo is where only
//      that copy differs);
//   3. ties go to the higher resolution, then the earliest post.
// Needs ffmpeg (FFMPEG_PATH, or "ffmpeg" on PATH). Without it, the official
// channel's or the earliest copy is used, as before.
const W = 64;
const H = 36;
const FFMPEG = () => process.env.FFMPEG_PATH || 'ffmpeg';
let available = null;

export function ffmpegAvailable() {
  if (available === null) {
    try {
      execFileSync(FFMPEG(), ['-version'], { stdio: 'ignore', windowsHide: true, timeout: 10000 });
      available = true;
    } catch {
      available = false;
      console.warn('[publishing] ffmpeg not found — media copies are not compared (install ffmpeg or set FFMPEG_PATH)');
    }
  }
  return available;
}

function run(args, timeout = 60000) {
  return new Promise((resolve, reject) => {
    execFile(FFMPEG(), args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout }, (err, stdout) =>
      err ? reject(err) : resolve(stdout)
    );
  });
}

// One grayscale W×H frame at `seconds` (photos: the image itself).
async function frameAt(file, seconds) {
  const args = ['-v', 'error', ...(seconds > 0 ? ['-ss', String(seconds)] : []), '-i', file, '-frames:v', '1',
    '-vf', `scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-'];
  const buf = await run(args);
  return buf.length >= W * H ? buf.subarray(0, W * H) : null;
}

// Loudness per 100 ms over the first 30 s (mono, 8 kHz) — enough to tell two
// clips share the same sound track.
async function audioEnvelope(file) {
  try {
    const pcm = await run(['-v', 'error', '-i', file, '-t', '30', '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-']);
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
    const step = 800;
    const out = [];
    for (let i = 0; i + step <= samples.length; i += step) {
      let sum = 0;
      for (let j = i; j < i + step; j++) sum += Math.abs(samples[j]);
      out.push(sum / step);
    }
    return out.length >= 10 ? out : null;
  } catch {
    return null; // no audio track
  }
}

// 64-bit difference hash from a W×H frame: 9×8 block means, left<right bits.
export function dhash(frame) {
  const cols = 9;
  const rows = 8;
  const cell = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let sum = 0;
      let n = 0;
      for (let y = Math.floor((r * H) / rows); y < Math.floor(((r + 1) * H) / rows); y++) {
        for (let x = Math.floor((c * W) / cols); x < Math.floor(((c + 1) * W) / cols); x++) {
          sum += frame[y * W + x];
          n++;
        }
      }
      cell.push(sum / n);
    }
  }
  const bits = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols - 1; c++) bits.push(cell[r * cols + c] < cell[r * cols + c + 1] ? 1 : 0);
  return bits;
}

export const hamming = (a, b) => a.reduce((n, bit, i) => n + (bit !== b[i] ? 1 : 0), 0);

export function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 10) return 0;
  const mean = (v) => v.slice(0, n).reduce((s, x) => s + x, 0) / n;
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

// Fingerprint of a copy's first photo/video: { frames, hashes, audio, duration, pixels }.
export async function fingerprint(media) {
  const m = media[0];
  const points = m.kind === 'photo' ? [0] : [0.2, 0.5, 0.8].map((f) => Math.max(0.5, (m.duration || 0) * f));
  const frames = [];
  for (const t of points) {
    const f = await frameAt(m.file, m.kind === 'photo' ? 0 : t);
    if (!f) return null;
    frames.push(f);
  }
  return {
    kind: m.kind,
    count: media.length,
    frames,
    hashes: frames.map(dhash),
    audio: m.kind === 'video' ? await audioEnvelope(m.file) : null,
    duration: m.duration || 0,
    pixels: (m.w || 0) * (m.h || 0),
  };
}

export function sameMedia(a, b) {
  if (a.kind !== b.kind || a.frames.length !== b.frames.length) return false;
  if (a.kind !== 'photo' && Math.abs(a.duration - b.duration) > 1.5) return false;
  const dist = a.hashes.reduce((n, h, i) => n + hamming(h, b.hashes[i]), 0) / a.hashes.length;
  if (dist > 14) return false;
  if (a.audio && b.audio && correlation(a.audio, b.audio) < 0.7) return false;
  return true;
}

// Mean distance of each copy's frames from the pixel-wise median of all
// copies: the clean original sits closest to the median, a stamped copy is
// off wherever its logo is.
export function overlayScores(prints) {
  const scores = prints.map(() => 0);
  const frames = prints[0].frames.length;
  for (let f = 0; f < frames; f++) {
    for (let p = 0; p < W * H; p++) {
      const values = prints.map((pr) => pr.frames[f][p]).sort((a, b) => a - b);
      const median = values[Math.floor(values.length / 2)];
      prints.forEach((pr, i) => {
        scores[i] += Math.abs(pr.frames[f][p] - median);
      });
    }
  }
  return scores.map((s) => s / (frames * W * H));
}

// copies: [{ rawItemId, media, order }] in preference order (official first,
// then earliest). Returns { pick, note } — pick is one of the copies.
export async function chooseCleanest(copies, { fingerprintFn = fingerprint } = {}) {
  if (copies.length < 2) return { pick: copies[0], note: null };
  const prints = [];
  for (const c of copies) {
    try {
      prints.push({ copy: c, print: await fingerprintFn(c.media) });
    } catch {
      prints.push({ copy: c, print: null });
    }
  }
  const base = prints[0];
  if (!base.print) return { pick: copies[0], note: null };
  const group = prints.filter((p) => p.print && p.print.count === base.print.count && sameMedia(base.print, p.print));
  if (group.length < 2) return { pick: copies[0], note: null };
  // With two copies the median can't tell which one carries the logo; the
  // earlier/official one stays unless the other is clearly higher resolution.
  const scores = group.length >= 3 ? overlayScores(group.map((g) => g.print)) : group.map(() => 0);
  const ranked = group
    .map((g, i) => ({ ...g, score: scores[i] }))
    .sort((a, b) => (Math.abs(a.score - b.score) > 2 ? a.score - b.score : 0) || b.print.pixels - a.print.pixels || a.copy.order - b.copy.order);
  const pick = ranked[0].copy;
  return {
    pick,
    note: pick === copies[0] ? null : `cleanest of ${group.length} copies (item ${pick.rawItemId} instead of ${copies[0].rawItemId})`,
  };
}
