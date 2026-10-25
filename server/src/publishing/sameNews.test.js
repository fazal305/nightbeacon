import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../db/pool.js';
import { isSameNews, similarity } from './sameNews.js';
import { limitsFor, _setPaceProfileForTests, localHour } from './pace.js';

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
