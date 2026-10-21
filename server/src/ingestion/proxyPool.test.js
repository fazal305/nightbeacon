import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Api } from 'telegram';
import { pool } from '../db/pool.js';
import { rankRoutes, recordLatency, extractProxyLinks, proxyButton, measureRoutes } from './proxyPool.js';
import { shouldSwitch, proxyCheck, _resetProxyMaintenanceForTests } from './proxyMaintenance.js';

const SECRET = '0123456789abcdef0123456789abcdef';
const link = (ip) => `https://t.me/proxy?server=${ip}&port=443&secret=${SECRET}`;
const route = (ip) => ({ ip, port: 443, MTProxy: true, secret: SECRET });

after(() => pool.end());

test('proxies are ranked fastest first; unmeasured next; ones that did not answer last', () => {
  const [a, b, c, d] = ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4'].map(route);
  recordLatency(a, null);
  recordLatency(b, 400);
  recordLatency(c, 90);
  assert.deepEqual(rankRoutes([a, b, c, d]).map((p) => p.ip), ['10.0.0.3', '10.0.0.2', '10.0.0.4', '10.0.0.1']);
});

test('proxy links are found in bot text, linked words and URL buttons', () => {
  const messages = [
    {
      message: `Fresh proxies:\ntg://proxy?server=1.2.3.4&port=443&secret=${SECRET}\nmore below`,
      entities: [{ url: link('5.6.7.8') }],
      replyMarkup: { rows: [{ buttons: [{ url: `https://t.me/socks?server=9.9.9.9&port=1080` }, { text: 'Channel', url: 'https://t.me/somechannel' }] }] },
    },
  ];
  assert.deepEqual(extractProxyLinks(messages).sort(), [
    `https://t.me/proxy?server=5.6.7.8&port=443&secret=${SECRET}`,
    'https://t.me/socks?server=9.9.9.9&port=1080',
    `tg://proxy?server=1.2.3.4&port=443&secret=${SECRET}`,
  ]);
  const button = new Api.KeyboardButtonCallback({ text: '🔄 Get proxy', data: Buffer.from('p') });
  assert.equal(proxyButton([{ id: 7, replyMarkup: { rows: [{ buttons: [button] }] } }]).msg.id, 7);
});

test('switch only to a clearly faster proxy, or when the current one stopped answering', () => {
  assert.equal(shouldSwitch(800, 200), true);
  assert.equal(shouldSwitch(300, 250), false, 'not much faster');
  assert.equal(shouldSwitch(null, 900), true, 'current one gives no answer');
  assert.equal(shouldSwitch(200, null), false);
});

test('fewer than 3 working proxies: new links come from the bot, are tested, and saved', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-proxy-'));
  process.env.TELEGRAM_PROXY_FOUND_FILE = path.join(dir, 'found.txt');
  process.env.TELEGRAM_PROXY_LINKS = [link('10.1.0.1'), link('10.1.0.2')].join(' ');
  const answering = new Set(['10.1.0.1', '10.2.0.1', '10.2.0.3']);
  const probe = async (p) => (answering.has(p.ip) ? 100 : null);
  _resetProxyMaintenanceForTests();
  const tc = await import('./telegramClient.js');
  tc._setConnectRouteForTests(async (p) => ({ name: p.ip, addEventHandler() {}, async destroy() {} }), null);
  process.env.TELEGRAM_API_ID = '1';
  process.env.TELEGRAM_API_HASH = 'x';
  process.env.TELEGRAM_SESSION = 's';
  let asked = 0;
  const report = await proxyCheck({
    probe,
    fetchLinks: async () => {
      asked++;
      return [link('10.2.0.1'), link('10.2.0.2'), link('10.2.0.3'), link('10.1.0.1')];
    },
  });
  assert.equal(asked, 1);
  assert.equal(report.working, 1);
  assert.equal(report.added, 2, 'only new links that answer are kept');
  const saved = fs.readFileSync(process.env.TELEGRAM_PROXY_FOUND_FILE, 'utf8');
  assert.match(saved, /10\.2\.0\.1/);
  assert.doesNotMatch(saved, /10\.2\.0\.2/);
  // Not asked again within the hour.
  await proxyCheck({ probe, fetchLinks: async () => { asked++; return []; } });
  assert.equal(asked, 1);
  tc._setConnectRouteForTests(null, null);
  delete process.env.TELEGRAM_PROXY_FOUND_FILE;
  delete process.env.TELEGRAM_PROXY_LINKS;
});

test('measureRoutes probes every proxy', async () => {
  const r = await measureRoutes([route('10.3.0.1'), undefined, route('10.3.0.2')], { probe: async () => 50 });
  assert.equal(r.length, 2);
});

test('a clearly faster proxy takes over; the old connection is closed later, not mid-request', async () => {
  process.env.TELEGRAM_PROXY_FOUND_FILE = path.join(os.tmpdir(), 'nb-none.txt');
  process.env.TELEGRAM_PROXY_LINKS = [link('10.4.0.1'), link('10.4.0.2'), link('10.4.0.3')].join(' ');
  const speed = { '10.4.0.1': 900, '10.4.0.2': 120, '10.4.0.3': 600 };
  _resetProxyMaintenanceForTests();
  const tc = await import('./telegramClient.js');
  const made = [];
  tc._setConnectRouteForTests(async (p) => {
    const c = { name: p.ip, destroyed: false, addEventHandler() {}, async destroy() { this.destroyed = true; } };
    made.push(c);
    return c;
  }, null);
  const first = await tc.getTelegramClient();
  assert.equal(first.name, '10.4.0.1');
  const report = await proxyCheck({ probe: async (p) => speed[p.ip], fetchLinks: async () => [] });
  assert.equal(report.switched, true);
  assert.equal((await tc.getTelegramClient()).name, '10.4.0.2');
  assert.equal(first.destroyed, false, 'old connection left to finish its requests');
  tc._setConnectRouteForTests(null, null);
  delete process.env.TELEGRAM_PROXY_FOUND_FILE;
  delete process.env.TELEGRAM_PROXY_LINKS;
});
