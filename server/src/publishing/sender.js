import { pool } from '../db/pool.js';
import { RateGate } from '../pipeline/rateGate.js';
import { floodWaitSeconds, isTelegramAnswer } from '../ingestion/telegramClient.js';
import { publishConfig, channelByKey } from './config.js';
import { sendToChannel, resetBotClient } from './botClient.js';

// Sends approved posts for "bot" channels, strictly one at a time and never
// faster than PUBLISH_MIN_INTERVAL_SECONDS apart (Telegram's anti-spam
// limits for bots posting to channels). A flood-wait pauses sending for its
// full duration. Automatic posts about news older than PUBLISH_MAX_AGE_MINUTES
// expire instead of going out late; posts the operator approved are always sent.
//
// Automatic posts also respect each channel's maxPerHour and minGapMinutes,
// counted over everything published there — so however many drafts pile
// up (e.g. a backlog drafted at once after an LLM outage), the channel
// gets at most maxPerHour automatic posts an hour, spread out, best score
// first; the rest expire at PUBLISH_MAX_AGE_MINUTES. Posts the operator
// approved go out regardless.
const MAX_ATTEMPTS = 3;
let gate = null;

export const publishingStats = { lastSentAt: null, lastError: null, pausedUntil: null };

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
}

// `send` is injectable for tests.
export async function runPublishingTick({ send = sendToChannel } = {}) {
  const config = publishConfig();
  // Not configured yet: approved posts simply wait (the Publishing page says why).
  const botKeys = config.channels.filter((c) => c.delivery === 'bot').map((c) => c.key);
  if (!config.botToken || botKeys.length === 0) return [];
  const g = publishGate(config);
  if (g.isPaused()) return [];
  await expireStale(config);

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
    return r.n < ch.maxPerHour && Date.now() - new Date(r.last_at).getTime() >= ch.minGapMinutes * 60_000;
  });

  const { rows: waiting } = await pool.query(
    `SELECT 1 FROM publications WHERE status = 'approved' AND channel_key = ANY($1)
       AND (origin = 'manual' OR channel_key = ANY($2)) LIMIT 1`,
    [botKeys, autoKeys]
  );
  if (waiting.length === 0) return [];

  // One gate for the bot across all its channels: the limit is per bot.
  await g.wait();
  const { rows } = await pool.query(
    `UPDATE publications SET status = 'sending', updated_at = now()
     WHERE id = (SELECT id FROM publications WHERE status = 'approved' AND channel_key = ANY($1)
                   AND (origin = 'manual' OR channel_key = ANY($2))
                 ORDER BY (origin = 'manual') DESC, score DESC NULLS LAST, approved_at, id
                 LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING id, final_text, channel_key`,
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

  try {
    const { messageId } = await send(pub.final_text, channel, config);
    await pool.query(
      `UPDATE publications SET status = 'published', telegram_message_id = $2, published_at = now(),
                               last_error = NULL, updated_at = now()
       WHERE id = $1`,
      [pub.id, messageId]
    );
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
    const systemic = flood != null || !isTelegramAnswer(err);
    if (!flood && systemic) resetBotClient();
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
