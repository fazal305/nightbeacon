import crypto from 'node:crypto';
import fs from 'node:fs';
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Logger, LogLevel } from 'telegram/extensions/Logger.js';
import { returnBigInt } from 'telegram/Helpers.js';
import { CustomFile } from 'telegram/client/uploads.js';
import { buildProxyCandidates, describeProxy } from '../ingestion/proxyConfig.js';
import { applyProxyTransport } from '../ingestion/fakeTlsConnection.js';
import { rankRoutes } from '../ingestion/proxyPool.js';
import { withTimeout, isTelegramAnswer, floodWaitSeconds, REQUEST_TIMEOUT_MS } from '../ingestion/telegramClient.js';
import { CAPTION_LIMIT, uploadAttributes } from './media.js';
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
    const routes = rankRoutes(buildProxyCandidates());
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
export async function getChannelPeer(client, config, channel) {
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

const UPLOAD_TIMEOUT_MS = Number(process.env.PUBLISH_MEDIA_TIMEOUT_SECONDS || 180) * 1000;

// Uploads the post's photos/videos with the text as caption (an album when
// there are several). Telegram captions are limited to 1024 characters, so a
// longer text follows the media as its own message.
async function sendWithMedia(client, peer, text, media, parseMode, silent = false) {
  const files = media.map((m) => new CustomFile(m.name, fs.statSync(m.file).size, m.file));
  const fitsCaption = text.length <= CAPTION_LIMIT;
  const sent = await withTimeout(
    client.sendFile(peer, {
      file: files.length === 1 ? files[0] : files,
      caption: fitsCaption ? text : '',
      parseMode,
      attributes: files.length === 1 ? uploadAttributes(media[0]) : media.map(uploadAttributes),
      supportsStreaming: true,
      workers: 1,
      silent,
    }),
    UPLOAD_TIMEOUT_MS * media.length,
    'send media'
  );
  const first = Array.isArray(sent) ? sent[0] : sent;
  if (fitsCaption) return { messageId: first.id, mediaCount: media.length };
  const message = await withTimeout(
    client.sendMessage(peer, { message: text, parseMode, linkPreview: false, silent }),
    REQUEST_TIMEOUT_MS,
    'sendMessage'
  );
  return { messageId: message.id, mediaCount: media.length };
}

// `media`: files from loadItemMedia(). If the media can't be sent (refused,
// upload error), the post still goes out as text; `mediaError` says why.
// `silent`: delivered without a notification sound (see sender.js).
export async function sendToChannel(text, channel, config, media = [], { silent = false } = {}) {
  const client = await getBotClient(config);
  const peer = await getChannelPeer(client, config, channel);
  const parseMode = channel.parseMode === 'html' || channel.parseMode === 'markdown' ? channel.parseMode : false;
  let mediaError = null;
  if (media.length > 0) {
    try {
      return await sendWithMedia(client, peer, text, media, parseMode, silent);
    } catch (err) {
      // A flood-wait applies to the text too: requeue. Anything else about
      // the media (refused, upload error or timeout) → post the text alone;
      // if the connection itself is down, that send fails and requeues.
      if (floodWaitSeconds(err) != null) throw err;
      mediaError = err.errorMessage || err.message;
      console.warn(`[publishing] Telegram refused the media (${mediaError}); posting the text only`);
    }
  }
  const message = await withTimeout(
    client.sendMessage(peer, { message: text, parseMode, linkPreview: false, silent }),
    REQUEST_TIMEOUT_MS,
    'sendMessage'
  );
  return { messageId: message.id, mediaCount: 0, mediaError };
}
