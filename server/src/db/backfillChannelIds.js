// Fills in telegram_channel_id + telegram_access_hash for existing sources
// from the chat-folder previews (chatlists.CheckChatlistInvite: one call per
// folder, read-only, never joins anything). With those stored, polling never
// needs contacts.ResolveUsername — the strictly rate-limited call that
// flood-waits the account when hundreds of channels are resolved one by one.
//
// Only UPDATEs sources that are missing a hash; never inserts, so channels
// removed on purpose (e.g. the 18 relay channels) are not re-added.
// Safe to run while the server is running; it picks the ids up on the next poll.
//
// Run: npm run sources:backfill-ids
import 'dotenv/config';
import { Api } from 'telegram';
import { pool } from './pool.js';
import { getTelegramClient } from '../ingestion/telegramClient.js';
import { FOLDER_SLUGS } from './chatFolders.js';

async function main() {
  const { rows: missing } = await pool.query(
    'SELECT id, channel_username FROM sources WHERE enabled AND telegram_access_hash IS NULL'
  );
  console.log(`${missing.length} enabled source(s) have no stored channel id yet.`);
  if (missing.length === 0) return;

  const client = await getTelegramClient();
  const known = new Map(); // lowercased username -> { id, hash }
  for (const slug of FOLDER_SLUGS) {
    try {
      const result = await client.invoke(new Api.chatlists.CheckChatlistInvite({ slug }));
      for (const chat of result.chats || []) {
        if (chat.className === 'Channel' && chat.username && chat.accessHash != null) {
          known.set(chat.username.toLowerCase(), { id: chat.id.toString(), hash: chat.accessHash.toString() });
        }
      }
    } catch (err) {
      console.warn(`  folder ${slug}: ${err.message}`);
    }
  }

  let updated = 0;
  const unresolved = [];
  for (const s of missing) {
    const hit = known.get(s.channel_username.toLowerCase());
    if (!hit) {
      unresolved.push(s.channel_username);
      continue;
    }
    const r = await pool.query(
      `UPDATE sources SET telegram_channel_id = $2, telegram_access_hash = $3, updated_at = now()
       WHERE id = $1 AND telegram_access_hash IS NULL`,
      [s.id, hit.id, hit.hash]
    );
    updated += r.rowCount;
  }

  console.log(`Stored channel ids for ${updated} source(s).`);
  if (unresolved.length > 0) {
    console.log(
      `${unresolved.length} source(s) aren't in any folder preview and will be resolved by username, slowly, ` +
        `by the poller: ${unresolved.slice(0, 15).join(', ')}${unresolved.length > 15 ? ', …' : ''}`
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
