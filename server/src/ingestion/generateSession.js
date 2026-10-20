// One-time interactive script to generate a Telegram MTProto session string.
// Run: npm run telegram:login
// This must be run interactively by a human (phone number + login code / 2FA),
// never automated — the resulting string is an extremely sensitive credential.
// It is printed ONCE to your terminal so you can paste it into your local .env.
// Never commit it, log it elsewhere, or share it.
import 'dotenv/config';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import input from 'input';
import { buildProxyConfig, describeProxy } from './proxyConfig.js';
import { applyProxyTransport } from './fakeTlsConnection.js';

async function main() {
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH;

  if (!apiId || !apiHash) {
    console.error(
      'Set TELEGRAM_API_ID and TELEGRAM_API_HASH in your .env first (get them at https://my.telegram.org).'
    );
    process.exit(1);
  }

  const proxy = buildProxyConfig();
  if (proxy) {
    console.log(`Using proxy: ${describeProxy(proxy)}\n`);
  }

  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 3,
    proxy,
  });
  applyProxyTransport(client, proxy);

  await client.start({
    phoneNumber: async () => await input.text('Phone number (with country code): '),
    password: async () => await input.text('2FA password (if enabled): '),
    phoneCode: async () => await input.text('Login code sent to Telegram/SMS: '),
    onError: (err) => console.error(err),
  });

  console.log('\nLogin successful. Add this to your local .env as TELEGRAM_SESSION:\n');
  console.log(client.session.save());
  console.log('\nDo not commit this value or paste it anywhere public.\n');

  await client.disconnect();
  process.exit(0);
}

main();
