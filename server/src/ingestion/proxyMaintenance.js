import fs from 'node:fs';
import { Api } from 'telegram';
import { buildProxyCandidates, describeProxy, parseProxyLink, routeKey } from './proxyConfig.js';
import { measureRoutes, latencyOf, extractProxyLinks, proxyButton, tcpLatency } from './proxyPool.js';
import { getTelegramClient, currentProxy, reloadRoutes, switchRoute, resolveGate, withTimeout, REQUEST_TIMEOUT_MS } from './telegramClient.js';
import { sleep } from '../pipeline/rateGate.js';

// Keeps the proxy list healthy, every PROXY_CHECK_MINUTES (default 10):
//   1. measures how fast every proxy answers;
//   2. when fewer than PROXY_MIN_WORKING (default 3) answer, asks the proxy
//      bot (PROXY_BOT, default @mtpro_xyz_bot) for new links — at most once
//      an hour — and saves the ones that answer to proxies-found.txt;
//   3. moves to a clearly faster proxy (at most once every 30 minutes) when
//      the one in use is slow or stopped answering.
const CHECK_MS = Number(process.env.PROXY_CHECK_MINUTES || 10) * 60_000;
const MIN_WORKING = Number(process.env.PROXY_MIN_WORKING || 3);
const BOT_EVERY_MS = 60 * 60_000;
const SWITCH_EVERY_MS = 30 * 60_000;
const MAX_FOUND = 40;
const foundFile = () => process.env.TELEGRAM_PROXY_FOUND_FILE || 'proxies-found.txt';

const state = { lastBotFetch: 0, lastSwitch: Date.now(), running: false };

// Worth switching: the current route didn't answer, or another is at least
// 40% and 150 ms faster.
export function shouldSwitch(currentMs, bestMs) {
  if (bestMs == null) return false;
  if (currentMs == null) return true;
  return bestMs < currentMs * 0.6 && currentMs - bestMs > 150;
}

// Asks the bot for proxy links. `deps` is injectable for tests.
export async function fetchFromBot(client, { wait = (ms) => sleep(ms) } = {}) {
  const botName = String(process.env.PROXY_BOT || 'mtpro_xyz_bot').replace(/^@/, '');
  await resolveGate.wait();
  const peer = await withTimeout(client.getInputEntity(botName), REQUEST_TIMEOUT_MS, 'resolve proxy bot');
  await withTimeout(client.sendMessage(peer, { message: process.env.PROXY_BOT_COMMAND || '/start' }), REQUEST_TIMEOUT_MS, 'message proxy bot');
  await wait(8000);
  let messages = await withTimeout(client.getMessages(peer, { limit: 10 }), REQUEST_TIMEOUT_MS, 'read proxy bot');
  let links = extractProxyLinks(messages);
  if (links.length === 0) {
    // Some bots hand proxies out behind a "Get proxy" button.
    const hit = proxyButton(messages);
    if (hit) {
      await withTimeout(
        client.invoke(new Api.messages.GetBotCallbackAnswer({ peer, msgId: hit.msg.id, data: hit.button.data })),
        REQUEST_TIMEOUT_MS,
        'press proxy bot button'
      ).catch(() => {});
      await wait(8000);
      messages = await withTimeout(client.getMessages(peer, { limit: 10 }), REQUEST_TIMEOUT_MS, 'read proxy bot');
      links = extractProxyLinks(messages);
    }
  }
  return links;
}

// Keeps the found-links file to links that answer (plus brand-new ones).
function saveFound(links) {
  fs.writeFileSync(foundFile(), `# Found automatically from the proxy bot (newest first)\n${links.slice(0, MAX_FOUND).join('\n')}\n`);
}

function readFound() {
  try {
    return fs.readFileSync(foundFile(), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}

export async function proxyCheck({ fetchLinks = fetchFromBot, probe = tcpLatency, now = Date.now } = {}) {
  const list = buildProxyCandidates();
  if (list.length === 1 && list[0] === undefined) return { skipped: 'no proxies configured' };
  const results = await measureRoutes(list, { probe });
  let working = results.filter((r) => r.ms != null);
  const report = { measured: results.length, working: working.length, added: 0, switched: false };

  // 2. Too few working: get more from the bot.
  if (working.length < MIN_WORKING && now() - state.lastBotFetch > BOT_EVERY_MS) {
    state.lastBotFetch = now();
    try {
      const client = await getTelegramClient();
      const known = new Set(list.filter(Boolean).map(routeKey));
      const fresh = [];
      for (const link of await fetchLinks(client)) {
        try {
          const proxy = parseProxyLink(link);
          if (known.has(routeKey(proxy))) continue;
          known.add(routeKey(proxy));
          const ms = await probe(proxy);
          if (ms == null) continue;
          fresh.push(link);
          working.push({ proxy, ms });
        } catch {
          // not a usable link
        }
      }
      // Previously found links that still answer stay; dead ones go.
      const alive = new Set(results.filter((r) => r.ms != null && r.proxy?.link).map((r) => r.proxy.link));
      saveFound([...fresh, ...readFound().filter((l) => alive.has(l))]);
      report.added = fresh.length;
      console.log(
        `[proxy] only ${report.working} proxy(ies) answering — got ${fresh.length} new working link(s) from @${String(process.env.PROXY_BOT || 'mtpro_xyz_bot').replace(/^@/, '')}`
      );
    } catch (err) {
      console.warn(`[proxy] could not get new proxies from the bot: ${err.message}`);
    }
  } else if (working.length < MIN_WORKING) {
    console.warn(`[proxy] only ${working.length} proxy(ies) answering; will ask the bot again within the hour`);
  }
  reloadRoutes();

  // 3. Faster route available?
  const current = currentProxy();
  if (current && now() - state.lastSwitch > SWITCH_EVERY_MS) {
    const best = working.slice().sort((a, b) => a.ms - b.ms)[0];
    const currentMs = latencyOf(current);
    if (best && routeKey(best.proxy) !== routeKey(current) && shouldSwitch(currentMs, best.ms)) {
      console.log(
        `[proxy] ${describeProxy(best.proxy)} answers in ${best.ms} ms vs ${currentMs == null ? 'no answer' : `${currentMs} ms`} for the current one — switching`
      );
      state.lastSwitch = now();
      report.switched = await switchRoute(best.proxy);
    }
  }
  return report;
}

export function startProxyMaintenance() {
  const tick = async () => {
    if (state.running) return;
    state.running = true;
    try {
      await proxyCheck();
    } catch (err) {
      console.warn(`[proxy] check failed: ${err.message}`);
    } finally {
      state.running = false;
    }
  };
  setTimeout(tick, 60_000).unref?.();
  setInterval(tick, CHECK_MS).unref?.();
}

export function _resetProxyMaintenanceForTests() {
  state.lastBotFetch = 0;
  state.lastSwitch = 0;
  state.running = false;
}
