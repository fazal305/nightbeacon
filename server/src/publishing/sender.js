import { pool } from '../db/pool.js';
import { RateGate } from '../pipeline/rateGate.js';
import { floodWaitSeconds, isTelegramAnswer } from '../ingestion/telegramClient.js';
import { publishConfig, channelByKey, tzOf } from './config.js';
import { sendToChannel, resetBotClient } from './botClient.js';
import { loadItemMedia, loadBestMedia } from './media.js';
import { applyBanners, isHeadlinePost } from './banners.js';
import { localHour } from './pace.js';
import { applyWatermark } from './watermark.js';
import { findRepeat } from './sameNews.js';
import { hideEmoji } from './prompt.js';
import { limitsFor, refreshPaces } from './pace.js';

// Sends approved posts for "bot" channels, strictly one at a time and never
// faster than PUBLISH_MIN_INTERVAL_SECONDS apart (Telegram's anti-spam
// limits for bots posting to channels). A flood-wait pauses sending for its
// full duration. Automatic posts about news older than PUBLISH_MAX_AGE_MINUTES
// expire instead of going out late; posts the operator approved are always sent.
//
// Automatic posts also respect each channel's maxPerHour and minGapMinutes,
// counted over everything published there — so however many drafts pile
// up (e.g. a backlog drafted at once after an LLM outage), the channel
// gets at most maxPerHour posts an hour, spread out: posts the operator
// approved first, then automatic ones by best score; automatic ones expire
// at PUBLISH_MAX_AGE_MINUTES. Only "Post now" and scheduled summaries go
// past the limit.
const MAX_ATTEMPTS = 3;
let gate = null;

export const publishingStats = { lastSentAt: null, lastError: null, pausedUntil: null };

// The bot can't post in a channel yet (not admin, no "Post messages" right):
// that channel's posts wait — no attempts spent — and it is retried every
// HOLD_MS, so posting starts by itself once the owner makes the bot admin.
// Waiting automatic posts still expire when the news gets old.
const HOLD_MS = 15 * 60_000;
const NO_RIGHTS_RE = /CHAT_ADMIN_REQUIRED|CHAT_WRITE_FORBIDDEN|CHANNEL_PRIVATE|USER_NOT_PARTICIPANT|RIGHT_FORBIDDEN|CHAT_SEND_\w+_FORBIDDEN|USER_BANNED_IN_CHANNEL/;
const channelHolds = new Map(); // channel key -> until (ms)

export function isNoRightsError(err) {
  return NO_RIGHTS_RE.test(err?.errorMessage || err?.message || '');
}

export function _resetChannelHolds() {
  channelHolds.clear();
}

export function publishGate(config = publishConfig()) {
  if (!gate) gate = new RateGate(config.minIntervalSeconds * 1000);
  return gate;
}

async function expireStale(config) {
  await pool.query(
    `UPDATE publications p SET status = 'expired', last_error = 'news too old by the time it was approved', updated_at = now()
     FROM raw_items ri
     WHERE p.raw_item_id = ri.id AND p.status = 'approved' AND p.origin = 'auto'
       AND ri.telegram_date < now() - make_interval(mins => $1)`,
    [config.maxAgeMinutes]
  );
  await pool.query(
    `UPDATE publications SET status = 'expired', last_error = 'summary too old by the time it was approved', updated_at = now()
     WHERE kind = 'digest' AND status = 'approved' AND origin = 'auto'
       AND digest_slot < now() - make_interval(mins => $1)`,
    [config.maxAgeMinutes]
  );
}

// Photos/videos for the post (channel option "media", default on). Any
// problem fetching them means a text-only post, never a lost one; `note`
// records why, for the Publishing page.
async function sourceMedia(pub, channel, loadMedia, config) {
  if (channel.media === false || !pub.raw_item_id) return { media: [], note: null };
  try {
    const best = await loadBestMedia(pub.raw_item_id, { officialUsernames: [...config.officialSources.keys()], loadMedia });
    if (best.error) {
      console.warn(`[publishing] media for item ${pub.raw_item_id} not used: ${best.error} — posting text only`);
      return { media: [], note: `Posted as text only: couldn't get the media (${best.error})` };
    }
    // Which channel the copy being posted came from (for the watermark).
    const { rows } = await pool.query(
      `SELECT s.channel_username FROM raw_items ri JOIN sources s ON s.id = ri.source_id WHERE ri.id = $1`,
      [best.rawItemId]
    );
    return { media: best.media, note: null, from: rows[0]?.channel_username || null };
  } catch (err) {
    console.warn(`[publishing] could not fetch media for item ${pub.raw_item_id}: ${err.message} — posting text only`);
    return { media: [], note: `Posted as text only: couldn't get the media (${err.message})` };
  }
}

// Fewer buzzing phones, fewer mutes and leaves: with "notify": "breaking"
// only headline posts (BREAKING / URGENT / 🔴 …), summaries and posts you
// send with Post now make a sound; the rest arrive silently. "quietHours"
// ("01:00-08:00", local time) makes everything silent at night.
export function isSilent(pub, channel, config, now = new Date()) {
  if (channel.quietHours) {
    const [from, to] = channel.quietHours.split('-').map((t) => Number(t.split(':')[0]));
    const h = localHour(now, tzOf(channel, config));
    if (from <= to ? h >= from && h < to : h >= from || h < to) return true;
  }
  if (channel.notify !== 'breaking') return false;
  if (pub.kind === 'digest' || pub.post_now) return false;
  return !isHeadlinePost(pub.final_text);
}

// The source's media, with the channel's own banners where they apply
// (banners.js). A banner problem never stops the post.
async function mediaFor(pub, channel, loadMedia, config) {
  const found = await sourceMedia(pub, channel, loadMedia, config);
  if (channel.media === false || !channel.banners) return found;
  try {
    const official = pub.source_username ? config.officialSources.has(String(pub.source_username).toLowerCase()) : false;
    const b = await applyBanners({
      channel, media: found.media, text: pub.final_text, official, digest: pub.kind === 'digest', storyId: pub.story_id,
    });
    if (b.note) console.log(`[publishing] ${b.note}`);
    const from = found.from ? String(found.from).toLowerCase() : null;
    const media = await applyWatermark(channel, b.media, { source: from, official: from ? config.officialSources.has(from) : false });
    return { media, note: b.note || found.note };
  } catch (err) {
    console.warn(`[publishing] banner check failed: ${err.message}`);
    return found;
  }
}

// `send` and `loadMedia` are injectable for tests.
export async function runPublishingTick({ send = sendToChannel, loadMedia = loadItemMedia } = {}) {
  const config = publishConfig();
  // Not configured yet: approved posts simply wait (the Publishing page says why).
  const botKeys = config.channels
    .filter((c) => c.delivery === 'bot' && !((channelHolds.get(c.key) || 0) > Date.now()))
    .map((c) => c.key);
  if (!config.botToken || botKeys.length === 0) return [];
  const g = publishGate(config);
  if (g.isPaused()) return [];
  await expireStale(config);
  await refreshPaces(config);

  // Channels with room for an automatic post right now.
  const { rows: recent } = await pool.query(
    `SELECT channel_key, count(*)::int AS n, max(published_at) AS last_at FROM publications
     WHERE status = 'published' AND channel_key = ANY($1) AND published_at > now() - interval '1 hour'
     GROUP BY channel_key`,
    [botKeys]
  );
  const autoKeys = botKeys.filter((key) => {
    const ch = channelByKey(config, key);
    const r = recent.find((x) => x.channel_key === key);
    if (!r) return true;
    const { maxPerHour, minGapMinutes } = limitsFor(ch, config);
    return r.n < maxPerHour && Date.now() - new Date(r.last_at).getTime() >= minGapMinutes * 60_000;
  });

  const { rows: waiting } = await pool.query(
    `SELECT 1 FROM publications WHERE status = 'approved' AND channel_key = ANY($1)
       AND (post_now OR kind = 'digest' OR channel_key = ANY($2)) LIMIT 1`,
    [botKeys, autoKeys]
  );
  if (waiting.length === 0) return [];

  // One gate for the bot across all its channels: the limit is per bot.
  await g.wait();
  const { rows } = await pool.query(
    `UPDATE publications SET status = 'sending', updated_at = now()
     WHERE id = (SELECT id FROM publications WHERE status = 'approved' AND channel_key = ANY($1)
                   AND (post_now OR kind = 'digest' OR channel_key = ANY($2))
                 ORDER BY (post_now OR kind = 'digest') DESC, (origin = 'manual') DESC, score DESC NULLS LAST, approved_at, id
                 LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING id, raw_item_id, final_text, channel_key, kind, story_id, post_now, origin,
               (SELECT s.channel_username FROM raw_items ri JOIN sources s ON s.id = ri.source_id WHERE ri.id = publications.raw_item_id) AS source_username`,
    [botKeys, autoKeys]
  );
  const pub = rows[0];
  if (!pub) return [];

  const channel = channelByKey(config, pub.channel_key);
  if (!channel) {
    await pool.query(
      `UPDATE publications SET status = 'failed', last_error = 'channel is no longer configured', updated_at = now() WHERE id = $1`,
      [pub.id]
    );
    return [{ id: pub.id, outcome: 'failed', error: 'channel is no longer configured' }];
  }

  // Last duplicate check: the same news may have gone out on this channel
  // (or another in its exclusiveGroup) since the post was queued.
  if (pub.kind === 'post' && !pub.post_now && pub.origin === 'auto') {
    const same = await findRepeat(pub.final_text, config, channel, { exceptId: pub.id }).catch(() => null);
    if (same) {
      await pool.query(`UPDATE publications SET status = 'rejected', last_error = $2, updated_at = now() WHERE id = $1`, [
        pub.id,
        `same news as post #${same.id} on ${same.channel_key}`,
      ]);
      console.log(`[publishing] not posting #${pub.id}: same news as #${same.id} on ${same.channel_key}`);
      return [{ id: pub.id, outcome: 'duplicate' }];
    }
  }

  try {
    const { media, note } = await mediaFor(pub, channel, loadMedia, config);
    const silent = isSilent(pub, channel, config);
    const sent = await send(hideEmoji(pub.final_text, channel.hideEmoji), channel, config, media, { silent });
    const mediaCount = sent.mediaCount ?? media.length;
    const mediaNote = sent.mediaError ? `Posted as text only: Telegram refused the media (${sent.mediaError})` : note;
    await pool.query(
      `UPDATE publications SET status = 'published', telegram_message_id = $2, published_at = now(),
                               media_count = $3, media_note = $4, last_error = NULL, updated_at = now()
       WHERE id = $1`,
      [pub.id, sent.messageId, mediaCount, mediaNote]
    );
    console.log(`[publishing] posted to ${channel.telegram}${mediaCount ? ` with ${mediaCount} photo/video(s)` : ' (text only)'}`);
    publishingStats.lastSentAt = new Date().toISOString();
    publishingStats.lastError = null;
    return [{ id: pub.id, outcome: 'published' }];
  } catch (err) {
    publishingStats.lastError = err.message;
    const flood = floodWaitSeconds(err);
    if (flood) {
      g.pauseFor(flood * 1000);
      publishingStats.pausedUntil = new Date(Date.now() + flood * 1000).toISOString();
    }
    // Flood-waits and "no answer" (proxy/bot connection down) aren't the
    // post's fault: requeue without spending an attempt.
    const noRights = isNoRightsError(err);
    if (noRights) {
      channelHolds.set(channel.key, Date.now() + HOLD_MS);
      console.warn(`[publishing] the bot can't post in ${channel.telegram} (${err.errorMessage || err.message}) — make it an admin with "Post messages"; retrying in 15 min`);
    }
    const systemic = noRights || flood != null || !isTelegramAnswer(err);
    if (!flood && !noRights && systemic) resetBotClient();
    await pool.query(
      systemic
        ? `UPDATE publications SET status = 'approved', last_error = $2, updated_at = now() WHERE id = $1`
        : `UPDATE publications SET attempts = attempts + 1, last_error = $2, updated_at = now(),
                  status = CASE WHEN attempts + 1 >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'approved' END
           WHERE id = $1`,
      [pub.id, err.message]
    );
    return [{ id: pub.id, outcome: 'failed', error: err.message, systemic }];
  }
}
