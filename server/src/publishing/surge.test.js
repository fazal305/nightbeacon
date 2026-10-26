import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../db/pool.js';
import { surgeReason, surgeSettings, refreshSurge, setSurge, surgeActive, _setSurgeForTests } from './surge.js';
import { limitsFor } from './pace.js';

after(async () => {
  await pool.query(`DELETE FROM app_state WHERE key = 'surge'`).catch(() => {});
  await pool.end();
});

const settings = surgeSettings({});

test('big-event mode: a burst of high-priority stories or one story everyone reports', () => {
  assert.equal(surgeReason({ lastHour: 5, hourlyAvg: 4, topReports: 12 }, settings), null, 'a normal hour');
  assert.equal(surgeReason({ lastHour: 10, hourlyAvg: 2, topReports: 12 }, settings), null, 'below the minimum');
  assert.equal(surgeReason({ lastHour: 20, hourlyAvg: 9, topReports: 12 }, settings), null, 'busy, but not 3× usual');
  assert.match(surgeReason({ lastHour: 30, hourlyAvg: 6, topReports: 12 }, settings), /30 high-priority stories/);
  assert.match(surgeReason({ lastHour: 3, hourlyAvg: 4, topReports: 55 }, settings), /55 channels/);
});

test('big-event mode: switches on and off, holds after the signal, raises the limits', async () => {
  await pool.query(`DELETE FROM app_state WHERE key = 'surge'`);
  _setSurgeForTests(null);
  const now = Date.now();
  const burst = async () => ({ lastHour: 40, hourlyAvg: 5, topReports: 10 });
  const calm = async () => ({ lastHour: 2, hourlyAvg: 5, topReports: 10 });

  assert.equal(await refreshSurge({ signals: calm, now }), null);
  const on = await refreshSurge({ signals: burst, now: now + 3 * 60_000 });
  assert.ok(on && !on.manual);
  // Calm again: still on during the hold, off after it.
  assert.ok(await refreshSurge({ signals: calm, now: now + 60 * 60_000 }));
  assert.equal(await refreshSurge({ signals: calm, now: now + 3 * 3600_000 }), null);

  const ch = { key: 'surge_test', maxPerHour: 2, minGapMinutes: 30, surgeMaxPerHour: 6 };
  const cfg = { timeZone: 'UTC' };
  assert.deepEqual(limitsFor(ch, cfg, new Date(now + 3 * 3600_000)), { maxPerHour: 2, minGapMinutes: 30 }, 'after the hold');
  await setSurge(3);
  assert.deepEqual(limitsFor(ch, cfg), { maxPerHour: 6, minGapMinutes: 10, surge: true });
  assert.deepEqual(limitsFor({ ...ch, surgeMaxPerHour: null }, cfg), { maxPerHour: 2, minGapMinutes: 30 }, 'only channels with surge');

  // Switched off by hand: the detector stays quiet for the hold time.
  await setSurge(0);
  assert.equal(surgeActive(), null);
  assert.equal(await refreshSurge({ signals: burst, now: Date.now() + 5 * 60_000 }), null);
});
