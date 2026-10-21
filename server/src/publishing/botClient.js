import crypto from 'node:crypto';
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Logger, LogLevel } from 'telegram/extensions/Logger.js';
import { returnBigInt } from 'telegram/Helpers.js';
import { buildProxyCandidates, describeProxy } from '../ingestion/proxyConfig.js';
import { applyProxyTransport } from '../ingestion/fakeTlsConnection.js';
import { withTimeout, isTelegramAnswer, REQUEST_TIMEOUT_MS } from '../ingestion/telegramClient.js';
import { getState, setState } from '../db/appState.js';

// The publishing bot, logged in with the BotFather token over MTProto — not
// the HTTPS Bot API (api.telegram.org), which is blocked on networks where
// Telegram is, and which MTProxies cannot carry. Using GramJS means the bot
// goes through exactly the same proxy routes, Fake-TLS transport and failover
// as ingestion. Its session is stored in app_state so it logs in once.
const CONNECT_TIMEOUT_MS = Number(process.env.TELEGRAM_CONNECT_TIMEOUT_MS || 20000);

let bot = null;
let connecting = null;
let routeIndex = 0;
const channelPeers = new Map(); // telegram username -> InputPeerChannel

const tokenKey = (token) => crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);

export async function getBotClient(config) {
  if (bot) return bot;
  if (connecting) return connecting;
  connecting = (async () => {
    if (!config.botToken) throw new Error('TELEGRAM_BOT_TOKEN is not set');
    const apiId = Number(process.env.TELEGRAM_API_ID);
    const apiHash = process.env.TELEGRAM_API_HASH;
    if (!apiId || !apiHash) throw new Error('TELEGRAM_API_ID / TELEGRAM_API_HASH are not set');

    const sessionKey = `bot_session:${tokenKey(config.botToken)}`;
    const saved = (await getState(sessionKey))?.value || '';
    const routes = buildProxyCandidates();
    const failures = [];
    for (let i = 0; i < routes.length; i++) {
      const idx = (routeIndex + i) % routes.length;
      const proxy = routes[idx];
      const c = new TelegramClient(new StringSession(saved), apiId, apiHash, {
        connectionRetries: routes.length > 1 ? 1 : 5,
        proxy,
        baseLogger: new Logger(LogLevel.ERROR),
      });
      applyProxyTransport(c, proxy);
      try {
        await withTimeout(c.start({ botAuthToken: config.botToken }), CONNECT_TIMEOUT_MS, 'bot login');
        const session = c.session.save();
        if (session !== saved) await setState(sessionKey, session);
        routeIndex = idx;
        bot = c;
        console.log(`[publishing] bot connected via ${describeProxy(proxy)}`);
        return c;
      } catch (err) {
        c.destroy().catch(() => {});
        // A Telegram answer such as ACCESS_TOKEN_INVALID won't change with
        // another route — stop instead of cycling every proxy.
        if (isTelegramAnswer(err)) throw err;
        failures.push(`${describeProxy(proxy)}: ${err.message}`);
      }
    }
    routeIndex = (routeIndex + 1) % routes.length;
    throw new Error(`bot could not reach Telegram via any route. ${failures.slice(0, 2).join(' | ')}`);
  })();
  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

// Drop the current connection; the next send reconnects via the next route.
export function resetBotClient() {
  if (bot) bot.destroy().catch(() => {});
  bot = null;
  routeIndex += 1;
}

// The bot resolves each channel's username once; the result is stored so it
// never needs contacts.ResolveUsername again.
async function getChannelPeer(client, config, channel) {
  const handle = channel.telegram.toLowerCase();
  if (channelPeers.has(handle)) return channelPeers.get(handle);
  const key = `bot_channel:${tokenKey(config.botToken)}:${handle}`;
  const saved = await getState(key);
  let peer;
  if (saved) {
    const { id, hash } = JSON.parse(saved.value);
    peer = new Api.InputPeerChannel({ channelId: returnBigInt(id), accessHash: returnBigInt(hash) });
  } else {
    peer = await withTimeout(client.getInputEntity(channel.telegram), REQUEST_TIMEOUT_MS, 'resolve channel');
    if (!(peer instanceof Api.InputPeerChannel)) throw new Error(`${channel.telegram} is not a channel`);
    await setState(key, JSON.stringify({ id: peer.channelId.toString(), hash: peer.accessHash.toString() }));
  }
  channelPeers.set(handle, peer);
  return peer;
}

export async function sendToChannel(text, channel, config) {
  const client = await getBotClient(config);
  const peer = await getChannelPeer(client, config, channel);
  const parseMode = channel.parseMode === 'html' || channel.parseMode === 'markdown' ? channel.parseMode : false;
  const message = await withTimeout(
    client.sendMessage(peer, { message: text, parseMode, linkPreview: false }),
    REQUEST_TIMEOUT_MS,
    'sendMessage'
  );
  return { messageId: message.id };
}
