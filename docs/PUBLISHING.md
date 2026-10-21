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
  written in **one** LLM call. `DRAFT_LLM_PROVIDER` picks the model
  (`groq`, `openrouter`, or `ollama` for a free local model); with
  `TRANSLATION_PROVIDER=telegram`, your whole Groq budget is left for drafting.

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
- A Telegram flood-wait pauses the bot for the **full** time Telegram asks;
  the post is requeued, not lost.
- Automatic posts about news older than `PUBLISH_MAX_AGE_MINUTES` (120)
  expire instead of going out late. Posts you approve yourself always go.
- Posts are plain text by default (`parseMode: "none"`), so stray `*` or `_`
  can't break formatting; set `"parseMode": "html"` per channel if your
  posting prompt uses HTML tags.
- The bot's login session and the channel's resolved id are stored in the
  database, so restarts don't repeat the login or username lookups.
