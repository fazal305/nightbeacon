import { getTelegramClient, withTimeout, REQUEST_TIMEOUT_MS } from '../ingestion/telegramClient.js';
import { Api } from 'telegram';
import { returnBigInt } from 'telegram/Helpers.js';
import { pool } from '../db/pool.js';
import { getState, setState } from '../db/appState.js';

// Each channel's house style is learned from its own recent posts, read with
// the monitoring account's session (bots can't read channel history). They're
// cached in app_state for a day per channel, so restarts don't refetch.
const REFRESH_MS = 24 * 3600 * 1000;
const memo = new Map(); // telegram username -> { examples, fetchedAt }

export async function getStyleContext(channel, { fetchExamples = fetchChannelExamples } = {}) {
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
  return { guide, examples: entry.examples.slice(0, channel.styleExamples) };
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
