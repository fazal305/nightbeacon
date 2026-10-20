// Tests every configured route to Telegram, without logging in or touching
// the real session: for each, a throwaway client performs the MTProto
// auth-key exchange and one encrypted request (help.getNearestDc).
//
//   npm run telegram:check-proxy                 routes from .env
//   npm run telegram:check-proxy -- proxies.txt  links from a file
//   npm run telegram:check-proxy -- "https://t.me/proxy?…" "tg://proxy?…"
//
// Prints the working routes fastest first, plus a TELEGRAM_PROXY_LINKS line
// to paste into .env.
import 'dotenv/config';
import fs from 'node:fs';
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Logger, LogLevel } from 'telegram/extensions/Logger.js';
import { buildProxyCandidates, describeProxy, splitProxyLinks } from './proxyConfig.js';
import { applyProxyTransport } from './fakeTlsConnection.js';
import { withTimeout, isTelegramAnswer } from './telegramClient.js';

const TIMEOUT_MS = Number(process.env.TELEGRAM_CONNECT_TIMEOUT_MS || 20000);
const CONCURRENCY = 6;

// Without real API credentials the request still travels the full path;
// Telegram then answers API_ID_INVALID, which proves the route works.
const apiId = Number(process.env.TELEGRAM_API_ID) || 1;
const apiHash = process.env.TELEGRAM_API_HASH || '00000000000000000000000000000000';

async function probe(proxy) {
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 1,
    proxy,
    baseLogger: new Logger(LogLevel.NONE),
  });
  applyProxyTransport(client, proxy);
  const started = Date.now();
  try {
    await withTimeout(client.connect(), TIMEOUT_MS, 'connect');
    let where = '';
    try {
      const dc = await withTimeout(client.invoke(new Api.help.GetNearestDc()), TIMEOUT_MS, 'request');
      where = ` (Telegram sees you in ${dc.country})`;
    } catch (err) {
      // GramJS's connect() can give up without throwing, so only an actual
      // answer from Telegram counts — an RPC error is one.
      if (!isTelegramAnswer(err)) throw err;
    }
    return { proxy, ok: true, ms: Date.now() - started, note: where };
  } catch (err) {
    return { proxy, ok: false, ms: Date.now() - started, note: err.message };
  } finally {
    client.destroy().catch(() => {});
  }
}

function routesFromArgs(args) {
  if (args.length === 0) return buildProxyCandidates();
  const links = args.flatMap((a) => (fs.existsSync(a) ? splitProxyLinks(fs.readFileSync(a, 'utf8')) : [a]));
  return buildProxyCandidates({ TELEGRAM_PROXY_LINKS: links.join(' ') });
}

async function main() {
  const routes = routesFromArgs(process.argv.slice(2));
  console.log(`Testing ${routes.length} route(s) to Telegram (timeout ${TIMEOUT_MS / 1000}s each, ${CONCURRENCY} at a time)…\n`);

  const results = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, routes.length) }, async () => {
      while (next < routes.length) {
        const r = await probe(routes[next++]);
        results.push(r);
        console.log(`${r.ok ? '✓' : '✗'} ${describeProxy(r.proxy).padEnd(62)} ${r.ok ? `${r.ms} ms${r.note}` : r.note}`);
      }
    })
  );

  const working = results.filter((r) => r.ok).sort((a, b) => a.ms - b.ms);
  console.log(`\n${working.length} of ${routes.length} route(s) work.`);
  if (working.length === 0) {
    console.log('None reached Telegram. Check the clock is synced (Fake-TLS proxies reject skewed handshakes) or try fresh proxy links.');
    process.exit(1);
  }
  console.log('\nFastest first:');
  for (const r of working) console.log(`  ${String(r.ms).padStart(6)} ms  ${describeProxy(r.proxy)}`);
  const links = working.map((r) => r.proxy?.link).filter(Boolean);
  if (links.length > 0) {
    console.log('\nPaste into server/.env (tried in this order, with automatic failover):\n');
    console.log(`TELEGRAM_PROXY_LINKS=${links.join(',')}`);
  }
  process.exit(0);
}

main();
