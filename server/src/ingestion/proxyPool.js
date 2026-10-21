import net from 'node:net';
import { Api } from 'telegram';
import { routeKey } from './proxyConfig.js';

// Speed measurements of the proxy routes, shared by ingestion and the bot so
// both connect through the fastest working proxy first. A measurement is the
// time to open a TCP connection to the proxy (null = it didn't answer).
const latency = new Map(); // routeKey -> { ms, at }

export function recordLatency(proxy, ms) {
  latency.set(routeKey(proxy), { ms, at: Date.now() });
}

export function latencyOf(proxy) {
  return latency.get(routeKey(proxy))?.ms;
}

// Fastest measured first, then not yet measured (in configured order), then
// the ones that didn't answer last time.
export function rankRoutes(list) {
  const rank = (p) => {
    const ms = latencyOf(p);
    return ms == null ? (latency.has(routeKey(p)) ? 2 : 1) : 0;
  };
  return list
    .map((p, i) => ({ p, i }))
    .sort((a, b) => rank(a.p) - rank(b.p) || (latencyOf(a.p) ?? 0) - (latencyOf(b.p) ?? 0) || a.i - b.i)
    .map((x) => x.p);
}

export function tcpLatency(proxy, timeoutMs = 5000) {
  if (!proxy) return Promise.resolve(null);
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host: proxy.ip, port: proxy.port });
    const done = (ms) => {
      socket.destroy();
      resolve(ms);
    };
    socket.setTimeout(timeoutMs, () => done(null));
    socket.once('connect', () => done(Date.now() - started));
    socket.once('error', () => done(null));
  });
}

// Measures every route (a few at a time) and records the results.
export async function measureRoutes(list, { probe = tcpLatency, concurrency = 10 } = {}) {
  const queue = list.filter(Boolean);
  const results = [];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length) {
        const proxy = queue.shift();
        const ms = await probe(proxy);
        recordLatency(proxy, ms);
        results.push({ proxy, ms });
      }
    })
  );
  return results;
}

const LINK_RE = /(?:tg:\/\/|https?:\/\/(?:www\.)?t(?:elegram)?\.me\/)(?:proxy|socks)\?[^\s"'<>)\]]+/gi;

// Proxy links in a bot's messages: in the text, behind linked words, and on
// URL buttons.
export function extractProxyLinks(messages) {
  const out = new Set();
  const add = (s) => {
    for (const m of String(s || '').matchAll(LINK_RE)) out.add(m[0].replace(/&amp;/g, '&'));
  };
  for (const msg of messages || []) {
    if (!msg) continue;
    add(msg.message);
    for (const e of msg.entities || []) if (e.url) add(e.url);
    for (const row of msg.replyMarkup?.rows || []) for (const b of row.buttons || []) if (b.url) add(b.url);
  }
  return [...out];
}

// A button on the bot's latest message that asks for (more) proxies.
export function proxyButton(messages) {
  for (const msg of messages || []) {
    for (const row of msg?.replyMarkup?.rows || []) {
      for (const b of row.buttons || []) {
        if (b instanceof Api.KeyboardButtonCallback && /proxy|прокси|پروکسی|get|new|more|refresh|🔄|➕/i.test(b.text || '')) {
          return { msg, button: b };
        }
      }
    }
  }
  return null;
}
