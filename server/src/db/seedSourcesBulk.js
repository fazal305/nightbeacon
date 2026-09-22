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
];

const RELIABILITY_NOTE =
  'Added in bulk from an operator-provided Telegram chat-folder list (t.me/addlist). Not individually vetted — reliability/bias unverified per-source.';

async function seed() {
  const client = await getTelegramClient();
  const channels = new Map(); // username -> { title }

  for (const slug of FOLDER_SLUGS) {
    const result = await client.invoke(new Api.chatlists.CheckChatlistInvite({ slug }));
    for (const chat of result.chats || []) {
      if (chat.username && !channels.has(chat.username)) {
        channels.set(chat.username, { title: chat.title || chat.username });
      }
    }
  }

  console.log(`Resolved ${channels.size} unique channels with a public username across ${FOLDER_SLUGS.length} folders.`);

  let inserted = 0;
  let skipped = 0;

  for (const [username, { title }] of channels) {
    const result = await pool.query(
      `INSERT INTO sources (channel_username, display_name, reliability_note)
       VALUES ($1, $2, $3)
       ON CONFLICT (channel_username) DO NOTHING
       RETURNING id`,
      [username, title, RELIABILITY_NOTE]
    );
    if (result.rows.length > 0) inserted++;
    else skipped++;
  }

  console.log(`Inserted ${inserted} new sources, skipped ${skipped} already-existing.`);
  await pool.end();
  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
