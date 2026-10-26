import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../db/pool.js';
import { isSameNews, similarity } from './sameNews.js';
import { limitsFor, _setPaceProfileForTests, _setOwnStatsForTests, localHour, paceRates, hourlyViews } from './pace.js';

after(() => pool.end());

test('same news: reworded posts of one event match; different events do not', () => {
  const a = '🔴 IOF airstrike on the town of Aitaroun in south Lebanon, 3 people martyred, 7 wounded.\n#Lebanon\n@r3syst';
  const b = 'BREAKING: Three martyred and 7 wounded as the IOF strikes Aitaroun, south Lebanon. #Lebanon #MiddleEast\n@ResistanceMediaNews';
  const c = 'Iran\'s foreign minister said talks with the IAEA will continue in Vienna next week. #Iran\n@r3syst';
  assert.equal(isSameNews(a, b), true, `similarity ${similarity(a, b)}`);
  assert.equal(isSameNews(a, c), false);
  assert.equal(isSameNews('🔴 BREAKING\n@r3syst', '🔴 BREAKING\n@r3syst'), false, 'too short to judge');
});

test('pace: a channel follows another channel\'s hourly pattern, capped by its maxPerHour', () => {
  const hours = Array(24).fill(0);
  const now = new Date();
  const h = localHour(now, 'Asia/Karachi');
  hours[h] = 3.4;
  _setPaceProfileForTests('Spectator_Test', hours);
  const ch = { key: 'x', maxPerHour: 6, minGapMinutes: 5, paceLike: 'Spectator_Test' };
  assert.deepEqual(limitsFor(ch, { timeZone: 'Asia/Karachi' }, now), { maxPerHour: 3, minGapMinutes: 10 });
  hours[h] = 15;
  assert.equal(limitsFor(ch, { timeZone: 'Asia/Karachi' }, now).maxPerHour, 6, 'never above maxPerHour');
  hours[h] = 0.2;
  assert.equal(limitsFor(ch, { timeZone: 'Asia/Karachi' }, now).maxPerHour, 1, 'at least one an hour');
  assert.equal(limitsFor({ ...ch, paceLike: null }, { timeZone: 'Asia/Karachi' }, now).maxPerHour, 6);
});

test('pace from own stats: more posts at hours with more views, the day averages postsPerHour', () => {
  const tz = 'Asia/Karachi';
  const now = new Date();
  const h = localHour(now, tz);
  const quiet = (h + 12) % 24;
  // 10 posts at every hour; posts at hour h get 3× the views, at `quiet` a tenth.
  const hours = Array.from({ length: 24 }, (_, i) => ({ n: 10, views: i === h ? 3000 : i === quiet ? 100 : 1000 }));
  const rates = paceRates(hours, { target: 1, max: 3 });
  const day = rates.reduce((s, r) => s + r, 0);
  assert.ok(day > 22 && day < 26, `about 24 a day, got ${day}`);
  assert.ok(rates[h] > 2 && rates[h] <= 3, `busy hour ${rates[h]}`);
  assert.equal(rates[quiet], 0.5, 'quiet hour keeps one post per two hours');
  assert.equal(paceRates(hours.map((x) => ({ ...x, n: 0 })), { target: 1, max: 3 }), null, 'too few posts');

  const ch = { key: 'own_test', pace: 'stats', postsPerHour: 1, maxPerHour: 3 };
  assert.deepEqual(limitsFor(ch, { timeZone: tz }, now), { maxPerHour: 1, minGapMinutes: 60 }, 'before stats: postsPerHour');
  _setOwnStatsForTests('own_test', hours);
  const busy = limitsFor(ch, { timeZone: tz }, now);
  assert.equal(busy.maxPerHour, 3);
  assert.ok(busy.minGapMinutes < 30);
  const later = new Date(now.getTime() + 12 * 3600_000);
  assert.deepEqual(limitsFor(ch, { timeZone: tz }, later), { maxPerHour: 1, minGapMinutes: 120 });

  const v = hourlyViews([{ at: now.getTime(), views: 100 }, { at: now.getTime(), views: 300 }], tz);
  assert.deepEqual(v[h], { n: 2, views: 200 });
});

test('silent delivery: only headline posts ring with notify "breaking"; everything is silent in quiet hours', async () => {
  const { isSilent } = await import('./sender.js');
  const cfg = { timeZone: 'Asia/Karachi' };
  const ch = { notify: 'breaking', quietHours: null };
  assert.equal(isSilent({ kind: 'post', final_text: '🔴 BREAKING: strike on the port' }, ch, cfg), false);
  assert.equal(isSilent({ kind: 'post', final_text: 'The ministry said talks continue.' }, ch, cfg), true);
  assert.equal(isSilent({ kind: 'digest', final_text: 'Summary' }, ch, cfg), false);
  assert.equal(isSilent({ kind: 'post', post_now: true, final_text: 'x' }, ch, cfg), false);
  assert.equal(isSilent({ kind: 'post', final_text: 'x' }, { notify: 'all' }, cfg), false);
  const h = localHour(new Date(), 'Asia/Karachi');
  const quiet = { notify: 'all', quietHours: `${String(h).padStart(2, '0')}:00-${String((h + 1) % 24).padStart(2, '0')}:00` };
  assert.equal(isSilent({ kind: 'post', final_text: '🔴 BREAKING' }, quiet, cfg), true);
});
