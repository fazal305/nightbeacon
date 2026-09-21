// Optional proxy for reaching Telegram's MTProto servers from a network where
// Telegram is blocked/restricted. Configured entirely via env vars — never
// hardcoded, since proxy credentials are as sensitive as any other secret.
//
// Two shapes, matching GramJS's ProxyInterface:
//   SOCKS4/5:  TELEGRAM_PROXY_IP, TELEGRAM_PROXY_PORT, TELEGRAM_PROXY_SOCKS_TYPE (4|5, default 5),
//              optionally TELEGRAM_PROXY_USERNAME / TELEGRAM_PROXY_PASSWORD
//   MTProxy:   TELEGRAM_PROXY_IP, TELEGRAM_PROXY_PORT, TELEGRAM_PROXY_SECRET
export function buildProxyConfig() {
  const ip = process.env.TELEGRAM_PROXY_IP;
  const port = process.env.TELEGRAM_PROXY_PORT;
  if (!ip || !port) return undefined;

  const base = { ip, port: Number(port) };

  if (process.env.TELEGRAM_PROXY_SECRET) {
    return { ...base, secret: process.env.TELEGRAM_PROXY_SECRET, MTProxy: true };
  }

  return {
    ...base,
    socksType: Number(process.env.TELEGRAM_PROXY_SOCKS_TYPE || 5),
    username: process.env.TELEGRAM_PROXY_USERNAME || undefined,
    password: process.env.TELEGRAM_PROXY_PASSWORD || undefined,
  };
}
