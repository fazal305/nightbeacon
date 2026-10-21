// Finds candidate source channels to grow the monitored set, and writes them
// to channels/source-candidates.md for review. Nothing is added here — after
// reviewing (delete the lines you don't want), run:  npm run sources:add
//
//   npm run sources:discover                 default: up to 800 candidates
//   npm run sources:discover -- --limit 600
//
// Three ways, all read-only (nothing is joined):
//   1. Telegram's "similar channels" for the most active sources
//      (channels.getChannelRecommendations) — returns ids + access hashes, so
//      these never need the flood-limited username lookup.
//   2. Chat-folder links (t.me/addlist/…) posted in sources' messages
//      (chatlists.checkChatlistInvite preview, ids + hashes as well).
//   3. Channels mentioned (@name / t.me/name) by several different sources.
//      These have no id yet; the poller resolves them slowly, one at a time.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Api } from 'telegram';
import { pool } from './pool.js';
import {
  getTelegramClient,
  requestGate,
  resolveSourcePeer,
  withTimeout,
  floodWaitSeconds,
  REQUEST_TIMEOUT_MS,
} from '../ingestion/telegramClient.js';

export const CANDIDATES_MD = 'channels/source-candidates.md';
export const CANDIDATES_JSON = 'channels/source-candidates.json';
const RECOMMEND_FROM = Number(process.env.DISCOVER_RECOMMEND_SOURCES || 200);
const MAX_FOLDERS = Number(process.env.DISCOVER_MAX_FOLDERS || 40);
const MIN_MENTION_SOURCES = 3;

// candidates: Map(lowercased username -> candidate)
export function addCandidate(candidates, { username, title, id, accessHash, subscribers }, via) {
  if (!username) return;
  const key = username.toLowerCase();
  const c = candidates.get(key) || {
    username,
    title: title || username,
    id: null,
    accessHash: null,
    subscribers: null,
    recommendedBy: new Set(),
    folders: new Set(),
    mentionedBy: new Set(),
  };
  if (title && c.title === c.username) c.title = title;
  if (id != null && accessHash != null) {
    c.id = String(id);
    c.accessHash = String(accessHash);
  }
  if (subscribers) c.subscribers = Math.max(c.subscribers || 0, subscribers);
  if (via.recommendedBy) c.recommendedBy.add(via.recommendedBy);
  if (via.folder) c.folders.add(via.folder);
  if (via.mentionedBy) c.mentionedBy.add(via.mentionedBy);
  candidates.set(key, c);
}

// Several independent signals beat one; size breaks ties.
export function scoreCandidate(c) {
  return (
    c.recommendedBy.size * 3 +
    c.folders.size * 5 +
    c.mentionedBy.size +
    (c.subscribers ? Math.log10(c.subscribers) : 0)
  );
}

function describe(c) {
  const why = [];
  if (c.recommendedBy.size) why.push(`similar to ${c.recommendedBy.size} source(s)`);
  if (c.folders.size) why.push(`in ${c.folders.size} folder(s)`);
  if (c.mentionedBy.size) why.push(`mentioned by ${c.mentionedBy.size} source(s)`);
  const subs = c.subscribers ? `${c.subscribers >= 1000 ? `${(c.subscribers / 1000).toFixed(1)}k` : c.subscribers} subscribers` : 'subscribers unknown';
  return `${subs} · ${why.join(', ')}`;
}

export function renderCandidates(list) {
  return [
    '# Candidate source channels (npm run sources:discover).',
    '# Review: delete the lines of channels you do NOT want, then run:  npm run sources:add',
    '# (add "-- --limit 300" to add only the first 300). Best candidates first.',
    '',
    ...list.map((c) => `@${c.username} | ${c.title.replace(/\s+/g, ' ').replace(/\|/g, '/').slice(0, 70)} | ${describe(c)}`),
    '',
  ].join('\n');
}

export function parseCandidateUsernames(text) {
  return String(text)
    .split(/\r?\n/)
    .map((l) => l.match(/^\s*@([A-Za-z0-9_]{4,})\b/)?.[1])
    .filter(Boolean);
}

// @name and t.me/name references in a post (not t.me/c/, +invites, addlist…).
const RESERVED = new Set(['addlist', 'joinchat', 'c', 's', 'proxy', 'socks', 'share', 'boost', 'iv', 'addstickers', 'addemoji', 'login']);
export function mentionedUsernames(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/(?:t(?:elegram)?\.me\/|@)([A-Za-z][A-Za-z0-9_]{3,31})\b/g)) {
    const name = m[1];
    if (!RESERVED.has(name.toLowerCase()) && !/bot$/i.test(name)) out.add(name);
  }
  return out;
}

function chatInfo(chat) {
  const username = chat.username || chat.usernames?.find((u) => u.active)?.username;
  if (!username || chat.className !== 'Channel') return null;
  return {
    username,
    title: chat.title,
    id: chat.id?.toString(),
    accessHash: chat.accessHash?.toString(),
    subscribers: chat.participantsCount || null,
    broadcast: Boolean(chat.broadcast),
  };
}

async function call(client, request, what) {
  await requestGate.wait();
  return withTimeout(client.invoke(request), REQUEST_TIMEOUT_MS, what);
}

async function main() {
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : 800;

  const { rows: sources } = await pool.query(
    `SELECT s.id, s.channel_username, s.telegram_channel_id, s.telegram_access_hash,
            count(ri.id) AS recent
     FROM sources s LEFT JOIN raw_items ri ON ri.source_id = s.id AND ri.telegram_date > now() - interval '7 days'
     GROUP BY s.id ORDER BY recent DESC`
  );
  const known = new Set(sources.map((s) => s.channel_username.toLowerCase()));
  const knownIds = new Set(sources.map((s) => String(s.telegram_channel_id)).filter((x) => x !== 'null'));
  const candidates = new Map();
  const consider = (info, via) => {
    if (!info || !info.broadcast || known.has(info.username.toLowerCase()) || knownIds.has(info.id)) return;
    addCandidate(candidates, info, via);
  };

  const client = await getTelegramClient();

  // 1. Similar channels.
  const active = sources.filter((s) => s.telegram_access_hash != null).slice(0, RECOMMEND_FROM);
  console.log(`1/3 Similar channels for the ${active.length} most active sources…`);
  let done = 0;
  for (const s of active) {
    try {
      const peer = await resolveSourcePeer(client, s);
      const channel = new Api.InputChannel({ channelId: peer.channelId, accessHash: peer.accessHash });
      const res = await call(client, new Api.channels.GetChannelRecommendations({ channel }), 'recommendations');
      for (const chat of res.chats || []) consider(chatInfo(chat), { recommendedBy: s.channel_username });
    } catch (err) {
      const flood = floodWaitSeconds(err);
      if (flood) {
        console.log(`   Telegram asked to wait ${flood}s for this lookup — stopping it here (${done} done).`);
        break;
      }
    }
    if (++done % 25 === 0) console.log(`   ${done}/${active.length} · ${candidates.size} candidates so far`);
  }

  // 2. Folder links posted in sources' messages.
  const { rows: folderRows } = await pool.query(
    `SELECT DISTINCT substring(raw_text FROM 't\\.me/addlist/([A-Za-z0-9_-]+)') AS slug
     FROM raw_items WHERE raw_text LIKE '%t.me/addlist/%' AND telegram_date > now() - interval '60 days'`
  );
  const slugs = folderRows.map((r) => r.slug).filter(Boolean).slice(0, MAX_FOLDERS);
  console.log(`2/3 ${slugs.length} folder link(s) found in posts…`);
  for (const slug of slugs) {
    try {
      const res = await call(client, new Api.chatlists.CheckChatlistInvite({ slug }), 'folder preview');
      for (const chat of res.chats || []) consider(chatInfo(chat), { folder: slug });
    } catch (err) {
      if (floodWaitSeconds(err)) break;
    }
  }

  // 3. Channels several sources mention.
  console.log('3/3 Channels mentioned by several sources…');
  const { rows: posts } = await pool.query(
    `SELECT ri.source_id, ri.raw_text FROM raw_items ri
     WHERE ri.telegram_date > now() - interval '14 days' AND (ri.raw_text LIKE '%@%' OR ri.raw_text LIKE '%t.me/%')`
  );
  const mentions = new Map(); // name -> Set(source ids)
  for (const p of posts) {
    for (const name of mentionedUsernames(p.raw_text)) {
      const key = name.toLowerCase();
      if (known.has(key)) continue;
      if (!mentions.has(key)) mentions.set(key, { name, by: new Set() });
      mentions.get(key).by.add(p.source_id);
    }
  }
  for (const { name, by } of mentions.values()) {
    if (by.size < MIN_MENTION_SOURCES && !candidates.has(name.toLowerCase())) continue;
    for (const sourceId of by) addCandidate(candidates, { username: name }, { mentionedBy: sourceId });
  }

  const list = [...candidates.values()].sort((a, b) => scoreCandidate(b) - scoreCandidate(a)).slice(0, limit);
  fs.writeFileSync(CANDIDATES_MD, renderCandidates(list));
  fs.writeFileSync(
    CANDIDATES_JSON,
    JSON.stringify(
      Object.fromEntries(list.map((c) => [c.username.toLowerCase(), { username: c.username, title: c.title, id: c.id, accessHash: c.accessHash }]))
    )
  );
  const withIds = list.filter((c) => c.id).length;
  console.log(`\n${list.length} candidate channel(s) written to ${path.resolve(CANDIDATES_MD)}`);
  console.log(`${withIds} of them come with their channel id (no username lookup needed).`);
  console.log(`You monitor ${sources.length} sources now. Review the file, delete what you don't want, then: npm run sources:add`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
    })
    .finally(async () => {
      await pool.end().catch(() => {});
      setTimeout(() => process.exit(), 300);
    });
}
