# Publishing to your channels

After a story is deduplicated, translated and classified, Nightbeacon can
write posts about it **in each of your channels' own style**, and:

- for the **one channel your bot is admin of** (`delivery: "bot"`): post it
  after you approve it — or automatically for high priority in `auto` mode;
- for your **other channels** (`delivery: "manual"`): give you a ready draft
  with a **Copy** button; you paste it into Telegram when you get a chance
  and click **Mark as sent**.

Everything happens on the **Publishing** page, and per post in the Content
Inspector ("Drafts for my channels").

## Why GramJS and not Telegraf / node-telegram-bot-api

Those libraries use the HTTPS Bot API at `api.telegram.org`, which is blocked
wherever Telegram is blocked, and MTProxies can't carry HTTPS. The bot here
logs in with your BotFather token over **MTProto** (GramJS, already used for
ingestion), so it goes through the same proxy list, Fake-TLS transport and
failover. No new dependency. Pacing uses the existing `RateGate`
(concurrency 1, fixed interval) — the same thing p-queue would give.

## Setup

1. **Create the bot**: BotFather → `/newbot` → copy the token. Add the bot to
   your bot channel as an **admin with "Post messages"** permission.
2. **`server/.env`**:
   ```bash
   TELEGRAM_BOT_TOKEN=123456:ABC...
   PUBLISH_MODE=review          # off | review | auto (see below)
   ```
3. **Your channels** — copy `server/publish-channels.example.json` to
   `server/publish-channels.json` (gitignored) and edit:
   ```json
   [
     { "key": "main",   "name": "Main",   "telegram": "@my_main",   "delivery": "bot",
       "draftPriorities": ["high", "medium"], "autoPriorities": ["high"],
       "styleGuide": "your posting prompt for this channel" },
     { "key": "alerts", "name": "Alerts", "telegram": "@my_alerts", "delivery": "manual",
       "draftPriorities": ["high"], "styleGuide": "your posting prompt" }
   ]
   ```
   For long posting prompts use `"styleGuideFile": "publish-guides/main.md"`
   instead of `styleGuide` (path relative to the channels file).
   Both files are re-read when they change; no restart needed. With only one
   channel you can skip the file and set `PUBLISH_CHANNEL=@my_main` instead.

## Nothing is being posted?

```bash
npm run publish:check              # explains each step; posts nothing
npm run publish:check -- --send-test   # also sends one test post via the bot
```

It checks, in order: the channels file and `PUBLISH_MODE` (in `review` the
bot only posts what you approve), whether fresh high/medium stories are fully
processed, the drafts and their last errors, the bot login, and whether the
bot is an admin of the bot channel with "Post messages".

## Photos and videos

When the source post has photos, videos or GIFs (a whole album included),
the bot posts them with the text as the caption. A bot can't read other
channels, so your monitoring session downloads the files and the bot
uploads them again; they're cached for a day (`PUBLISH_MEDIA_CACHE_DIR`).
Captions are limited to 1024 characters — drafts for posts with media are
asked to stay under 1000, and a longer text follows the media as its own
message. Files over `PUBLISH_MEDIA_MAX_MB` (50) are left out, and if the
media can't be fetched or Telegram refuses it, the post goes out as text.
Set `"media": false` on a channel for text only.

**Cleanest copy**: when several channels carried the story, the media is
taken from the organisation's official channel first, then from whichever
channel posted it earliest — the original usually doesn't carry a
reposter's logo. Watermarks are never removed.

On manual channels, **Show photos/videos** on a draft previews them with
download links, to attach when you post.

## House terminology

`server/channels/terminology.md` (or `PUBLISH_TERMINOLOGY_FILE`) lists names
used in every post on every channel, one `term => replacement` per line —
e.g. `IDF => IOF`, `Houthis => Ansarallah`. The model is told to use them, and
the swaps are also applied to each draft's text (whole words, any
capitalisation, longest term first), so they hold even when the model copies
the source's wording. Edits apply to the next draft; no restart needed.

## Official statements

`server/channels/official-sources.md` lists the official channels of
organisations (`@username => Hezbollah`, one per line; find usernames with
`npm run sources:list -- <name>`), or fill it from a Telegram folder of
official channels with `npm run sources:official -- https://t.me/addlist/<slug>`,
which also adds any of them not yet monitored and guesses each channel's
organisation from its title (check and correct the names). A statement by a listed organisation is
posted only when it comes from that organisation's own channel; the same
statement relayed by any other channel is skipped (`SKIP`). Ordinary news
from other channels is unaffected. Reports from official channels score
double in story selection, since a statement appears once, on one channel.

Statements from official channels are posted **word for word** — only
translated: the model may add the channel's header and footer but must use
the translation unchanged, house terminology is not applied inside it, and
links/@handles are left out. If the draft's wording differs from the
translation (links, handles, emoji, punctuation and case aside), it is not
posted automatically; it waits for review with a note.

## How drafts are written

- **Style**: each channel's `styleGuide` (your posting prompt) plus its most
  recent posts as examples (`styleExamples`, default 6). Examples are read
  with your monitoring account — it must be able to see the channel — and
  cached for a day.
- **Facts**: the model may only use facts in the report, must keep every
  figure, and must keep unconfirmed claims attributed. Ads, channel promos
  and fragments get `SKIP` (shown as rejected).
- **Updates**: a report dedup marked as an *update* (new figures) is drafted
  with the new information as the lead.
- **Cost**: when a post needs drafts for several channels, all of them are
  written in **one** LLM call. `DRAFT_LLM_PROVIDER` picks the provider
  (`groq`, `openrouter`, or `ollama` for a free local model) and
  `DRAFT_LLM_MODEL` the model(s). Groq's free daily limit is counted **per
  model**, so list several: when one hits its daily limit it's set aside for
  an hour and the next is used; unknown model ids are skipped. Keep
  translation off Groq (`TRANSLATION_PROVIDER=telegram,google,lingva`) so the
  whole budget goes to drafting.
- **Which stories**: each channel gets at most `PUBLISH_MAX_PER_HOUR` (6)
  automatic drafts an hour (`maxPerHour`), spread at least `minGapMinutes`
  apart (default: 5 min at 6/hour). Each slot goes to the best-scoring
  candidate:

  `score = priority (high 10, medium 4) × (1 + log2 channels reporting it) × 1.3 if an update × ½ per hour of age`

  So a story many of your sources carry beats one only a single channel
  posted, and fresh beats old. A story waits `PUBLISH_SETTLE_MINUTES` (3)
  before it can be picked, unless 3+ channels already report it, so
  corroboration has time to show. A story drafted for a channel isn't picked
  again for 6 hours; an update with new figures can be, 30+ minutes later.
  The score and its breakdown are shown on each draft. Automatic drafts that
  waited longer than `PUBLISH_MAX_AGE_MINUTES` are expired, not drafted.

## Modes

| `PUBLISH_MODE` | Automatic drafts | Bot posts |
|---|---|---|
| `off` (default) | none — only when you click "Draft for my channels" | after you approve |
| `review` | fresh stories at each channel's `draftPriorities` | after you approve |
| `auto` | same | `autoPriorities` posts are approved automatically |

Manual channels are never posted by the bot, in any mode.

## Not getting banned

- The bot sends **one post at a time, at least `PUBLISH_MIN_INTERVAL_SECONDS`
  (35) apart**, across all bot channels.
- **Automatic** posts are also held to each channel's `maxPerHour` and
  `minGapMinutes` **at send time**, counting everything published there, so a
  pile of approved drafts can never burst out; the best-scoring go first and
  the rest expire. Posts you approve yourself go out regardless.
- A Telegram flood-wait pauses the bot for the **full** time Telegram asks;
  the post is requeued, not lost.
- Automatic posts about news older than `PUBLISH_MAX_AGE_MINUTES` (120)
  expire instead of going out late. Posts you approve yourself always go.
- Posts are plain text by default (`parseMode: "none"`), so stray `*` or `_`
  can't break formatting; set `"parseMode": "html"` per channel if your
  posting prompt uses HTML tags.
- The bot's login session and the channel's resolved id are stored in the
  database, so restarts don't repeat the login or username lookups.
