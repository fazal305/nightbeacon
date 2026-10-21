import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pool } from '../db/pool.js';
import { buildDraftMessages, parseDraft, parseMultiDraft, applyTerminology, removeBannedFlags, keepsStatementVerbatim } from './prompt.js';
import { parseTerminology } from './config.js';
import { runDraftingTick } from './drafter.js';
import { runPublishingTick, publishGate } from './sender.js';
import { digestSlots, runDigestTick } from './digest.js';
import { publicationsRouter } from '../routes/publications.js';

// Real Postgres; the LLM and the bot are injected fakes.

let sourceId;
let msg = 1;
const style = async (channel) => ({ guide: `${channel.key} rules`, examples: [`🔴 ${channel.key} example post.`] });
const channelsFile = path.join(os.tmpdir(), `nb-channels-${process.pid}.json`);
function setChannels(channels) {
  fs.writeFileSync(channelsFile, JSON.stringify(channels));
  // mtime resolution can be coarse; bump it so the config cache reloads.
  const t = new Date(Date.now() + Math.floor(Math.random() * 100000));
  fs.utimesSync(channelsFile, t, t);
}
const MAIN = { key: 'main', telegram: '@main', delivery: 'bot', draftPriorities: ['high'], autoPriorities: ['high'] };
const ALERTS = { key: 'alerts', telegram: '@alerts', delivery: 'manual', draftPriorities: ['high'] };
// Fake LLM: answers the multi-channel JSON shape when asked for several channels.
const fakeLLM = (perChannel) => async (messages) => {
  const keys = [...messages[0].content.matchAll(/Channel "([a-z0-9_-]+)"/g)].map((m) => m[1]);
  const content = keys.length > 1 ? JSON.stringify(Object.fromEntries(keys.map((k) => [k, perChannel(k, messages)]))) : perChannel(keys[0], messages);
  return { content, model: 'fake' };
};

async function readyItem({ priority = 'high', minutesAgo = 5, dedup = 'unique', text = 'Missile strike reported near the port, 12 injured.' } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO raw_items (source_id, telegram_message_id, telegram_date, raw_text, status, dedup_status, priority, category, ready_at)
     VALUES ($1, $2, now() - make_interval(mins => $3), $4, 'ready', $5, $6, 'security-incident', now()) RETURNING id`,
    [sourceId, msg++, minutesAgo, text, dedup, priority]
  );
  return rows[0].id;
}
const pubFor = async (itemId, channel = 'main') =>
  (await pool.query('SELECT * FROM publications WHERE raw_item_id = $1 AND channel_key = $2', [itemId, channel])).rows[0];

before(async () => {
  sourceId = (
    await pool.query(`INSERT INTO sources (channel_username, display_name) VALUES ($1, 'Src') RETURNING id`, [`pub_src_${Date.now()}`])
  ).rows[0].id;
});
beforeEach(async () => {
  await pool.query('DELETE FROM publications');
  // Earlier tests' posts are still fresh + ready, so the drafter would rightly pick them up too.
  await pool.query('DELETE FROM raw_items WHERE source_id = $1', [sourceId]);
  await pool.query(`DELETE FROM stories WHERE normalized_text = 'x'`);
  Object.assign(process.env, {
    PUBLISH_MODE: 'review',
    PUBLISH_CHANNELS_FILE: channelsFile,
    TELEGRAM_BOT_TOKEN: 'x:y',
    PUBLISH_MIN_INTERVAL_SECONDS: '0',
    DRAFT_MAX_PER_MINUTE: '6000',
  });
  setChannels([MAIN, ALERTS]);
});
after(async () => {
  await pool.query('DELETE FROM publications');
  await pool.query('DELETE FROM raw_items WHERE source_id = $1', [sourceId]);
  await pool.query('DELETE FROM sources WHERE id = $1', [sourceId]);
  for (const k of ['PUBLISH_MODE', 'PUBLISH_CHANNELS_FILE', 'TELEGRAM_BOT_TOKEN']) delete process.env[k];
  fs.rmSync(channelsFile, { force: true });
  await pool.end();
});

test('prompt: one call covers several channels, each with its own style; facts-only rules; update lead', () => {
  const msgs = buildDraftMessages({
    item: { raw_text: 'نص', translated_text: 'Text', telegram_date: new Date(), dedup_status: 'update', channel_username: 'src', priority: 'high' },
    targets: [
      { channel: { key: 'main', name: 'Main', telegram: '@main', sourceCredit: 'none' }, style: { guide: 'Use 🔴', examples: ['ex A'] } },
      { channel: { key: 'alerts', name: 'Alerts', telegram: '@alerts', sourceCredit: 'channel' }, style: { guide: 'One line', examples: [] } },
    ],
  });
  const sys = msgs[0].content;
  assert.match(sys, /Channel "main"[\s\S]*Use 🔴[\s\S]*ex A/);
  assert.match(sys, /Channel "alerts"[\s\S]*One line[\s\S]*Source: @src/);
  assert.match(sys, /JSON object[\s\S]*"main": "\.\.\."[\s\S]*"alerts": "\.\.\."/);
  assert.match(sys, /Never invent/);
  assert.match(sys, /UPDATES an earlier story/);
  assert.match(msgs[1].content, /English translation:\nText[\s\S]*Original text:\nنص/);
});

test('terminology: rules parsed from the file, told to the model, and enforced on the draft text', () => {
  const rules = parseTerminology('# comment\nIDF => IOF\nIsrael Defense Forces => Israeli Occupation Forces\nHouthis => Ansarallah\nHouthi => Ansarallah\n\nnot a rule');
  assert.equal(rules.length, 4);
  assert.equal(
    applyTerminology('The Israel Defense Forces (IDF) said Houthi-controlled ports and the Houthis were hit. IDFX stays; idf said.', rules),
    'The Israeli Occupation Forces (IOF) said Ansarallah-controlled ports and the Ansarallah were hit. IDFX stays; IOF said.'
  );
  const [{ content: sys }] = buildDraftMessages({
    item: { raw_text: 'x', telegram_date: new Date() },
    targets: [{ channel: { key: 'main', name: 'Main' }, style: { guide: '', examples: [] } }],
    terminology: rules,
  });
  assert.match(sys, /write "IOF" instead of "IDF"/);
});

test('the Israeli flag is removed from drafts without leaving stray separators', () => {
  assert.equal(removeBannedFlags('🇮🇷⚡🇮🇱 Strike reported\nText 🇮🇱 here'), '🇮🇷 Strike reported\nText here');
  assert.equal(removeBannedFlags('🇮🇱⚡🇾🇪 Port hit'), '🇾🇪 Port hit');
  assert.equal(removeBannedFlags('🇱🇧⚡🇺🇸 Untouched'), '🇱🇧⚡🇺🇸 Untouched');
});

test('official channels: statements only from the organisation\'s own channel; the model is told the source type', () => {
  const officialSources = new Map([['hezb_official', 'Hezbollah']]);
  const target = [{ channel: { key: 'main', name: 'Main' }, style: { guide: '', examples: [] } }];
  const [{ content: sys }, { content: fromOfficial }] = buildDraftMessages({
    item: { raw_text: 'x', telegram_date: new Date(), channel_username: 'Hezb_Official' },
    targets: target,
    officialSources,
  });
  assert.match(sys, /Official statements: for these organisations — Hezbollah — [\s\S]*use exactly SKIP/);
  assert.match(fromOfficial, /Source: the official channel of Hezbollah/);
  const [, { content: fromOther }] = buildDraftMessages({
    item: { raw_text: 'x', telegram_date: new Date(), channel_username: 'random_news' },
    targets: target,
    officialSources,
  });
  assert.match(fromOther, /Source: not an official channel/);
  const [{ content: none }] = buildDraftMessages({ item: { raw_text: 'x', telegram_date: new Date() }, targets: target });
  assert.doesNotMatch(none, /Official statements/);
});

test('parseDraft / parseMultiDraft: wrappers, SKIP, 4096 limit, missing keys', () => {
  assert.deepEqual(parseDraft('SKIP'), { skip: true, text: null });
  assert.equal(parseDraft('```\n🔴 Post\n```').text, '🔴 Post');
  assert.equal(parseDraft('x'.repeat(5000)).text.length, 4096);
  const m = parseMultiDraft('```json\n{"main":"Post A","alerts":"SKIP"}\n```', ['main', 'alerts', 'other']);
  assert.equal(m.get('main').text, 'Post A');
  assert.equal(m.get('alerts').skip, true);
  assert.equal(m.has('other'), false);
});

test('review mode: one LLM call drafts every channel for a fresh high-priority story; others are not drafted', async () => {
  const high = await readyItem();
  const low = await readyItem({ priority: 'low' });
  const dup = await readyItem({ dedup: 'duplicate' });
  const stale = await readyItem({ minutesAgo: 600 });
  let calls = 0;
  const llm = fakeLLM((key) => `${key}: Strike near the port, 12 injured.`);
  await runDraftingTick({ llm: (...a) => (calls++, llm(...a)), styleFn: style });
  assert.equal(calls, 1, 'both channels in one call');
  assert.equal((await pubFor(high, 'main')).status, 'draft');
  assert.equal((await pubFor(high, 'alerts')).final_text, 'alerts: Strike near the port, 12 injured.');
  for (const id of [low, dup, stale]) assert.equal(await pubFor(id, 'main'), undefined);
});

async function storyFor(itemId, reports) {
  const { rows } = await pool.query(
    `INSERT INTO stories (canonical_item_id, normalized_text, content_hash, first_seen_at, last_seen_at, item_count)
     VALUES ($1, 'x', md5(random()::text), now(), now(), $2) RETURNING id`,
    [itemId, reports]
  );
  await pool.query('UPDATE raw_items SET story_id = $2 WHERE id = $1', [itemId, rows[0].id]);
  return rows[0].id;
}
const autoPubs = async () =>
  (await pool.query(`SELECT raw_item_id, score, score_detail FROM publications WHERE origin = 'auto' ORDER BY created_at`)).rows;

test('selection: best score wins (priority × corroboration × freshness), one slot per gap, cap per hour', async () => {
  setChannels([{ ...MAIN, draftPriorities: ['high', 'medium'], maxPerHour: 3 }]);
  const lone = await readyItem({ minutesAgo: 5 });
  const corroborated = await readyItem({ minutesAgo: 20 });
  await storyFor(corroborated, 6);
  const medium = await readyItem({ priority: 'medium', minutesAgo: 4 });
  await storyFor(medium, 8);
  const llm = fakeLLM(() => 'Post.');

  await runDraftingTick({ llm, styleFn: style });
  let picked = await autoPubs();
  assert.deepEqual(picked.map((p) => p.raw_item_id), [corroborated], 'high reported by 6 channels beats a newer lone high');
  assert.match(picked[0].score_detail, /high · 6 channels · \d+ min old/);

  await runDraftingTick({ llm, styleFn: style });
  assert.equal((await autoPubs()).length, 1, 'next slot waits for the gap (10 min at 3/hour)');

  await pool.query(`UPDATE publications SET created_at = created_at - interval '11 minutes'`);
  await runDraftingTick({ llm, styleFn: style });
  picked = await autoPubs();
  assert.equal(picked[1].raw_item_id, medium, 'medium reported by 8 channels (~15) beats a lone high (~9)');

  await pool.query(`UPDATE publications SET created_at = created_at - interval '11 minutes'`);
  await runDraftingTick({ llm, styleFn: style });
  assert.equal((await autoPubs())[2].raw_item_id, lone);
  await pool.query(`UPDATE publications SET created_at = created_at - interval '11 minutes' WHERE raw_item_id = $1`, [lone]);
  const another = await readyItem({ minutesAgo: 5 });
  await runDraftingTick({ llm, styleFn: style });
  assert.equal(await pubFor(another), undefined, '3 per hour reached');
});

test('selection: a report from an official channel scores double', async () => {
  const officialFile = path.join(path.dirname(channelsFile), 'official-sources.md');
  const username = (await pool.query('SELECT channel_username FROM sources WHERE id = $1', [sourceId])).rows[0].channel_username;
  fs.writeFileSync(officialFile, `@${username} => Hezbollah\n`);
  try {
    setChannels([{ ...MAIN, maxPerHour: 60 }]);
    const item = await readyItem({ minutesAgo: 5 });
    await runDraftingTick({ llm: fakeLLM(() => 'Post.'), styleFn: style });
    const pub = await pubFor(item);
    assert.ok(pub.score > 18, `score ${pub.score} includes the official bonus`);
    assert.match(pub.score_detail, /official channel/);
  } finally {
    fs.rmSync(officialFile, { force: true });
  }
});

test('official statements: word for word; no terminology inside; an altered statement is not auto-posted', async () => {
  process.env.PUBLISH_MODE = 'auto';
  const officialFile = path.join(path.dirname(channelsFile), 'official-sources.md');
  const termFile = path.join(path.dirname(channelsFile), 'terminology.md');
  const username = (await pool.query('SELECT channel_username FROM sources WHERE id = $1', [sourceId])).rows[0].channel_username;
  fs.writeFileSync(officialFile, `@${username} => Hezbollah\n`);
  fs.writeFileSync(termFile, 'Israeli army => Israeli occupation army\n');
  const statement = 'The Islamic Resistance targeted a gathering of Israeli army soldiers at 14:30.';
  try {
    setChannels([{ ...MAIN, maxPerHour: 60, minGapMinutes: 0 }]);
    const exact = await readyItem({ text: statement });
    await runDraftingTick({ llm: fakeLLM(() => `🇱🇧 Hezbollah:\n\n${statement}\n\n@main`), styleFn: style });
    const p1 = await pubFor(exact);
    assert.equal(p1.status, 'approved', 'verbatim statement is posted automatically');
    assert.match(p1.final_text, /Israeli army soldiers/, 'terminology not applied inside the statement');

    const reworded = await readyItem({ text: statement + ' ' });
    await runDraftingTick({ llm: fakeLLM(() => '🇱🇧 Hezbollah targeted soldiers at 14:30.\n\n@main'), styleFn: style });
    const p2 = await pubFor(reworded);
    assert.equal(p2.status, 'draft', 'altered statement waits for review');
    assert.match(p2.last_error, /wording differs/);
  } finally {
    fs.rmSync(officialFile, { force: true });
    fs.rmSync(termFile, { force: true });
  }
  assert.equal(keepsStatementVerbatim('HEADER\n"The  statement, here!" https://t.me/x @chan', 'The statement here'), true);
});

test('selection: in auto mode a bot channel only spends slots on stories it will post itself', async () => {
  process.env.PUBLISH_MODE = 'auto';
  setChannels([{ ...MAIN, draftPriorities: ['high', 'medium'], autoPriorities: ['high'], maxPerHour: 60, minGapMinutes: 0 }]);
  const medium = await readyItem({ priority: 'medium' });
  const high = await readyItem({ priority: 'high', minutesAgo: 30 });
  await runDraftingTick({ llm: fakeLLM(() => 'Post.'), styleFn: style });
  await runDraftingTick({ llm: fakeLLM(() => 'Post.'), styleFn: style });
  assert.equal(await pubFor(medium), undefined, 'medium would only wait for review');
  assert.equal((await pubFor(high)).status, 'approved');
});

test('selection: a story with a photo/video scores 1.2× (from any copy of the story), unless the channel posts text only', async () => {
  setChannels([{ ...MAIN, maxPerHour: 60, minGapMinutes: 0 }]);
  const plain = await readyItem({ minutesAgo: 5 });
  const withMedia = await readyItem({ minutesAgo: 5 });
  const copy = await readyItem({ minutesAgo: 6, dedup: 'duplicate' });
  const story = await storyFor(withMedia, 1);
  await pool.query('UPDATE raw_items SET story_id = $2, has_media = true WHERE id = $1', [copy, story]);
  await runDraftingTick({ llm: fakeLLM(() => 'Post.'), styleFn: style });
  await runDraftingTick({ llm: fakeLLM(() => 'Post.'), styleFn: style });
  const a = await pubFor(plain);
  const b = await pubFor(withMedia);
  assert.ok(Math.abs(b.score / a.score - 1.2) < 0.01, `${b.score} vs ${a.score}`);
  assert.match(b.score_detail, /photo\/video/);

  await pool.query('DELETE FROM publications');
  setChannels([{ ...MAIN, maxPerHour: 60, minGapMinutes: 0, media: false }]);
  await runDraftingTick({ llm: fakeLLM(() => 'Post.'), styleFn: style });
  await runDraftingTick({ llm: fakeLLM(() => 'Post.'), styleFn: style });
  assert.ok(Math.abs((await pubFor(withMedia)).score - (await pubFor(plain)).score) < 0.01, 'text-only channel: no boost');
});

test('selection: a story settles before it is picked unless widely reported; a story is not reposted, an update only after 30 min; stale requests expire', async () => {
  setChannels([{ ...MAIN, maxPerHour: 60, minGapMinutes: 0 }]);
  const llm = fakeLLM(() => 'Post.');
  const brandNew = await readyItem({ minutesAgo: 1 });
  await runDraftingTick({ llm, styleFn: style });
  assert.equal(await pubFor(brandNew), undefined, '1 minute old, 1 channel: still settling');
  await storyFor(brandNew, 3);
  await runDraftingTick({ llm, styleFn: style });
  assert.equal((await pubFor(brandNew)).status, 'draft', '3 channels already: no need to wait');

  const storyId = (await pool.query('SELECT story_id FROM raw_items WHERE id = $1', [brandNew])).rows[0].story_id;
  const update = await readyItem({ minutesAgo: 5, dedup: 'update' });
  await pool.query('UPDATE raw_items SET story_id = $2 WHERE id = $1', [update, storyId]);
  await runDraftingTick({ llm, styleFn: style });
  assert.equal(await pubFor(update), undefined, 'same story posted minutes ago');
  await pool.query(`UPDATE publications SET created_at = created_at - interval '31 minutes'`);
  await runDraftingTick({ llm, styleFn: style });
  assert.equal((await pubFor(update)).status, 'draft', 'update with new figures, 30+ min later');

  const staleItem = await readyItem({ minutesAgo: 600 });
  await pool.query(
    `INSERT INTO publications (raw_item_id, channel_key, origin, status) VALUES ($1, 'main', 'auto', 'requested')`,
    [staleItem]
  );
  await runDraftingTick({ llm, styleFn: style });
  assert.equal((await pubFor(staleItem)).status, 'expired');
});

test('auto mode: bot-channel draft is approved and sent; manual channel stays a draft; SKIP is per channel', async () => {
  process.env.PUBLISH_MODE = 'auto';
  const item = await readyItem();
  const llm = fakeLLM((key) => (key === 'alerts' ? 'SKIP' : '🔴 Post'));
  await runDraftingTick({ llm, styleFn: style });
  assert.equal((await pubFor(item, 'main')).status, 'approved');
  assert.equal((await pubFor(item, 'alerts')).status, 'rejected');

  const sent = [];
  const out = await runPublishingTick({ send: async (text, channel) => (sent.push([channel.key, text]), { messageId: 777 }) });
  assert.equal(out[0].outcome, 'published');
  assert.equal(Number((await pubFor(item, 'main')).telegram_message_id), 777);
  assert.deepEqual(sent, [['main', '🔴 Post']]);
});

test('a channel left out of the multi-channel reply is retried, the others are kept', async () => {
  const item = await readyItem();
  await runDraftingTick({ llm: async () => ({ content: '{"main":"Only main"}', model: 'fake' }), styleFn: style });
  assert.equal((await pubFor(item, 'main')).status, 'draft');
  const alerts = await pubFor(item, 'alerts');
  assert.equal(alerts.status, 'requested');
  assert.equal(alerts.attempts, 1);
});

test('LLM out of quota: drafts go back to the queue without using attempts', async () => {
  const item = await readyItem();
  const res = await runDraftingTick({ llm: async () => { throw new Error('Groq request failed (429): rate limit reached'); }, styleFn: style });
  assert.equal(res[0].systemic, true);
  const p = await pubFor(item, 'main');
  assert.equal(p.status, 'requested');
  assert.equal(p.attempts, 0);
});

test('sender: only bot channels are sent; flood-wait pauses and requeues; stale automatic posts expire; operator-approved stale posts still go', async () => {
  setChannels([{ ...MAIN, minGapMinutes: 0 }, ALERTS]);
  const fresh = await readyItem();
  const stale = await readyItem({ minutesAgo: 600 });
  const staleManual = await readyItem({ minutesAgo: 600 });
  await pool.query(
    `INSERT INTO publications (raw_item_id, channel_key, status, origin, final_text, approved_at) VALUES
       ($1, 'main', 'approved', 'auto', 'fresh', now()), ($2, 'main', 'approved', 'auto', 'stale', now()),
       ($3, 'main', 'approved', 'manual', 'manual', now() + interval '1 second'),
       ($1, 'alerts', 'approved', 'manual', 'never sent by the bot', now() - interval '1 hour')`,
    [fresh, stale, staleManual]
  );
  const flood = Object.assign(new Error('A wait of 50 seconds is required'), { seconds: 50 });
  const r1 = await runPublishingTick({ send: async () => { throw flood; } });
  assert.equal(r1[0].systemic, true);
  assert.equal((await pubFor(stale)).status, 'expired');
  assert.equal((await pubFor(fresh)).status, 'approved');
  assert.equal(publishGate().isPaused(), true);
  assert.deepEqual(await runPublishingTick({ send: async () => ({ messageId: 1 }) }), [], 'nothing sent while paused');
  publishGate().pausedUntil = 0;

  const sentTo = [];
  for (let i = 0; i < 3; i++) await runPublishingTick({ send: async (t, ch) => (sentTo.push(ch.key), { messageId: i }) });
  assert.deepEqual(sentTo, ['main', 'main']);
  assert.equal((await pubFor(fresh)).status, 'published');
  assert.equal((await pubFor(staleManual)).status, 'published');
  assert.equal((await pubFor(fresh, 'alerts')).status, 'approved', 'manual channel is never sent by the bot');
});

test('sender: automatic posts keep to maxPerHour and minGapMinutes, best score first; operator-approved posts go anyway', async () => {
  setChannels([{ ...MAIN, maxPerHour: 2, minGapMinutes: 10 }, ALERTS]);
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push(await readyItem());
  await pool.query(
    `INSERT INTO publications (raw_item_id, channel_key, status, origin, final_text, approved_at, score) VALUES
       ($1, 'main', 'approved', 'auto', 'low score', now(), 5), ($2, 'main', 'approved', 'auto', 'top score', now(), 30),
       ($3, 'main', 'approved', 'auto', 'mid score', now(), 12)`,
    ids.slice(0, 3)
  );
  const sent = [];
  const send = async (t) => (sent.push(t), { messageId: sent.length });
  await runPublishingTick({ send });
  await runPublishingTick({ send });
  assert.deepEqual(sent, ['top score'], 'second automatic post waits for the 10-minute gap');

  await pool.query(`UPDATE publications SET published_at = published_at - interval '11 minutes' WHERE status = 'published'`);
  await runPublishingTick({ send });
  await pool.query(`UPDATE publications SET published_at = published_at - interval '11 minutes' WHERE status = 'published'`);
  await runPublishingTick({ send });
  assert.deepEqual(sent, ['top score', 'mid score'], '2 per hour reached');

  await pool.query(
    `INSERT INTO publications (raw_item_id, channel_key, status, origin, final_text, approved_at) VALUES ($1, 'main', 'approved', 'manual', 'operator approved', now())`,
    [ids[3]]
  );
  await runPublishingTick({ send });
  assert.equal(sent.at(-1), 'operator approved');
});

test('drafter: automatic drafts queued before scored selection (no score) are expired, not posted', async () => {
  const item = await readyItem();
  await pool.query(`INSERT INTO publications (raw_item_id, channel_key, origin, status, final_text) VALUES ($1, 'main', 'auto', 'approved', 'old')`, [item]);
  await runDraftingTick({ llm: fakeLLM(() => 'Post.'), styleFn: style });
  assert.equal((await pubFor(item)).status, 'expired');
});

test('sender: the post\'s media is passed to the bot; a media problem means a text-only post, not a lost one', async () => {
  const item = await readyItem();
  await pool.query('UPDATE raw_items SET has_media = true WHERE id = $1', [item]);
  await pool.query(`INSERT INTO publications (raw_item_id, channel_key, status, origin, final_text, approved_at) VALUES ($1, 'main', 'approved', 'manual', 'with media', now())`, [item]);
  let got;
  await runPublishingTick({
    send: async (t, ch, cfg, media) => ((got = media), { messageId: 1 }),
    loadMedia: async (id) => [{ kind: 'photo', name: '1.jpg', file: `/tmp/${id}.jpg` }],
  });
  assert.equal(got.length, 1);
  let p = await pubFor(item);
  assert.deepEqual([p.media_count, p.media_note], [1, null]);

  const item2 = await readyItem();
  await pool.query('UPDATE raw_items SET has_media = true WHERE id = $1', [item2]);
  await pool.query(`INSERT INTO publications (raw_item_id, channel_key, status, origin, final_text, approved_at) VALUES ($1, 'main', 'approved', 'manual', 'text only', now())`, [item2]);
  await runPublishingTick({
    send: async (t, ch, cfg, media) => ((got = media), { messageId: 2 }),
    loadMedia: async () => { throw new Error('download timed out'); },
  });
  assert.deepEqual(got, []);
  p = await pubFor(item2);
  assert.equal(p.status, 'published');
  assert.equal(p.media_count, 0);
  assert.match(p.media_note, /text only: couldn't get the media \(download timed out\)/);

  const item3 = await readyItem();
  await pool.query('UPDATE raw_items SET has_media = true WHERE id = $1', [item3]);
  await pool.query(`INSERT INTO publications (raw_item_id, channel_key, status, origin, final_text, approved_at) VALUES ($1, 'main', 'approved', 'manual', 'refused', now())`, [item3]);
  await runPublishingTick({
    send: async () => ({ messageId: 3, mediaCount: 0, mediaError: 'MEDIA_INVALID' }),
    loadMedia: async () => [{ kind: 'video', name: '1.mp4', file: '/tmp/x.mp4' }],
  });
  assert.match((await pubFor(item3)).media_note, /Telegram refused the media \(MEDIA_INVALID\)/);
});

test('digest: slots are local times in the configured zone', () => {
  // 10:30 in Pakistan (UTC+5) on 21 Oct: current slot 09:00 today, previous 21:00 yesterday.
  const { current, previous } = digestSlots(['09:00', '21:00'], 'Asia/Karachi', new Date('2026-10-21T05:30:00Z'));
  assert.equal(current.toISOString(), '2026-10-21T04:00:00.000Z');
  assert.equal(previous.toISOString(), '2026-10-20T16:00:00.000Z');
  assert.equal(digestSlots(['9:00'], 'UTC', new Date('2026-10-21T08:00:00Z')).current.toISOString(), '2026-10-20T09:00:00.000Z');
});

test('digest: posted once per slot, auto-approved on the bot channel, skipped when late or quiet; sent past the hourly cap without media', async () => {
  process.env.PUBLISH_MODE = 'auto';
  process.env.PUBLISH_TIMEZONE = 'UTC';
  const fiveMinAgo = new Date(Date.now() - 5 * 60_000);
  const time = `${String(fiveMinAgo.getUTCHours()).padStart(2, '0')}:${String(fiveMinAgo.getUTCMinutes()).padStart(2, '0')}`;
  setChannels([{ ...MAIN, maxPerHour: 1, digest: { times: [time], maxStories: 5 } }]);
  const slot = digestSlots([time], 'UTC', new Date()).current;
  for (let i = 0; i < 4; i++) await readyItem({ minutesAgo: 5 + i, text: `Story number ${i} with 3 casualties.` });
  let prompt;
  const llm = async (messages) => ((prompt = messages), { content: '🔴 Summary\n1. One\n2. Two\n3. Three', model: 'fake' });
  try {
    await runDigestTick({ llm, styleFn: style });
    const { rows } = await pool.query(`SELECT * FROM publications WHERE kind = 'digest'`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'approved');
    assert.match(rows[0].score_detail, /summary of \d+ stories/);
    assert.match(prompt[1].content, /Story number 0/);
    assert.match(prompt[0].content, /neutral verb "said"/);

    await runDigestTick({ llm: async () => assert.fail('only once per slot'), styleFn: style, now: new Date(slot.getTime() + 30 * 60_000) });
    await runDigestTick({ llm: async () => assert.fail('too late'), styleFn: style, now: new Date(slot.getTime() + 24 * 3600_000 + 2 * 3600_000) });

    // A regular post already used this hour's only slot; the summary still goes, with no media.
    const item = await readyItem();
    await pool.query(`INSERT INTO publications (raw_item_id, channel_key, status, origin, final_text, published_at) VALUES ($1, 'main', 'published', 'auto', 'x', now())`, [item]);
    let sent;
    await runPublishingTick({ send: async (t, ch, cfg, media) => ((sent = { t, media }), { messageId: 9 }), loadMedia: async () => assert.fail('no media for summaries') });
    assert.match(sent.t, /Summary/);
    assert.deepEqual(sent.media, []);

    setChannels([{ ...MAIN, digest: { times: ['00:00'] } }]);
    const quiet = new Date('2031-01-01T00:10:00Z');
    await runDigestTick({ llm: async () => assert.fail('nothing to summarise'), styleFn: style, now: quiet });
    const q = (await pool.query(`SELECT status, last_error FROM publications WHERE kind = 'digest' AND digest_slot = '2031-01-01T00:00:00Z'`)).rows[0];
    assert.equal(q.status, 'rejected');
    assert.match(q.last_error, /notable stories/);
  } finally {
    delete process.env.PUBLISH_TIMEZONE;
  }
});

test('API + sender: "post now" sends a queued automatic post past the hourly limit, first in line', async () => {
  setChannels([{ ...MAIN, maxPerHour: 1, minGapMinutes: 0 }, ALERTS]);
  const done = await readyItem();
  const waiting = await readyItem();
  await pool.query(`INSERT INTO publications (raw_item_id, channel_key, status, origin, final_text, published_at) VALUES ($1, 'main', 'published', 'auto', 'x', now())`, [done]);
  const { rows: [q] } = await pool.query(
    `INSERT INTO publications (raw_item_id, channel_key, status, origin, final_text, approved_at, score) VALUES ($1, 'main', 'approved', 'auto', 'queued', now(), 5) RETURNING id`,
    [waiting]
  );
  let sent = [];
  const send = async (t) => (sent.push(t), { messageId: 1 });
  await runPublishingTick({ send, loadMedia: async () => [] });
  assert.deepEqual(sent, [], 'hourly limit holds the automatic post');

  const app = express();
  app.use(express.json());
  app.use('/api/publications', publicationsRouter);
  const server = app.listen(0);
  try {
    const r = await fetch(`http://localhost:${server.address().port}/api/publications/${q.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'post_now' }),
    });
    assert.equal(r.status, 200);
  } finally {
    server.close();
  }
  await runPublishingTick({ send, loadMedia: async () => [] });
  assert.deepEqual(sent, ['queued']);
});

test('sender: a real Telegram error (bot not admin) fails the post after 3 attempts', async () => {
  const item = await readyItem();
  await pool.query(`INSERT INTO publications (raw_item_id, channel_key, status, origin, final_text, approved_at) VALUES ($1, 'main', 'approved', 'manual', 't', now())`, [item]);
  const err = Object.assign(new Error('CHAT_ADMIN_REQUIRED'), { code: 400, errorMessage: 'CHAT_ADMIN_REQUIRED' });
  for (let i = 0; i < 3; i++) await runPublishingTick({ send: async () => { throw err; } });
  const p = await pubFor(item);
  assert.equal(p.status, 'failed');
  assert.equal(p.attempts, 3);
});

test('sender: no bot token -> approved posts wait', async () => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  const item = await readyItem();
  await pool.query(`INSERT INTO publications (raw_item_id, channel_key, status, origin, final_text, approved_at) VALUES ($1, 'main', 'approved', 'manual', 't', now())`, [item]);
  assert.deepEqual(await runPublishingTick({ send: async () => ({ messageId: 1 }) }), []);
  assert.equal((await pubFor(item)).status, 'approved');
});

test('config: a channel\'s posting prompt can live in its own file, re-read when edited', async () => {
  const { publishConfig } = await import('./config.js');
  const guide = path.join(os.tmpdir(), `nb-guide-${process.pid}.md`);
  fs.writeFileSync(guide, 'Prompt v1');
  setChannels([{ ...MAIN, styleGuideFile: path.basename(guide) }]);
  assert.equal(publishConfig().channels[0].styleGuide, 'Prompt v1');
  fs.writeFileSync(guide, 'Prompt v2');
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(guide, t, t);
  assert.equal(publishConfig().channels[0].styleGuide, 'Prompt v2');
  fs.writeFileSync(channelsFile, '\uFEFF' + JSON.stringify([MAIN]));
  fs.utimesSync(channelsFile, new Date(Date.now() + 9000), new Date(Date.now() + 9000));
  assert.equal(publishConfig().channels[0].key, 'main', 'UTF-8 BOM from PowerShell/Notepad is accepted');
  setChannels([{ ...MAIN, styleGuideFile: 'missing.md' }]);
  assert.throws(() => publishConfig(), /styleGuideFile not found/);
  fs.rmSync(guide);
});

test('config: invalid channels are rejected with a clear message', async () => {
  const { normalizeChannels } = await import('./config.js');
  const d = { draftPriorities: 'high', autoPriorities: 'high', sourceCredit: 'none', parseMode: 'none' };
  assert.throws(() => normalizeChannels([{ key: 'Bad Key' }], d), /key/);
  assert.throws(() => normalizeChannels([{ key: 'a' }, { key: 'a' }], d), /twice/);
  assert.throws(() => normalizeChannels([{ key: 'a', delivery: 'bot' }], d), /needs "telegram"/);
  assert.equal(normalizeChannels([{ key: 'a' }], d)[0].delivery, 'manual');
});

test('API: draft for all channels; approve on bot channel; copy-and-mark-sent on manual channel; wrong actions refused', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/publications', publicationsRouter);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/publications`;
  const call = (p, method, body) =>
    fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  try {
    const item = await readyItem({ priority: 'low' });
    const created = await (await call('', 'POST', { rawItemId: item })).json();
    assert.deepEqual(created.items.map((p) => [p.channel_key, p.status, p.origin]).sort(), [
      ['alerts', 'requested', 'manual'],
      ['main', 'requested', 'manual'],
    ]);

    await runDraftingTick({ llm: fakeLLM((k) => `Draft for ${k}`), styleFn: style });
    const variants = (await (await call(`/item/${item}`, 'GET')).json()).items;
    const main = variants.find((p) => p.channel_key === 'main');
    const alerts = variants.find((p) => p.channel_key === 'alerts');
    assert.equal(main.status, 'draft', 'manual requests are drafted even at low priority');
    assert.equal(alerts.delivery, 'manual');

    assert.equal((await call(`/${alerts.id}`, 'PATCH', { action: 'approve' })).status, 409, 'manual channel cannot be queued for the bot');
    const sent = await (await call(`/${alerts.id}`, 'PATCH', { action: 'mark_sent', text: 'Edited alert' })).json();
    assert.equal(sent.status, 'sent_manually');
    assert.equal(sent.final_text, 'Edited alert');
    assert.ok(sent.published_at);

    assert.equal((await call(`/${main.id}`, 'PATCH', { action: 'mark_sent' })).status, 409, 'bot channel is approved, not marked');
    const approved = await (await call(`/${main.id}`, 'PATCH', { action: 'approve', text: 'Edited main' })).json();
    assert.equal(approved.status, 'approved');
    assert.equal((await call(`/${main.id}`, 'PATCH', { action: 'approve' })).status, 409);

    const published = await (await call('?group=published&channel=alerts', 'GET')).json();
    assert.deepEqual(published.items.map((p) => p.id), [alerts.id]);
    const status = await (await call('/status', 'GET')).json();
    assert.deepEqual(status.channels.map((c) => [c.key, c.delivery]), [['main', 'bot'], ['alerts', 'manual']]);
    assert.equal(status.botConfigured, true);
  } finally {
    server.close();
  }
});
