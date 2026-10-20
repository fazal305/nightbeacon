import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../db/pool.js';

process.env.TELEGRAM_API_ID = '1';
process.env.TELEGRAM_API_HASH = 'x';
process.env.TELEGRAM_SESSION = 'test-session';
process.env.TELEGRAM_PROXY_FAILOVER_AFTER = '3';
const tc = await import('./telegramClient.js');

const route = (name) => ({ ip: name, port: 443, MTProxy: true, secret: 'dd' });
const fakeClient = (name) => ({ name, destroyed: false, addEventHandler() {}, async destroy() { this.destroyed = true; } });

let attempts;
function connector(behaviour) {
  return async (proxy) => {
    attempts.push(proxy.ip);
    if (behaviour[proxy.ip] === 'fail') throw new Error(`no answer from ${proxy.ip}`);
    return fakeClient(proxy.ip);
  };
}

beforeEach(() => {
  attempts = [];
});

after(async () => {
  tc._setConnectRouteForTests(null, null);
  await pool.end();
});

test('uses the first route that works, skipping dead ones', async () => {
  tc._setConnectRouteForTests(connector({ a: 'fail' }), [route('a'), route('b'), route('c')]);
  const c = await tc.getTelegramClient();
  assert.equal(c.name, 'b');
  assert.deepEqual(attempts, ['a', 'b']);
  assert.equal(tc.telegramStats.activeRoute, 'MTProxy b:443');
  assert.equal(await tc.getTelegramClient(), c, 'connected client is reused');
});

test('fails over to the next route after repeated silence, and re-runs client hooks', async () => {
  tc._setConnectRouteForTests(connector({}), [route('a'), route('b'), route('c')]);
  const seen = [];
  tc.onTelegramClient((c) => seen.push(c.name));
  const first = await tc.getTelegramClient();
  assert.equal(first.name, 'a');

  tc.reportConnectivityFailure();
  tc.reportConnectivityFailure();
  assert.equal(await tc.getTelegramClient(), first, 'two failures: still on the same route');

  tc.reportTelegramSuccess(); // an answer resets the count
  tc.reportConnectivityFailure();
  tc.reportConnectivityFailure();
  tc.reportConnectivityFailure();
  assert.equal(first.destroyed, true, 'dead client torn down');
  const second = await tc.getTelegramClient();
  assert.equal(second.name, 'b');
  assert.deepEqual(seen, ['a', 'b'], 'live-update hook registered on each new client');
});

test('every route failing gives one clear error and the next attempt rotates the start', async () => {
  tc._setConnectRouteForTests(connector({ a: 'fail', b: 'fail' }), [route('a'), route('b')]);
  await assert.rejects(tc.getTelegramClient(), /Could not reach Telegram via any of 2 configured route\(s\)/);
  assert.deepEqual(attempts, ['a', 'b']);
  attempts = [];
  await assert.rejects(tc.getTelegramClient());
  assert.deepEqual(attempts, ['b', 'a']);
});

test('withTimeout turns a hung request into an error', async () => {
  await assert.rejects(tc.withTimeout(new Promise(() => {}), 50, 'getMessages'), /did not answer within 0.05s \(getMessages\)/);
});
