import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Api } from 'telegram';
import { pool } from '../db/pool.js';
import {
  getTelegramClient,
  resolveSourcePeer,
  requestGate,
  withTimeout,
  REQUEST_TIMEOUT_MS,
} from '../ingestion/telegramClient.js';

// The source post's photos/videos, for posting them with the text. A bot
// can't read other channels, and media references are tied to the account
// that fetched them, so the monitoring session downloads the files (the
// whole album when the post is part of one) and the bot uploads them again.
// Files are cached on disk for a day, shared by the bot and the dashboard's
// download links, so each is downloaded once.
const MAX_BYTES = Number(process.env.PUBLISH_MEDIA_MAX_MB || 50) * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = Number(process.env.PUBLISH_MEDIA_TIMEOUT_SECONDS || 180) * 1000;
const CACHE_TTL_MS = 24 * 3600 * 1000;
const ALBUM_MAX = 10;
export const CAPTION_LIMIT = 1024;

export const mediaCacheDir = () => process.env.PUBLISH_MEDIA_CACHE_DIR || path.join(os.tmpdir(), 'nightbeacon-media');

const attr = (doc, cls) => (doc.attributes || []).find((a) => a instanceof cls);

// What can be reposted: photos, videos and GIFs (sent as silent videos).
// Anything else (voice, files, stickers) is left out.
export function describeMedia(message) {
  const media = message?.media;
  if (media instanceof Api.MessageMediaPhoto && media.photo) {
    const sizes = media.photo.sizes || [];
    const largest = sizes.reduce((n, s) => Math.max(n, Number(s.size || 0), ...(s.sizes || []).map(Number)), 0);
    return { kind: 'photo', mime: 'image/jpeg', ext: 'jpg', size: largest };
  }
  if (media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document) {
    const doc = media.document;
    const mime = doc.mimeType || '';
    const video = attr(doc, Api.DocumentAttributeVideo);
    const animated = Boolean(attr(doc, Api.DocumentAttributeAnimated));
    if (!(mime.startsWith('video/') || animated) || attr(doc, Api.DocumentAttributeSticker)) return null;
    if (video?.roundMessage) return null;
    return {
      kind: animated ? 'gif' : 'video',
      mime: mime || 'video/mp4',
      ext: mime === 'video/quicktime' ? 'mov' : 'mp4',
      size: Number(doc.size || 0),
      duration: video ? Number(video.duration || 0) : 0,
      w: video?.w || 0,
      h: video?.h || 0,
    };
  }
  return null;
}

function cachePathFor(rawItemId) {
  return path.join(mediaCacheDir(), String(rawItemId));
}

function readCache(rawItemId) {
  const dir = cachePathFor(rawItemId);
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    return manifest.map((m) => ({ ...m, file: path.join(dir, m.name) })).filter((m) => fs.existsSync(m.file));
  } catch {
    return null;
  }
}

function pruneCache() {
  const root = mediaCacheDir();
  let entries = [];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    const dir = path.join(root, name);
    try {
      if (Date.now() - fs.statSync(dir).mtimeMs > CACHE_TTL_MS) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // another process may be cleaning up too
    }
  }
}

// The messages making up the post: itself, or its whole album.
async function postMessages(client, peer, messageId) {
  await requestGate.wait();
  const [message] = await withTimeout(client.getMessages(peer, { ids: [messageId] }), REQUEST_TIMEOUT_MS, 'get post');
  if (!message) return [];
  if (!message.groupedId) return [message];
  const ids = [];
  for (let id = messageId - ALBUM_MAX + 1; id <= messageId + ALBUM_MAX - 1; id++) if (id > 0) ids.push(id);
  await requestGate.wait();
  const around = await withTimeout(client.getMessages(peer, { ids }), REQUEST_TIMEOUT_MS, 'get album');
  return around
    .filter((m) => m && m.groupedId && m.groupedId.toString() === message.groupedId.toString())
    .sort((a, b) => a.id - b.id)
    .slice(0, ALBUM_MAX);
}

// Returns [{ kind, mime, name, size, duration, w, h, file }] — the post's
// photos/videos on disk (empty when it has none we can repost). `deps` is
// injectable for tests.
export async function loadItemMedia(rawItemId, deps = {}) {
  const cached = readCache(rawItemId);
  if (cached) return cached;
  pruneCache();

  const { rows } = await pool.query(
    `SELECT ri.telegram_message_id, ri.has_media, s.id AS source_id, s.channel_username, s.telegram_channel_id, s.telegram_access_hash
     FROM raw_items ri JOIN sources s ON s.id = ri.source_id WHERE ri.id = $1`,
    [rawItemId]
  );
  const row = rows[0];
  if (!row || !row.has_media) return [];

  const client = deps.client || (await getTelegramClient());
  const peer = await resolveSourcePeer(client, {
    id: row.source_id,
    channel_username: row.channel_username,
    telegram_channel_id: row.telegram_channel_id,
    telegram_access_hash: row.telegram_access_hash,
  });
  const messages = await postMessages(client, peer, Number(row.telegram_message_id));

  const dir = cachePathFor(rawItemId);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = [];
  const skipped = [];
  for (const message of messages) {
    const info = describeMedia(message);
    if (!info) continue;
    if (info.size > MAX_BYTES) {
      skipped.push(`${info.kind} of ${Math.round(info.size / 1048576)} MB (limit ${MAX_BYTES / 1048576} MB)`);
      continue;
    }
    const buffer = await withTimeout(client.downloadMedia(message, {}), DOWNLOAD_TIMEOUT_MS, 'download media');
    if (!buffer || !buffer.length) continue;
    const name = `${manifest.length + 1}.${info.ext}`;
    fs.writeFileSync(path.join(dir, name), buffer);
    const { ext, ...meta } = info;
    manifest.push({ ...meta, name, size: buffer.length });
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  if (skipped.length) console.warn(`[publishing] media of item ${rawItemId} left out: ${skipped.join(', ')}`);
  return manifest.map((m) => ({ ...m, file: path.join(dir, m.name) }));
}

// GramJS attributes for re-uploading a video/GIF so Telegram shows it as a
// playable video (not a file) with the right size and length.
export function uploadAttributes(m) {
  if (m.kind === 'photo') return [];
  const attrs = [
    new Api.DocumentAttributeVideo({ duration: m.duration || 0, w: m.w || 0, h: m.h || 0, supportsStreaming: true }),
    new Api.DocumentAttributeFilename({ fileName: m.name }),
  ];
  if (m.kind === 'gif') attrs.push(new Api.DocumentAttributeAnimated());
  return attrs;
}

// Which copy of the media to use. The same story often arrives from several
// channels, and reposting channels tend to stamp their own logo on it; the
// cleanest copy is usually the original. So: the organisation's official
// channel first (official-sources.md), then whichever channel posted it
// earliest. Returns { media, rawItemId, candidates, error } — the first
// candidate (of up to 3) whose media could be fetched; `error` says why none
// could, when there were candidates.
export async function loadBestMedia(rawItemId, { officialUsernames = [], loadMedia = loadItemMedia } = {}) {
  const { rows } = await pool.query(
    `SELECT ri.id FROM raw_items ri JOIN sources s ON s.id = ri.source_id
     WHERE ri.has_media
       AND (ri.id = $1 OR (ri.story_id IS NOT NULL AND ri.story_id = (SELECT story_id FROM raw_items WHERE id = $1)))
     ORDER BY lower(s.channel_username) = ANY($2::text[]) DESC, ri.telegram_date, ri.id
     LIMIT 3`,
    [rawItemId, officialUsernames]
  );
  const errors = [];
  for (const { id } of rows) {
    try {
      const media = await loadMedia(Number(id));
      if (media.length > 0) return { media, rawItemId: Number(id), candidates: rows.length, error: null };
    } catch (err) {
      errors.push(err.message);
    }
  }
  return {
    media: [],
    rawItemId,
    candidates: rows.length,
    error: errors.length ? errors.join(' | ') : rows.length ? 'no photo/video that can be reposted (too large or unsupported type)' : null,
  };
}
