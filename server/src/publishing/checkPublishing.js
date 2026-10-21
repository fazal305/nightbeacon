// Explains why nothing is (or isn't) being posted, checking each link of the
// chain in order: config -> fresh stories ready -> drafts -> approval -> bot
// login -> bot is admin of the channel with "Post messages".
//
//   npm run publish:check               diagnose only, posts nothing
//   npm run publish:check -- --send-test also send one test post to each bot channel
import 'dotenv/config';
import { Api } from 'telegram';
import { pool } from '../db/pool.js';
import { describeError } from '../db/describeError.js';
import { withTimeout, REQUEST_TIMEOUT_MS } from '../ingestion/telegramClient.js';
import { publishConfig } from './config.js';
import { getBotClient, getChannelPeer, sendToChannel } from './botClient.js';

const sendTest = process.argv.includes('--send-test');
const ok = (msg) => console.log(`  OK   ${msg}`);
const bad = (msg) => console.log(`  !!   ${msg}`);
const info = (msg) => console.log(`       ${msg}`);

async function main() {
  console.log('1. Configuration');
  let config;
  try {
    config = publishConfig();
  } catch (err) {
    bad(`publishing config is invalid: ${err.message}`);
    return;
  }
  if (!config.channelsFile) bad('no channels file found — set PUBLISH_CHANNELS_FILE=channels/channels.json in server/.env');
  else ok(`channels file: ${config.channelsFile}`);
  for (const c of config.channels) {
    info(`${c.key.padEnd(8)} ${c.telegram.padEnd(22)} ${c.delivery.padEnd(6)} drafts for: ${c.draftPriorities.join(',') || '-'}` +
      (c.delivery === 'bot' ? `   auto-posts: ${config.mode === 'auto' ? c.autoPriorities.join(',') : '(only in auto mode)'}` : ''));
  }
  if (config.mode === 'off') bad('PUBLISH_MODE=off — nothing is drafted automatically; set PUBLISH_MODE=auto (or review)');
  else if (config.mode === 'review') bad('PUBLISH_MODE=review — the bot posts ONLY after you click "Approve & queue". For automatic posting set PUBLISH_MODE=auto');
  else ok('PUBLISH_MODE=auto — high-priority drafts for the bot channel are posted without review');
  if (!config.botToken) bad('TELEGRAM_BOT_TOKEN is not set');

  console.log(`\n2. Stories available to draft (last ${config.maxAgeMinutes} min)`);
  const { rows: fresh } = await pool.query(
    `SELECT ri.status, ri.priority, count(*)::int AS n
     FROM raw_items ri
     WHERE ri.telegram_date >= now() - make_interval(mins => $1) AND ri.dedup_status IN ('unique', 'update')
     GROUP BY 1, 2 ORDER BY 1, 2`,
    [config.maxAgeMinutes]
  );
  if (fresh.length === 0) bad('no new unique stories in this window — is ingestion running?');
  for (const r of fresh) info(`${String(r.status).padEnd(14)} priority ${String(r.priority ?? '-').padEnd(7)} ${r.n}`);
  const ready = fresh.filter((r) => r.status === 'ready' && ['high', 'medium'].includes(r.priority)).reduce((n, r) => n + r.n, 0);
  if (fresh.length && !ready) bad('none are fully processed (status ready) at high/medium priority yet — translation/classification is behind');
  else if (ready) ok(`${ready} high/medium stories ready to draft`);

  console.log('\n3. Publications');
  const { rows: counts } = await pool.query(
    `SELECT channel_key, status, count(*)::int AS n FROM publications GROUP BY 1, 2 ORDER BY 1, 2`
  );
  if (counts.length === 0) bad('no drafts exist yet');
  for (const r of counts) info(`${r.channel_key.padEnd(8)} ${r.status.padEnd(14)} ${r.n}`);
  const { rows: errors } = await pool.query(
    `SELECT DISTINCT ON (last_error) channel_key, status, last_error FROM publications
     WHERE last_error IS NOT NULL ORDER BY last_error, updated_at DESC LIMIT 5`
  );
  for (const e of errors) bad(`${e.channel_key} (${e.status}): ${e.last_error}`);

  console.log('\n4. Bot');
  if (!config.botToken) return;
  let client;
  try {
    client = await getBotClient(config);
    const me = await withTimeout(client.getMe(), REQUEST_TIMEOUT_MS, 'getMe');
    ok(`logged in as @${me.username}`);
  } catch (err) {
    bad(`bot login failed: ${describeError(err)}`);
    return;
  }
  for (const channel of config.channels.filter((c) => c.delivery === 'bot')) {
    try {
      const peer = await getChannelPeer(client, config, channel);
      const { participant } = await withTimeout(
        client.invoke(new Api.channels.GetParticipant({ channel: peer, participant: new Api.InputPeerSelf() })),
        REQUEST_TIMEOUT_MS,
        'getParticipant'
      );
      const canPost = participant instanceof Api.ChannelParticipantCreator || participant.adminRights?.postMessages;
      if (canPost) ok(`${channel.telegram}: bot is admin with "Post messages"`);
      else bad(`${channel.telegram}: bot is in the channel but lacks "Post messages" — edit its admin rights`);
      if (canPost && sendTest) {
        const { messageId } = await sendToChannel('Test post from Nightbeacon — you can delete this.', channel, config);
        ok(`${channel.telegram}: test post sent (message ${messageId})`);
      }
    } catch (err) {
      const msg = describeError(err);
      if (/USER_NOT_PARTICIPANT|CHANNEL_PRIVATE|CHAT_ADMIN_REQUIRED/.test(msg)) {
        bad(`${channel.telegram}: the bot is not an admin of this channel — add it as admin with "Post messages"`);
      } else {
        bad(`${channel.telegram}: ${msg}`);
      }
    }
  }
}

main()
  .catch((err) => {
    console.error(describeError(err));
    process.exitCode = 1;
  })
  .finally(() => setTimeout(() => process.exit(), 500));
