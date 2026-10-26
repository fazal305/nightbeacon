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
//   styleExamples    how many recent channel posts to show the model (default 4)
//   maxPerHour       automatic drafts per hour for this channel (default
//                    PUBLISH_MAX_PER_HOUR, 6); each slot goes to the
//                    best-scoring story (see drafter.js)
//   minGapMinutes    at least this long between automatic drafts (default
//                    half of 60/maxPerHour, so 5 min at 6/hour)
//   settleMinutes    a story waits this long before it can be picked, so
//                    corroboration shows (default PUBLISH_SETTLE_MINUTES, 3)
//   sourceCredit     "none" | "channel"
//   parseMode        "none" | "html" | "markdown" (bot channels)
//   digest           scheduled summary posts, e.g.
//                    { "times": ["09:00", "21:00"], "maxStories": 10 }
//                    (local times in PUBLISH_TIMEZONE, default Asia/Karachi)
//   media            false to post text only (default: the source's
//                    photos/videos are posted with the text)
//   banners          the channel's own banner images, e.g.
//                    { "dir": "banners/main", "textPosts": true, "digest": true }
//                    (see banners.js): a source photo that is just a generic
//                    "breaking news / live" card is swapped for the matching
//                    banner; textPosts adds one to headline-style posts that
//                    have no media; digest adds the summary banner
//                    "watermark": true also puts the channel's logo
//                    (watermark.png in that folder) on reposted photos and
//                    videos, in their emptiest corner (watermark.js)
//   exclusiveGroup   channels sharing a group name never post the same story
//                    (e.g. "bots"): a story one of them used is not picked
//                    for the others, and a finished post is checked against
//                    what they all posted recently (sameNews.js)
//   pace             "stats": the channel's own views by hour of posting
//                    decide how many posts each hour gets — postsPerHour on
//                    average over the day, more at hours its posts are seen,
//                    fewer at hours they aren't, never above maxPerHour (pace.js)
//   postsPerHour     average posts per hour for "pace": "stats" (default
//                    maxPerHour)
//   surge            { "maxPerHour": 6 }: in big-event mode (surge.js — a
//                    burst of high-priority news, or switched on from the
//                    Publishing page) the channel may post that many an hour
//   trustSources     ["@username", "Display Name", …]: reports from these
//                    sources score 1.5× for this channel. "@name" matches the
//                    username exactly; other entries match any source whose
//                    display name contains them (any case)
//   blockSources     same format: reports from these sources are never
//                    drafted for this channel
//   timeZone         this channel's time zone for summary times, quiet hours
//                    and its hourly pace (default PUBLISH_TIMEZONE)
//   paceLike         a monitored channel's @username: its posts per hour of
//                    the day (last 14 days) become this channel's hourly
//                    limits, with maxPerHour as the ceiling (pace.js)
//   notify           "breaking": only headline posts (BREAKING, URGENT, 🔴…),
//                    summaries and Post now ring subscribers' phones; the
//                    rest are delivered silently (default "all")
//   quietHours       e.g. "01:00-08:00" (local time): every post is silent then
//   enabled          false to pause a channel
// Without a channels file, PUBLISH_CHANNEL (+ TELEGRAM_BOT_TOKEN) defines a
// single bot channel, so the simple setup needs no file at all.

// ["@user", "Some Name"] -> { usernames: ['user'], names: ['%some name%'] }
// (for SQL = ANY / LIKE ANY).
export function sourceList(entries) {
  const out = { usernames: [], names: [] };
  for (const e of Array.isArray(entries) ? entries : []) {
    const v = String(e || '').trim().toLowerCase();
    if (!v) continue;
    if (v.startsWith('@')) out.usernames.push(v.slice(1));
    else out.names.push(`%${v.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
  }
  return out;
}

function validTimeZone(tz, key) {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return tz;
  } catch {
    throw new Error(`publish channel "${key}": unknown timeZone "${tz}" (use e.g. "Europe/London")`);
  }
}

// A channel's own time zone, or the global one.
export const tzOf = (channel, config) => channel?.timeZone || config.timeZone;

function list(value, fallback) {
  const raw = value ?? fallback;
  return (Array.isArray(raw) ? raw : String(raw).split(','))
    .map((s) => String(s).trim().toLowerCase())
    .filter(Boolean);
}

let fileCache = { path: null, mtimeMs: 0, channels: null };

// Every free drafting provider, best first. Ones without a key are skipped
// instantly, so the list can name them all.
const DEFAULT_DRAFT_PROVIDERS =
  'groq,gemini,cerebras,mistral,github,nvidia,sambanova,cohere,openrouter,cloudflare,huggingface,pollinations';

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

// "term => replacement" lines; # comments and blank lines ignored.
export function parseTerminology(text) {
  const rules = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:-\s*)?([^#].*?)\s*=>\s*(.+?)\s*$/);
    if (m) rules.push({ term: m[1], replacement: m[2] });
  }
  return rules;
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

function normalizeDigest(digest, key) {
  if (!digest) return null;
  const times = (Array.isArray(digest.times) ? digest.times : [digest.times]).map((t) => String(t).trim());
  for (const t of times) {
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(t)) throw new Error(`publish channel "${key}": digest time "${t}" must be HH:MM`);
  }
  if (times.length === 0) return null;
  return { times: times.map((t) => t.padStart(5, '0')), maxStories: Number(digest.maxStories || 10) };
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
      styleExamples: Number(c.styleExamples ?? 4),
      maxPerHour: Number(c.maxPerHour ?? defaults.maxPerHour),
      minGapMinutes: Number(c.minGapMinutes ?? 30 / Math.max(Number(c.maxPerHour ?? defaults.maxPerHour), 1)),
      settleMinutes: Number(c.settleMinutes ?? defaults.settleMinutes),
      sourceCredit: (c.sourceCredit || defaults.sourceCredit).toLowerCase(),
      parseMode: (c.parseMode || defaults.parseMode).toLowerCase(),
      media: c.media !== false,
      digest: normalizeDigest(c.digest, key),
      // Channels with the same exclusiveGroup never post the same story.
      exclusiveGroup: c.exclusiveGroup ? String(c.exclusiveGroup) : null,
      // Hourly limits from the channel's own views by hour (pace.js).
      pace: c.pace === 'stats' ? 'stats' : null,
      trustSources: sourceList(c.trustSources),
      blockSources: sourceList(c.blockSources),
      timeZone: c.timeZone ? validTimeZone(String(c.timeZone), key) : null,
      surgeMaxPerHour: c.surge?.maxPerHour ? Number(c.surge.maxPerHour) : null,
      postsPerHour: Number(c.postsPerHour ?? c.maxPerHour ?? defaults.maxPerHour),
      // Copy another channel's hourly posting pattern (pace.js).
      paceLike: c.paceLike ? String(c.paceLike).replace(/^@/, '') : null,
      // "breaking": only headline posts notify subscribers (sender.js isSilent).
      notify: c.notify === 'breaking' ? 'breaking' : 'all',
      quietHours: /^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(c.quietHours || '') ? c.quietHours : null,
      banners: c.banners?.dir
        ? {
            dir: c.banners.dir,
            replace: c.banners.replace !== false,
            textPosts: Boolean(c.banners.textPosts),
            digest: c.banners.digest !== false,
            watermark: Boolean(c.banners.watermark),
          }
        : null,
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
    maxPerHour: Number(env.PUBLISH_MAX_PER_HOUR || 6),
    settleMinutes: Number(env.PUBLISH_SETTLE_MINUTES ?? 3),
  };

  const file = path.resolve(env.PUBLISH_CHANNELS_FILE || 'publish-channels.json');
  let rawChannels;
  if (fs.existsSync(file)) {
    rawChannels = readChannelsFile(file)
      .map((c) =>
        c.styleGuideFile
          ? { ...c, styleGuide: [c.styleGuide, readGuideFile(file, c.styleGuideFile, c.key)].filter(Boolean).join('\n\n') }
          : c
      )
      .map((c) => (c.banners ? { ...c, banners: { ...c.banners, dir: path.resolve(path.dirname(file), c.banners.dir || `banners/${c.key}`) } } : c));
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

  // Shared terminology for every channel: PUBLISH_TERMINOLOGY_FILE, or
  // terminology.md next to the channels file.
  const termFile = env.PUBLISH_TERMINOLOGY_FILE
    ? path.resolve(env.PUBLISH_TERMINOLOGY_FILE)
    : fs.existsSync(file)
      ? path.join(path.dirname(file), 'terminology.md')
      : null;
  const terminology = termFile && fs.existsSync(termFile) ? parseTerminology(readGuideFile(termFile, termFile, 'terminology')) : [];

  // Official channels: "@username => Organisation" lines.
  const officialFile = env.PUBLISH_OFFICIAL_SOURCES_FILE
    ? path.resolve(env.PUBLISH_OFFICIAL_SOURCES_FILE)
    : fs.existsSync(file)
      ? path.join(path.dirname(file), 'official-sources.md')
      : null;
  const officialSources = new Map(
    (officialFile && fs.existsSync(officialFile) ? parseTerminology(readGuideFile(officialFile, officialFile, 'official sources')) : [])
      .map((r) => [r.term.replace(/^@/, '').toLowerCase(), r.replacement])
  );

  // House writing rules for every channel: house-rules.md next to the
  // channels file (plain lines; # comments ignored).
  const rulesFile = env.PUBLISH_HOUSE_RULES_FILE
    ? path.resolve(env.PUBLISH_HOUSE_RULES_FILE)
    : fs.existsSync(file)
      ? path.join(path.dirname(file), 'house-rules.md')
      : null;
  const houseRules = (rulesFile && fs.existsSync(rulesFile) ? readGuideFile(rulesFile, rulesFile, 'house rules') : '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  return {
    terminology,
    officialSources,
    houseRules,
    // Emoji never used on any channel, e.g. a flag (removed from every draft).
    bannedEmoji: (env.PUBLISH_BANNED_EMOJI || '').split(/[\s,]+/).filter(Boolean),
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
    // Automatic drafts for manual channels that nobody copied within this
    // many hours expire (the news is stale by then). 0 = keep them.
    manualDraftMaxHours: Number(env.MANUAL_DRAFT_MAX_HOURS ?? 6),
    draftProvider: (env.DRAFT_LLM_PROVIDER || env.LLM_PROVIDER || DEFAULT_DRAFT_PROVIDERS).toLowerCase(),
    // One model id or a comma-separated list (each Groq model has its own
    // daily allowance); empty = the provider's usual model env (GROQ_MODEL…).
    draftModel: (env.DRAFT_LLM_MODEL || '').trim(),
    draftMaxPerMinute: Number(env.DRAFT_MAX_PER_MINUTE || 10),
    // Local time zone for digest times.
    timeZone: env.PUBLISH_TIMEZONE || 'Asia/Karachi',
  };
}

export function channelByKey(config, key) {
  return config.channels.find((c) => c.key === key) || null;
}
