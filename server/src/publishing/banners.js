import fs from 'node:fs';
import path from 'node:path';
import { ffmpegAvailable, photoHash, hamming } from './mediaCompare.js';
import { getState, setState } from '../db/appState.js';

// The channel's own banner images (e.g. server/channels/banners/<channel>/,
// images you make, e.g. with your own banner tools) used in place of other channels'
// generic "breaking news / live" cards:
//
//   - a source photo that is only such a card is swapped for the matching
//     banner. A card is recognised (perceptual hash, needs ffmpeg) when it
//     looks like an image in server/channels/banners/known/ (drop examples of
//     other channels' cards there), or when the same picture has already come
//     with 3+ different stories (a template, not news imagery);
//   - with "textPosts": a headline-style post ("BREAKING", "URGENT", "LIVE"…)
//     without any photo/video gets a banner;
//   - with "digest" (default on): the scheduled summary gets summary.jpg.
//
// The banner is picked from the post's wording: statement / live /
// developing / urgent / update / alert / breaking.
const KNOWN_DIR = () => process.env.BANNERS_KNOWN_DIR || path.resolve('channels/banners/known');
const SAME_PICTURE = 8; // hash bits that may differ (of 64)
const TEMPLATE_STORIES = 3;
const LEARN_KEY = 'banner_learned_hashes';

const RULES = [
  ['statement', /\b(statement|communiqu[eé]|announcement)\b/i],
  ['live', /\blive\b/i],
  ['developing', /\bdeveloping\b/i],
  ['alert', /\b(alert|sirens?|red alert|warning)\b/i],
  ['urgent', /\b(urgent|just in|flash)\b|⚡/i],
  ['update', /\bupdated?\b/i],
  ['breaking', /\bbreaking\b|🔴|🚨/i],
];

export function pickBanner(text, { official = false, digest = false } = {}) {
  if (digest) return 'summary.jpg';
  if (official) return 'statement.jpg';
  const head = String(text || '').split('\n').slice(0, 2).join(' ');
  for (const [name, re] of RULES) if (re.test(head)) return `${name}.jpg`;
  return 'breaking.jpg';
}

// A headline-style post: its first line flags breaking/urgent/live news.
export function isHeadlinePost(text) {
  const first = String(text || '').split('\n')[0];
  return /\b(breaking|urgent|just in|live|developing|alert|flash)\b|🔴|🚨|⚡/i.test(first);
}

export function bannerFile(channel, name) {
  if (!channel.banners?.dir) return null;
  for (const n of [name, 'breaking.jpg']) {
    const file = path.join(channel.banners.dir, n);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

const asMedia = (file) => [{ kind: 'photo', mime: 'image/jpeg', name: path.basename(file), size: fs.statSync(file).size, file }];

// Hashes of the example cards in banners/known/, re-read when the folder changes.
let known = { stamp: null, hashes: [] };
async function knownHashes() {
  let files = [];
  try {
    files = fs.readdirSync(KNOWN_DIR()).filter((f) => /\.(jpe?g|png|webp)$/i.test(f));
  } catch {
    return [];
  }
  const stamp = files.map((f) => `${f}:${fs.statSync(path.join(KNOWN_DIR(), f)).mtimeMs}`).join('|');
  if (stamp !== known.stamp) {
    const hashes = [];
    for (const f of files) {
      const h = await photoHash(path.join(KNOWN_DIR(), f)).catch(() => null);
      if (h) hashes.push(h);
    }
    known = { stamp, hashes };
  }
  return known.hashes;
}

const toHex = (bits) => BigInt(`0b${bits.join('')}`).toString(16).padStart(16, '0');
const fromHex = (hex) => BigInt(`0x${hex}`).toString(2).padStart(64, '0').split('').map(Number);

// Remembers which stories each picture came with; true once the same
// picture has come with TEMPLATE_STORIES different stories.
async function seenAsTemplate(hash, storyId, { load = getState, save = setState } = {}) {
  let learned = {};
  try {
    learned = JSON.parse((await load(LEARN_KEY))?.value || '{}');
  } catch {
    learned = {};
  }
  let key = Object.keys(learned).find((k) => hamming(fromHex(k), hash) <= SAME_PICTURE);
  if (!key) key = toHex(hash);
  const stories = new Set(learned[key] || []);
  if (storyId != null) stories.add(String(storyId));
  learned[key] = [...stories].slice(-20);
  const keys = Object.keys(learned);
  if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete learned[k];
  await save(LEARN_KEY, JSON.stringify(learned)).catch(() => {});
  return stories.size >= TEMPLATE_STORIES;
}

export async function isGenericCard(file, storyId, deps = {}) {
  if (!ffmpegAvailable()) return false;
  const hash = await (deps.hashFn || photoHash)(file).catch(() => null);
  if (!hash) return false;
  if ((await (deps.knownFn || knownHashes)()).some((k) => hamming(k, hash) <= SAME_PICTURE)) return true;
  return seenAsTemplate(hash, storyId, deps);
}

// Decides the media actually posted. Returns { media, note }.
export async function applyBanners({ channel, media, text, official = false, digest = false, storyId = null }, deps = {}) {
  const b = channel.banners;
  if (!b) return { media, note: null };
  if (digest) {
    const file = b.digest ? bannerFile(channel, 'summary.jpg') : null;
    return { media: file ? asMedia(file) : media, note: null };
  }
  if (media.length === 0) {
    if (!b.textPosts || !isHeadlinePost(text)) return { media, note: null };
    const file = bannerFile(channel, pickBanner(text, { official }));
    return { media: file ? asMedia(file) : media, note: null };
  }
  if (b.replace && media.length === 1 && media[0].kind === 'photo' && (await isGenericCard(media[0].file, storyId, deps))) {
    const name = pickBanner(text, { official });
    const file = bannerFile(channel, name);
    if (file) return { media: asMedia(file), note: `source photo was a generic news card — posted with the ${name.replace('.jpg', '')} banner` };
  }
  return { media, note: null };
}
