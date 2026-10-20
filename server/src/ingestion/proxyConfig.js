// Optional proxy for reaching Telegram's MTProto servers from a network where
// Telegram is blocked/restricted. Configured entirely via env vars — never
// hardcoded, since proxy credentials are as sensitive as any other secret.
//
// Two shapes, matching GramJS's ProxyInterface:
//   SOCKS4/5:  TELEGRAM_PROXY_IP, TELEGRAM_PROXY_PORT, TELEGRAM_PROXY_SOCKS_TYPE (4|5, default 5),
//              optionally TELEGRAM_PROXY_USERNAME / TELEGRAM_PROXY_PASSWORD
//   MTProxy:   TELEGRAM_PROXY_IP, TELEGRAM_PROXY_PORT, TELEGRAM_PROXY_SECRET
//
// MTProxy secret formats (checked against GramJS 2.26's TCPMTProxy):
//   - 32 hex chars (plain) and "dd" + 32 hex chars (padded) are supported.
//   - "ee" + 32 hex + hex-encoded domain (Fake-TLS, the format most public
//     MTProxy links now use) is NOT supported by GramJS — it would fail deep
//     inside the connection with "MTProxy secret must be a hex-string
//     representing 16 bytes". It is rejected here, at startup, with a clear
//     message instead. Use the proxy's dd/plain secret if it offers one, or a
//     SOCKS5 proxy.
//   - Secrets copied from tg://proxy links are sometimes base64url; those
//     are converted to hex.
export function normalizeMtproxySecret(raw) {
  let secret = String(raw).trim();
  if (!/^[0-9a-f]+$/i.test(secret)) {
    const decoded = Buffer.from(secret.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (decoded.length === 0) throw new Error('TELEGRAM_PROXY_SECRET is neither hex nor base64');
    secret = decoded.toString('hex');
  }
  secret = secret.toLowerCase();

  if (secret.startsWith('ee') && secret.length > 34) {
    throw new Error(
      'TELEGRAM_PROXY_SECRET is a Fake-TLS ("ee...") MTProxy secret, which GramJS does not support. ' +
        'Use the proxy\'s plain/"dd" secret if it has one, or configure a SOCKS5 proxy instead.'
    );
  }
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
    return { ...base, secret: normalizeMtproxySecret(env.TELEGRAM_PROXY_SECRET), MTProxy: true };
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
  return `${proxy.MTProxy ? 'MTProxy' : `SOCKS${proxy.socksType}`} ${proxy.ip}:${proxy.port}`;
}
