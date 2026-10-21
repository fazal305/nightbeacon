import { getTelegramClient, withTimeout, REQUEST_TIMEOUT_MS } from '../ingestion/telegramClient.js';
import { Api } from 'telegram';
import { returnBigInt } from 'telegram/Helpers.js';
import { pool } from '../db/pool.js';
import crypto from 'node:crypto';
import { getState, setState } from '../db/appState.js';
import { callLLM } from '../processing/llmClient.js';

// Each channel's house style is learned from its own recent posts, read with
// the monitoring account's session (bots can't read channel history). They're
// cached in app_state for a day per channel, so restarts don't refetch.
const REFRESH_MS = 24 * 3600 * 1000;
const memo = new Map(); // telegram username -> { examples, fetchedAt }

// A channel's style is condensed ONCE into a short "style card" (a fixed
// template: length, structure, emoji, capitals, hashtags, sign-off) and
// cached until its example posts or written rules change. Every draft then
// carries the card instead of ~1,500 characters of example posts, so requests
// are a fraction of the size (no more "request too large" on 8k-token-a-minute
// models) and a small local model only has to fill a short template.
// DRAFT_STYLE_CARDS=off goes back to sending the example posts.
const CARD_RETRY_MS = 3600 * 1000;
const cards = new Map(); // handle -> { hash, card, failedAt }

export function styleCardMessages(channel, examples, guide) {
  return [
    {
      role: 'system',
      content: [
        'You describe the house style of a Telegram news channel so another writer can copy it exactly.',
        'From the example posts (and the editor\'s rules, if any), write a compact style card of at most 12 short lines:',
        '- typical length (characters) and number of paragraphs/lines;',
        '- a TEMPLATE of the post layout with placeholders, e.g. "🔴 [HEADLINE IN CAPS]" / "[1–2 sentence body]" / "[sign-off line]";',
        '- emoji: which ones, where, how many;',
        '- capitalisation, punctuation and hashtag habits;',
        '- any fixed header, footer or sign-off line, copied EXACTLY.',
        'Describe the form only: no news facts, names or events from the examples. Reply with the card only.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `Channel: ${channel.name}${channel.telegram ? ` (${channel.telegram})` : ''}`,
        guide ? `Editor's rules:\n${guide}` : null,
        'Example posts:',
        ...examples.map((e, i) => `--- ${i + 1} ---\n${e.slice(0, 900)}`),
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ];
}

async function defaultMakeCard(channel, examples, guide) {
  const { publishConfig } = await import('./config.js');
  const config = publishConfig();
  const { content } = await callLLM(styleCardMessages(channel, examples, guide), {
    providerName: config.draftProvider,
    temperature: 0.2,
  });
  return content.trim().slice(0, 1200);
}

export async function getStyleCard(channel, examples, guide, { makeCard = defaultMakeCard } = {}) {
  if (String(process.env.DRAFT_STYLE_CARDS || 'on').toLowerCase() === 'off' || examples.length === 0) return null;
  const handle = (channel.telegram || channel.key).toLowerCase();
  const hash = crypto.createHash('sha1').update(JSON.stringify([examples, guide])).digest('hex');
  const stateKey = `style_card:${handle}`;
  let entry = cards.get(handle);
  if (!entry) {
    const saved = await getState(stateKey).catch(() => null);
    try {
      entry = saved ? JSON.parse(saved.value) : null;
    } catch {
      entry = null;
    }
  }
  if (entry?.hash === hash && entry.card) {
    cards.set(handle, entry);
    return entry.card;
  }
  if (entry?.hash === hash && Date.now() - (entry.failedAt || 0) < CARD_RETRY_MS) return null;
  try {
    const card = await makeCard(channel, examples, guide);
    entry = { hash, card, builtAt: Date.now() };
    await setState(stateKey, JSON.stringify(entry));
    console.log(`[drafting] built the style card of ${channel.telegram || channel.key} (${card.length} characters)`);
  } catch (err) {
    console.warn(`[drafting] could not build a style card for ${channel.telegram || channel.key}: ${err.message} — using example posts`);
    entry = { hash, card: null, failedAt: Date.now() };
  }
  cards.set(handle, entry);
  return entry.card;
}

export async function getStyleContext(channel, { fetchExamples = fetchChannelExamples, makeCard } = {}) {
  const guide = channel.styleGuide || '';
  if (!channel.telegram || channel.styleExamples <= 0) return { guide, examples: [] };

  const handle = channel.telegram.toLowerCase();
  const stateKey = `style_examples:${handle}`;
  let entry = memo.get(handle);
  if (!entry) {
    const saved = await getState(stateKey);
    if (saved) {
      try {
        entry = JSON.parse(saved.value);
        memo.set(handle, entry);
      } catch {
        entry = null;
      }
    }
  }
  if (!entry || Date.now() - entry.fetchedAt >= REFRESH_MS) {
    try {
      const examples = await fetchExamples(channel.telegram, Math.max(channel.styleExamples, 8));
      entry = { examples, fetchedAt: Date.now() };
      memo.set(handle, entry);
      await setState(stateKey, JSON.stringify(entry));
      console.log(`[drafting] learned house style of ${channel.telegram} from ${examples.length} recent post(s)`);
    } catch (err) {
      // Keep drafting with whatever we had (or the written guide alone); retry in an hour.
      console.warn(`[drafting] could not read ${channel.telegram} for style examples: ${err.message}`);
      entry = { examples: entry?.examples || [], fetchedAt: Date.now() - REFRESH_MS + 3600 * 1000 };
      memo.set(handle, entry);
    }
  }
  const examples = entry.examples.slice(0, channel.styleExamples);
  const card = await getStyleCard(channel, examples, guide, makeCard ? { makeCard } : {});
  return { guide, examples, card };
}

// Finds the channel without contacts.ResolveUsername when possible — that
// call is the one Telegram flood-waits for hours: first a monitored source
// with a stored access hash, then the account's chats (archived ones too).
async function findChannelPeer(client, channel) {
  const wanted = channel.replace(/^@/, '').toLowerCase();
  const { rows } = await pool.query(
    `SELECT telegram_channel_id, telegram_access_hash FROM sources
     WHERE lower(channel_username) = $1 AND telegram_channel_id IS NOT NULL AND telegram_access_hash IS NOT NULL
     LIMIT 1`,
    [wanted]
  );
  if (rows[0]) {
    return new Api.InputPeerChannel({
      channelId: returnBigInt(String(rows[0].telegram_channel_id)),
      accessHash: returnBigInt(String(rows[0].telegram_access_hash)),
    });
  }
  for (const archived of [false, true]) {
    const dialogs = await withTimeout(client.getDialogs({ limit: 1000, archived }), REQUEST_TIMEOUT_MS, 'list dialogs');
    const hit = dialogs.find((d) => d.entity?.username?.toLowerCase() === wanted);
    if (hit) return hit.inputEntity;
  }
  return withTimeout(client.getInputEntity(channel), REQUEST_TIMEOUT_MS, 'resolve publish channel');
}

async function fetchChannelExamples(channel, count) {
  const client = await getTelegramClient();
  const peer = await findChannelPeer(client, channel);
  const messages = await withTimeout(client.getMessages(peer, { limit: 80 }), REQUEST_TIMEOUT_MS, 'read channel');
  return messages
    .map((m) => m.message)
    .filter((t) => t && t.trim().length >= 40)
    .slice(0, count);
}
