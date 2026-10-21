// MinHash near-duplicate detection, in memory. Each story's normalized text
// is cut into overlapping 5-character pieces ("shingles"); a 64-number
// signature estimates how many pieces two texts share (Jaccard similarity),
// and locality-sensitive hashing (16 bands of 4) finds the likely matches
// among tens of thousands of recent stories without comparing against each
// one or asking Postgres. Cheaper than the trigram query, so it runs first
// and the trigram query is only needed when it finds nothing.
//
// Besides plain similarity it estimates containment — how much of the
// shorter text appears in the longer — so a relay that only adds its own
// header or footer to a post still matches.

const PERMUTATIONS = 64;
const BANDS = 16;
const ROWS = PERMUTATIONS / BANDS;
const SHINGLE = 5;

// Fixed seeds: signatures stay comparable across restarts.
const SEEDS = Array.from({ length: PERMUTATIONS }, (_, i) => (Math.imul(i + 1, 0x9e3779b1) ^ 0x85ebca6b) >>> 0);

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Murmur3 finalizer: a cheap, well-mixed 32-bit hash per seed.
function mix(x, seed) {
  let h = (x ^ seed) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export function shingles(normalized) {
  const s = String(normalized || '');
  const out = new Set();
  if (s.length <= SHINGLE) {
    if (s) out.add(fnv1a(s));
    return out;
  }
  for (let i = 0; i + SHINGLE <= s.length; i++) out.add(fnv1a(s.slice(i, i + SHINGLE)));
  return out;
}

// { sig: Uint32Array(64), size: number of distinct shingles }
export function signature(normalized) {
  const set = shingles(normalized);
  const sig = new Uint32Array(PERMUTATIONS).fill(0xffffffff);
  for (const x of set) {
    for (let i = 0; i < PERMUTATIONS; i++) {
      const h = mix(x, SEEDS[i]);
      if (h < sig[i]) sig[i] = h;
    }
  }
  return { sig, size: set.size };
}

export function jaccard(a, b) {
  let same = 0;
  for (let i = 0; i < PERMUTATIONS; i++) if (a.sig[i] === b.sig[i]) same++;
  return same / PERMUTATIONS;
}

// Share of the smaller text's shingles found in the larger one, derived from
// the Jaccard estimate and the two set sizes.
export function containment(a, b, j = jaccard(a, b)) {
  const small = Math.min(a.size, b.size);
  if (!small) return 0;
  return Math.min(1, (j * (a.size + b.size)) / ((1 + j) * small));
}

const bandKey = (sig, band) => {
  let k = `${band}:`;
  for (let r = 0; r < ROWS; r++) k += `${sig[band * ROWS + r].toString(36)},`;
  return k;
};

export class MinHashIndex {
  constructor() {
    this.entries = new Map(); // id -> { id, mh, meta }
    this.buckets = new Map(); // bandKey -> Set(id)
  }

  get size() {
    return this.entries.size;
  }

  has(id) {
    return this.entries.has(id);
  }

  add(id, mh, meta) {
    this.remove(id);
    this.entries.set(id, { id, mh, meta });
    for (let b = 0; b < BANDS; b++) {
      const k = bandKey(mh.sig, b);
      if (!this.buckets.has(k)) this.buckets.set(k, new Set());
      this.buckets.get(k).add(id);
    }
  }

  update(id, meta) {
    const e = this.entries.get(id);
    if (e) e.meta = { ...e.meta, ...meta };
  }

  remove(id) {
    const e = this.entries.get(id);
    if (!e) return;
    for (let b = 0; b < BANDS; b++) {
      const k = bandKey(e.mh.sig, b);
      const set = this.buckets.get(k);
      if (set) {
        set.delete(id);
        if (set.size === 0) this.buckets.delete(k);
      }
    }
    this.entries.delete(id);
  }

  // Best match among stories sharing at least one band: { id, meta, jaccard, containment }.
  best(mh, accept = () => true) {
    const seen = new Set();
    let best = null;
    for (let b = 0; b < BANDS; b++) {
      for (const id of this.buckets.get(bandKey(mh.sig, b)) || []) {
        if (seen.has(id)) continue;
        seen.add(id);
        const e = this.entries.get(id);
        if (!accept(e.meta)) continue;
        const j = jaccard(mh, e.mh);
        const c = containment(mh, e.mh, j);
        const score = Math.max(j, c);
        if (!best || score > best.score) best = { id, meta: e.meta, jaccard: j, containment: c, score };
      }
    }
    return best;
  }
}
