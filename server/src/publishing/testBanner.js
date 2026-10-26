// Posts one message with a banner to a bot channel, to see how it looks.
//   npm run publish:test-banner                          breaking banner, first bot channel with banners
//   npm run publish:test-banner -- --banner urgent --text "⚡ URGENT | ..."
//   npm run publish:test-banner -- --channel <key>
import 'dotenv/config';
import { publishConfig } from './config.js';
import { sendToChannel } from './botClient.js';
import { applyBanners, bannerFile } from './banners.js';
import fs from 'node:fs';
import path from 'node:path';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};

try {
  const config = publishConfig();
  const key = arg('channel', null);
  const channel = config.channels.find((c) => (key ? c.key === key : c.delivery === 'bot' && c.banners));
  if (!channel) throw new Error(key ? `no channel "${key}" in channels.json` : 'no bot channel with "banners" in channels.json');
  if (!channel.banners) throw new Error(`channel "${channel.key}" has no "banners" setting`);
  const banner = arg('banner', null);
  const text = arg('text', '🔴 BREAKING NEWS\nThis is a test post for the channel\'s banners.');
  let media;
  if (banner) {
    const file = bannerFile(channel, `${banner.replace(/\.jpg$/, '')}.jpg`);
    if (!file) throw new Error(`banner "${banner}" not found in ${channel.banners.dir}`);
    media = [{ kind: 'photo', mime: 'image/jpeg', name: path.basename(file), size: fs.statSync(file).size, file }];
  } else {
    ({ media } = await applyBanners({ channel, media: [], text: text, storyId: null }));
    if (media.length === 0) throw new Error('the text is not a headline post, so no banner applies — add --banner breaking');
  }
  console.log(`Posting to ${channel.telegram} with ${path.basename(media[0].file)} …`);
  const sent = await sendToChannel(text, channel, config, media);
  if (sent.mediaError) console.log(`Posted, but Telegram refused the picture: ${sent.mediaError}`);
  else console.log(`Done — message ${sent.messageId}. Delete it in Telegram when you have seen it.`);
} catch (err) {
  console.error(`Failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  setTimeout(() => process.exit(), 500);
}
