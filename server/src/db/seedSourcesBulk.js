// One-time bulk seed for the channels resolved from operator-provided
// Telegram chat-folder invite links (t.me/addlist/...). Resolution itself
// happens via chatlists.CheckChatlistInvite — a read-only preview call that
// does NOT join the folder or any channel in it, consistent with the
// monitoring account staying passive/read-only (see docs/SECURITY.md).
//
// Run manually: npm run seed:sources-bulk
import 'dotenv/config';
import { pool } from './pool.js';
import { getTelegramClient } from '../ingestion/telegramClient.js';
import { Api } from 'telegram';

const FOLDER_SLUGS = [
  'C8Z7jlLBmaAxMjI0',
  'GMqnOAC2iGdmYzI5',
  'EFqQ6tg9E1U4N2M0',
  'FpmHjPqRVaA1ZDg1',
  'Zc3tjDDszXM3YTVk',
  'nClKBSp2_IFhMzNk',
  'vLHZ7uIX4_UwMWJk',
  'PxPvtkVpX305YjE0',
];

const RELIABILITY_NOTE =
  'Added in bulk from an operator-provided Telegram chat-folder list (t.me/addlist). Not individually vetted — reliability/bias unverified per-source.';

async function seed() {
  const client = await getTelegramClient();
  // The preview already carries each channel's id + access hash, so they're
  // stored now and these sources never need contacts.ResolveUsername (the
  // strictly rate-limited call behind the ~18h flood-wait in docs/POLLING.md).
  const channels = new Map(); // username -> { title, channelId, accessHash }

  for (const slug of FOLDER_SLUGS) {
    const result = await client.invoke(new Api.chatlists.CheckChatlistInvite({ slug }));
    for (const chat of result.chats || []) {
      if (chat.username && !channels.has(chat.username)) {
        const isChannel = chat.className === 'Channel' && chat.accessHash != null;
        channels.set(chat.username, {
          title: chat.title || chat.username,
          channelId: isChannel ? chat.id.toString() : null,
          accessHash: isChannel ? chat.accessHash.toString() : null,
        });
      }
    }
  }

  console.log(`Resolved ${channels.size} unique channels with a public username across ${FOLDER_SLUGS.length} folders.`);

  let inserted = 0;
  let skipped = 0;

  for (const [username, { title, channelId, accessHash }] of channels) {
    const result = await pool.query(
      `INSERT INTO sources (channel_username, display_name, reliability_note, telegram_channel_id, telegram_access_hash)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (channel_username) DO NOTHING
       RETURNING id`,
      [username, title, RELIABILITY_NOTE, channelId, accessHash]
    );
    if (result.rows.length > 0) {
      inserted++;
    } else {
      skipped++;
      // Backfill ids/hashes onto sources seeded before they were stored.
      await pool.query(
        `UPDATE sources SET telegram_channel_id = $2, telegram_access_hash = $3, updated_at = now()
         WHERE channel_username = $1 AND telegram_access_hash IS NULL AND $3::bigint IS NOT NULL`,
        [username, channelId, accessHash]
      );
    }
  }

  console.log(`Inserted ${inserted} new sources, skipped ${skipped} already-existing.`);
  await pool.end();
  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
