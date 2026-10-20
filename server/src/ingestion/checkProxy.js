// Verifies Telegram is reachable through the configured proxy, without
// logging in or touching the real session: a throwaway client performs the
// MTProto auth-key exchange and one encrypted request (help.getNearestDc).
// Run: npm run telegram:check-proxy
import 'dotenv/config';
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { buildProxyConfig, describeProxy } from './proxyConfig.js';
import { applyProxyTransport } from './fakeTlsConnection.js';

async function main() {
  const proxy = buildProxyConfig();
  console.log(`Checking Telegram connectivity via ${describeProxy(proxy)}…`);

  // Without real API credentials the request still travels the full path;
  // Telegram then answers API_ID_INVALID, which proves the transport works.
  const apiId = Number(process.env.TELEGRAM_API_ID) || 1;
  const apiHash = process.env.TELEGRAM_API_HASH || '00000000000000000000000000000000';
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 1, proxy });
  client.setLogLevel(process.env.TELEGRAM_LOG_LEVEL || 'error');
  applyProxyTransport(client, proxy);

  const started = Date.now();
  try {
    // GramJS's connect() can give up without throwing, so success is only
    // reported once an encrypted request has actually completed.
    await withTimeout(client.connect(), 'connecting');
    try {
      const dc = await withTimeout(client.invoke(new Api.help.GetNearestDc()), 'waiting for Telegram to answer');
      console.log(`✓ Telegram answered in ${Date.now() - started} ms — it sees you in ${dc.country}, nearest DC ${dc.nearestDc}`);
    } catch (err) {
      if (/API_ID_INVALID/.test(err.errorMessage || err.message)) {
        console.log(
          `✓ Telegram answered in ${Date.now() - started} ms (API_ID_INVALID — expected without real TELEGRAM_API_ID/HASH)`
        );
      } else {
        throw err;
      }
    }
    console.log('Proxy works.');
    await client.disconnect();
    process.exit(0);
  } catch (err) {
    console.error(`✗ Failed: ${err.message}`);
    await client.disconnect().catch(() => {});
    process.exit(1);
  }
}

const TIMEOUT_MS = 30_000;
function withTimeout(promise, what) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${TIMEOUT_MS / 1000}s ${what}`)), TIMEOUT_MS)),
  ]);
}

main();
