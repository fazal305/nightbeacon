import { getTelegramClient, withTimeout, REQUEST_TIMEOUT_MS } from '../ingestion/telegramClient.js';
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

async function fetchChannelExamples(channel, count) {
  const client = await getTelegramClient();
  let peer;
  try {
    peer = await withTimeout(client.getInputEntity(channel), REQUEST_TIMEOUT_MS, 'resolve publish channel');
  } catch (err) {
    // Username resolution may be flood-waited; the channel is normally in the
    // account's own dialog list, which needs no resolution at all.
    const wanted = channel.replace(/^@/, '').toLowerCase();
    const dialogs = await withTimeout(client.getDialogs({ limit: 500 }), REQUEST_TIMEOUT_MS, 'list dialogs');
    const hit = dialogs.find(
      (d) => d.entity?.username?.toLowerCase() === wanted || String(d.id) === channel
    );
    if (!hit) throw err;
    peer = hit.inputEntity;
  }
  const messages = await withTimeout(client.getMessages(peer, { limit: 80 }), REQUEST_TIMEOUT_MS, 'read channel');
  return messages
    .map((m) => m.message)
    .filter((t) => t && t.trim().length >= 40)
    .slice(0, count);
}
