import fs from 'node:fs';

// Optional proxy for reaching Telegram's MTProto servers from a network where
// Telegram is blocked/restricted. Configured entirely via env vars — never
// hardcoded, since proxy credentials are as sensitive as any other secret.
//
// Two shapes, matching GramJS's ProxyInterface:
//   SOCKS4/5:  TELEGRAM_PROXY_IP, TELEGRAM_PROXY_PORT, TELEGRAM_PROXY_SOCKS_TYPE (4|5, default 5),
//              optionally TELEGRAM_PROXY_USERNAME / TELEGRAM_PROXY_PASSWORD
//   MTProxy:   TELEGRAM_PROXY_IP, TELEGRAM_PROXY_PORT, TELEGRAM_PROXY_SECRET
//
// Several routes can be configured at once, tried in order with automatic
// failover (see telegramClient.js) — free/public MTProxies come and go:
//   TELEGRAM_PROXY_LINKS       t.me/proxy, tg://proxy or t.me/socks links,
//                              separated by spaces, commas or newlines
//   TELEGRAM_PROXY_LINKS_FILE  path to a text file of such links (one per line,
//                              # comments allowed), relative to the working dir
// The single-proxy vars above, if set, are tried first.
//
// MTProxy secret formats:
//   - 32 hex chars (plain) and "dd" + 32 hex chars (padded) are handled by
//     GramJS's own MTProxy transport.
//   - "ee" + 32 hex + hex-encoded domain (Fake-TLS) is not supported by GramJS
//     at all; it is handled by our own transport in fakeTlsConnection.js. The
//     proxy object then carries the 16-byte key as `secret` and the domain as
//     `fakeTlsDomain`.
//   - Secrets copied from tg://proxy links are sometimes base64/base64url;
//     those are converted to hex.
export function parseMtproxySecret(raw) {
  const secret = toHex(raw);
  if (secret.startsWith('ee') && secret.length > 34) {
    const domain = Buffer.from(secret.slice(34), 'hex').toString('latin1');
    if (!/^[a-z0-9.-]+$/i.test(domain)) {
      throw new Error('TELEGRAM_PROXY_SECRET looks like a Fake-TLS ("ee") secret but its domain part is not a hostname');
    }
    return { secret: secret.slice(2, 34), fakeTlsDomain: domain };
  }
  return { secret: normalizeMtproxySecret(secret) };
}

function toHex(raw) {
  let secret = String(raw).trim();
  if (!/^[0-9a-f]+$/i.test(secret)) {
    const decoded = Buffer.from(secret.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (decoded.length === 0) throw new Error('TELEGRAM_PROXY_SECRET is neither hex nor base64');
    secret = decoded.toString('hex');
  }
  return secret.toLowerCase();
}

export function normalizeMtproxySecret(raw) {
  const secret = toHex(raw);
  if (secret.length === 34 && secret.startsWith('dd')) return secret;
  if (secret.length === 32) return secret;
  throw new Error(
    `TELEGRAM_PROXY_SECRET must be 16 bytes (32 hex chars), optionally prefixed with "dd"; got ${secret.length / 2} bytes`
  );
}

export function buildProxyConfig(env = process.env) {
  const ip = env.TELEGRAM_PROXY_IP;
  const port = env.TELEGRAM_PROXY_PORT;
  if (!ip || !port) return undefined;

  const base = { ip, port: Number(port) };
  if (!Number.isInteger(base.port) || base.port <= 0 || base.port > 65535) {
    throw new Error(`TELEGRAM_PROXY_PORT "${port}" is not a valid port`);
  }

  if (env.TELEGRAM_PROXY_SECRET) {
    return { ...base, ...parseMtproxySecret(env.TELEGRAM_PROXY_SECRET), MTProxy: true };
  }

  return {
    ...base,
    socksType: Number(env.TELEGRAM_PROXY_SOCKS_TYPE || 5),
    username: env.TELEGRAM_PROXY_USERNAME || undefined,
    password: env.TELEGRAM_PROXY_PASSWORD || undefined,
  };
}

// For logs: never includes the secret or password.
export function describeProxy(proxy) {
  if (!proxy) return 'direct connection';
  const kind = proxy.fakeTlsDomain
    ? `MTProxy (Fake-TLS, SNI ${proxy.fakeTlsDomain})`
    : proxy.MTProxy
      ? 'MTProxy'
      : `SOCKS${proxy.socksType}`;
  return `${kind} ${proxy.ip}:${proxy.port}`;
}

// Parses a Telegram proxy share link into a proxy config (with the original
// link kept, so working ones can be printed back for .env).
//   https://t.me/proxy?server=…&port=…&secret=…   (also tg://proxy?…)
//   https://t.me/socks?server=…&port=…[&user=…&pass=…]   (also tg://socks?…)
export function parseProxyLink(link) {
  let url;
  try {
    url = new URL(link.trim());
  } catch {
    throw new Error('not a URL');
  }
  const kind = url.protocol === 'tg:' ? url.hostname : url.pathname.replace(/^\//, '');
  const q = url.searchParams;
  const env =
    kind === 'socks'
      ? {
          TELEGRAM_PROXY_IP: q.get('server'),
          TELEGRAM_PROXY_PORT: q.get('port'),
          TELEGRAM_PROXY_USERNAME: q.get('user') || '',
          TELEGRAM_PROXY_PASSWORD: q.get('pass') || '',
        }
      : kind === 'proxy'
        ? { TELEGRAM_PROXY_IP: q.get('server'), TELEGRAM_PROXY_PORT: q.get('port'), TELEGRAM_PROXY_SECRET: q.get('secret') }
        : null;
  if (!env) throw new Error('not a t.me/proxy, tg://proxy or t.me/socks link');
  if (!env.TELEGRAM_PROXY_IP || !env.TELEGRAM_PROXY_PORT) throw new Error('link has no server/port');
  if (kind === 'proxy' && !env.TELEGRAM_PROXY_SECRET) throw new Error('MTProxy link has no secret');
  return { ...buildProxyConfig(env), link: link.trim() };
}

export function splitProxyLinks(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.replace(/#.*$/, ''))
    .join(' ')
    .split(/[\s,]+/)
    .filter(Boolean);
}

// All configured routes, in the order to try them. `undefined` stands for a
// direct connection (only when nothing is configured). Invalid entries are
// reported and skipped rather than failing startup — one bad link in a long
// list shouldn't stop the others from being used.
export function buildProxyCandidates(env = process.env, { readFile = (f) => fs.readFileSync(f, 'utf8'), warn = console.warn } = {}) {
  const candidates = [];
  const single = buildProxyConfig(env);
  if (single) candidates.push(single);

  const links = splitProxyLinks(env.TELEGRAM_PROXY_LINKS);
  if (env.TELEGRAM_PROXY_LINKS_FILE) links.push(...splitProxyLinks(readFile(env.TELEGRAM_PROXY_LINKS_FILE)));

  const seen = new Set(candidates.map(routeKey));
  for (const link of links) {
    try {
      const proxy = parseProxyLink(link);
      const key = routeKey(proxy);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(proxy);
    } catch (err) {
      warn(`[telegram] skipping proxy link (${err.message}): ${link.slice(0, 60)}`);
    }
  }
  return candidates.length > 0 ? candidates : [undefined];
}

function routeKey(p) {
  return `${p.ip}:${p.port}:${p.secret || ''}:${p.fakeTlsDomain || ''}:${p.username || ''}`;
}
