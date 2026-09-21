import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

let client = null;

// A single long-lived MTProto client for the whole process — GramJS expects
// one persistent connection, not one per request/poll.
export async function getTelegramClient() {
  if (client) return client;

  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH;
  const sessionString = process.env.TELEGRAM_SESSION;

  if (!apiId || !apiHash || !sessionString) {
    throw new Error(
      'Telegram credentials missing. Run "npm run telegram:login" once to generate TELEGRAM_SESSION, ' +
        'and set TELEGRAM_API_ID / TELEGRAM_API_HASH from https://my.telegram.org.'
    );
  }

  client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 3,
  });

  await client.connect();
  return client;
}
