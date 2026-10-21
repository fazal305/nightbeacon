// Fills channels/official-sources.md from a Telegram chat folder of official
// channels (t.me/addlist/<slug>), and makes sure each of them is a
// monitored source. Uses chatlists.CheckChatlistInvite: a read-only preview
// that joins nothing (see seedSourcesBulk.js).
//
//   npm run sources:official -- https://t.me/addlist/<slug>
//
// The organisation for each channel is guessed from its title; check the
// written file and correct any names. Re-running replaces only the block
// this script wrote, so lines you added by hand are kept.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Api } from 'telegram';
import { pool } from './pool.js';
import { getTelegramClient } from '../ingestion/telegramClient.js';
import { publishConfig } from '../publishing/config.js';

// Most specific first ("Kata'ib Hezbollah" before "Hezbollah").
const ORGANISATIONS = [
  ["Kata'ib Hezbollah", ['كتائب حزب الله', 'kataib hezbollah', "kata'ib hezbollah", 'kataib hizbollah']],
  ['Islamic Resistance in Iraq', ['المقاومة الإسلامية في العراق', 'المقاومة الاسلامية في العراق', 'islamic resistance in iraq']],
  ['Harakat al-Nujaba', ['النجباء', 'nujaba']],
  ['Al-Qassam Brigades', ['القسام', 'qassam']],
  ['Saraya al-Quds', ['سرايا القدس', 'saraya al-quds', 'saraya alquds', 'al-quds brigades', 'quds brigades']],
  ['Palestinian Islamic Jihad', ['الجهاد الإسلامي', 'الجهاد الاسلامي', 'islamic jihad']],
  ['Al-Aqsa Martyrs Brigades', ['شهداء الأقصى', 'شهداء الاقصى', 'al-aqsa martyrs']],
  ['Abu Ali Mustafa Brigades', ['أبو علي مصطفى', 'ابو علي مصطفى', 'abu ali mustafa']],
  ['PFLP', ['الجبهة الشعبية', 'pflp']],
  ['Hamas', ['حماس', 'hamas']],
  ['Yemeni Armed Forces', ['القوات المسلحة اليمنية', 'القوات المسلحة اليمني', 'الإعلام الحربي اليمني', 'يحيى سريع', 'yemeni armed forces', 'military media y']],
  ['Ansarallah', ['أنصار الله', 'انصار الله', 'ansarallah', 'ansar allah']],
  ['IRGC', ['سپاه', 'الحرس الثوري', 'irgc', 'sepah', 'revolutionary guard']],
  // "الإعلام الحربي" (war media) is used by many groups; only Hezbollah's own
  // channel pairs it with "المقاومة الإسلامية" and no other group name.
  ['Hezbollah', ['حزب الله', 'المقاومة الإسلامية في لبنان', 'المقاومة الاسلامية في لبنان', 'الإعلام الحربي في المقاومة الإسلامية', 'hezbollah', 'hizbollah', 'hizbullah', 'islamic resistance in lebanon']],
];

export function guessOrganisation(title) {
  const t = String(title || '').toLowerCase();
  for (const [name, keys] of ORGANISATIONS) if (keys.some((k) => t.includes(k.toLowerCase()))) return name;
  return null;
}

const START = '# --- channels from Telegram folder';
const END = '# --- end of folder channels ---';

// Replaces this script's block (if any) and keeps everything else.
export function mergeIntoFile(existing, slug, lines) {
  const block = [`${START} ${slug} (npm run sources:official) ---`, ...lines, END].join('\n');
  const re = new RegExp(`${START}[^\\n]*\\n[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  return re.test(existing) ? existing.replace(re, block) : `${existing.replace(/\s*$/, '')}\n\n${block}\n`;
}

async function main() {
  const arg = process.argv[2];
  const slug = arg && (arg.match(/addlist\/([\w-]+)/)?.[1] || arg);
  if (!slug) {
    console.error('Usage: npm run sources:official -- https://t.me/addlist/<slug>');
    process.exitCode = 1;
    return;
  }
  const client = await getTelegramClient();
  const result = await client.invoke(new Api.chatlists.CheckChatlistInvite({ slug }));

  const lines = [];
  let added = 0;
  for (const chat of result.chats || []) {
    const username = chat.username || chat.usernames?.find((u) => u.active)?.username;
    if (!username) {
      console.log(`  (skipped "${chat.title}": no public username)`);
      continue;
    }
    const isChannel = chat.className === 'Channel' && chat.accessHash != null;
    const ins = await pool.query(
      `INSERT INTO sources (channel_username, display_name, reliability_note, telegram_channel_id, telegram_access_hash)
       VALUES ($1, $2, 'Official channel (from the operator''s official-channels folder).', $3, $4)
       ON CONFLICT (channel_username) DO NOTHING RETURNING id`,
      [username, chat.title || username, isChannel ? chat.id.toString() : null, isChannel ? chat.accessHash.toString() : null]
    );
    added += ins.rowCount;
    const organisation = guessOrganisation(chat.title) || chat.title || username;
    lines.push(`@${username} => ${organisation}`);
    console.log(`  @${username.padEnd(30)} ${String(chat.title).slice(0, 45).padEnd(46)} => ${organisation}`);
  }

  const config = publishConfig();
  const file = config.channelsFile
    ? path.join(path.dirname(config.channelsFile), 'official-sources.md')
    : path.resolve('channels/official-sources.md');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  fs.writeFileSync(file, mergeIntoFile(existing, slug, lines));

  console.log(`\n${lines.length} official channel(s) written to ${file}`);
  console.log(`${added} of them were not monitored yet and were added as sources.`);
  console.log('Check the organisation names in that file and correct any that are wrong (it is re-read automatically).');
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
