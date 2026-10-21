import fs from 'node:fs';
import path from 'node:path';

// Publishing settings. Global ones come from server/.env; the channels you
// post to come from PUBLISH_CHANNELS_FILE (default server/publish-channels.json,
// gitignored — copy publish-channels.example.json). See docs/PUBLISHING.md.
//
// Each channel:
//   key              short id, e.g. "main"            (required, a-z 0-9 _ -)
//   name             label shown in the dashboard
//   telegram         @username — style examples are read from it, and for
//                    delivery "bot" it's where the bot posts
//   delivery         "bot"    — the bot posts approved drafts (bot must be admin)
//                    "manual" — you copy the draft and post it yourself
//   draftPriorities  priorities drafted automatically (PUBLISH_MODE review/auto)
//   autoPriorities   bot channels only, PUBLISH_MODE=auto: posted without review
//   styleGuide       your posting prompt for this channel
//   styleGuideFile   …or a text file with it (path relative to the channels
//                    file), easier for long prompts; re-read when it changes
//   styleExamples    how many recent channel posts to show the model (default 6)
//   sourceCredit     "none" | "channel"
//   parseMode        "none" | "html" | "markdown" (bot channels)
//   enabled          false to pause a channel
// Without a channels file, PUBLISH_CHANNEL (+ TELEGRAM_BOT_TOKEN) defines a
// single bot channel, so the simple setup needs no file at all.

function list(value, fallback) {
  const raw = value ?? fallback;
  return (Array.isArray(raw) ? raw : String(raw).split(','))
    .map((s) => String(s).trim().toLowerCase())
    .filter(Boolean);
}

let fileCache = { path: null, mtimeMs: 0, channels: null };

const guideCache = new Map(); // path -> { mtimeMs, text }

function readGuideFile(channelsFile, relPath, key) {
  const guidePath = path.resolve(path.dirname(channelsFile), relPath);
  let stat;
  try {
    stat = fs.statSync(guidePath);
  } catch {
    throw new Error(`publish channel "${key}": styleGuideFile not found: ${guidePath}`);
  }
  const cached = guideCache.get(guidePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.text;
  const text = fs.readFileSync(guidePath, 'utf8').trim();
  guideCache.set(guidePath, { mtimeMs: stat.mtimeMs, text });
  return text;
}

function readChannelsFile(file) {
  const stat = fs.statSync(file);
  if (fileCache.path === file && fileCache.mtimeMs === stat.mtimeMs) return fileCache.channels;
  // Windows PowerShell 5.1 / Notepad may save UTF-8 with a BOM, which JSON.parse rejects.
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!Array.isArray(parsed)) throw new Error(`${file} must contain a JSON array of channels`);
  fileCache = { path: file, mtimeMs: stat.mtimeMs, channels: parsed };
  return parsed;
}

export function normalizeChannels(rawChannels, defaults) {
  const seen = new Set();
  return rawChannels.map((c, i) => {
    const key = String(c.key || '').trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,32}$/.test(key)) throw new Error(`publish channel #${i + 1}: "key" must be 1-32 chars of a-z, 0-9, _ or -`);
    if (seen.has(key)) throw new Error(`publish channel key "${key}" is used twice`);
    seen.add(key);
    const delivery = (c.delivery || 'manual').toLowerCase();
    if (!['bot', 'manual'].includes(delivery)) throw new Error(`publish channel "${key}": delivery must be "bot" or "manual"`);
    const telegram = (c.telegram || '').trim();
    if (delivery === 'bot' && !telegram) throw new Error(`publish channel "${key}": a bot channel needs "telegram" (@username)`);
    return {
      key,
      name: c.name || telegram || key,
      telegram,
      delivery,
      enabled: c.enabled !== false,
      draftPriorities: list(c.draftPriorities, defaults.draftPriorities),
      autoPriorities: delivery === 'bot' ? list(c.autoPriorities, defaults.autoPriorities) : [],
      styleGuide: c.styleGuide || '',
      styleExamples: Number(c.styleExamples ?? 6),
      sourceCredit: (c.sourceCredit || defaults.sourceCredit).toLowerCase(),
      parseMode: (c.parseMode || defaults.parseMode).toLowerCase(),
    };
  });
}

export function publishConfig(env = process.env) {
  const mode = (env.PUBLISH_MODE || 'off').toLowerCase();
  if (!['off', 'review', 'auto'].includes(mode)) {
    throw new Error(`PUBLISH_MODE must be off, review or auto (got "${env.PUBLISH_MODE}")`);
  }
  const defaults = {
    draftPriorities: env.PUBLISH_DRAFT_PRIORITIES || 'high,medium',
    autoPriorities: env.PUBLISH_AUTO_PRIORITIES || 'high',
    sourceCredit: env.PUBLISH_SOURCE_CREDIT || 'none',
    parseMode: env.PUBLISH_PARSE_MODE || 'none',
  };

  const file = path.resolve(env.PUBLISH_CHANNELS_FILE || 'publish-channels.json');
  let rawChannels;
  if (fs.existsSync(file)) {
    rawChannels = readChannelsFile(file).map((c) =>
      c.styleGuideFile
        ? { ...c, styleGuide: [c.styleGuide, readGuideFile(file, c.styleGuideFile, c.key)].filter(Boolean).join('\n\n') }
        : c
    );
  } else if (env.PUBLISH_CHANNEL) {
    rawChannels = [
      {
        key: 'main',
        telegram: env.PUBLISH_CHANNEL,
        delivery: 'bot',
        styleGuide: env.PUBLISH_STYLE_GUIDE || '',
        styleExamples: Number(env.PUBLISH_STYLE_EXAMPLES || 8),
      },
    ];
  } else {
    rawChannels = [];
  }

  return {
    // off: only drafts you request from the dashboard; review: also drafts
    // stories automatically, you approve each; auto: bot-channel drafts at
    // autoPriorities are posted without review.
    mode,
    channels: normalizeChannels(rawChannels, defaults).filter((c) => c.enabled),
    channelsFile: fs.existsSync(file) ? file : null,
    botToken: (env.TELEGRAM_BOT_TOKEN || '').trim(),
    // Telegram anti-spam: one bot post per this many seconds, never faster.
    minIntervalSeconds: Number(env.PUBLISH_MIN_INTERVAL_SECONDS || 35),
    // Automatic drafts/posts about news older than this are skipped/expired;
    // posts you approve yourself are always sent.
    maxAgeMinutes: Number(env.PUBLISH_MAX_AGE_MINUTES || 120),
    draftProvider: (env.DRAFT_LLM_PROVIDER || env.LLM_PROVIDER || 'groq').toLowerCase(),
    draftMaxPerMinute: Number(env.DRAFT_MAX_PER_MINUTE || 10),
  };
}

export function channelByKey(config, key) {
  return config.channels.find((c) => c.key === key) || null;
}
