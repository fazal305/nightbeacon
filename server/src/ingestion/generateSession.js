// One-time interactive script to generate a Telegram MTProto session string.
// Run: npm run telegram:login
// This must be run interactively by a human (phone number + login code / 2FA),
// never automated — the resulting string is an extremely sensitive credential.
// It is printed ONCE to your terminal so you can paste it into your local .env.
// Never commit it, log it elsewhere, or share it.
import 'dotenv/config';
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Logger, LogLevel } from 'telegram/extensions/Logger.js';
import input from 'input';
import { buildProxyCandidates, describeProxy } from './proxyConfig.js';
import { applyProxyTransport } from './fakeTlsConnection.js';
import { withTimeout, isTelegramAnswer } from './telegramClient.js';

const TIMEOUT_MS = Number(process.env.TELEGRAM_CONNECT_TIMEOUT_MS || 20000);

// Same routes as the server (single proxy vars and/or TELEGRAM_PROXY_LINKS),
// tried in order; login proceeds over the first that Telegram answers on.
async function connectFirstWorkingRoute(apiId, apiHash) {
  const routes = buildProxyCandidates();
  for (const [i, proxy] of routes.entries()) {
    console.log(`Trying route ${i + 1}/${routes.length}: ${describeProxy(proxy)}`);
    const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
      connectionRetries: routes.length > 1 ? 1 : 3,
      proxy,
      baseLogger: new Logger(LogLevel.ERROR),
    });
    applyProxyTransport(client, proxy);
    try {
      await withTimeout(client.connect(), TIMEOUT_MS, 'connect');
      try {
        await withTimeout(client.invoke(new Api.help.GetNearestDc()), TIMEOUT_MS, 'request');
      } catch (err) {
        if (!isTelegramAnswer(err)) throw err;
      }
      console.log('Connected.\n');
      return client;
    } catch (err) {
      console.log(`  failed: ${err.message}`);
      client.destroy().catch(() => {});
    }
  }
  return null;
}

async function main() {
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH;

  if (!apiId || !apiHash) {
    console.error(
      'Set TELEGRAM_API_ID and TELEGRAM_API_HASH in your .env first (get them at https://my.telegram.org).'
    );
    process.exit(1);
  }

  const client = await connectFirstWorkingRoute(apiId, apiHash);
  if (!client) {
    console.error('\nCould not reach Telegram on any configured route. Run "npm run telegram:check-proxy" for details.');
    process.exit(1);
  }

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
