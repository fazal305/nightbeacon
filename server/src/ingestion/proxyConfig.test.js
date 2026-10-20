import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProxyConfig, normalizeMtproxySecret, parseMtproxySecret, describeProxy, parseProxyLink, buildProxyCandidates } from './proxyConfig.js';

const HEX16 = '0123456789abcdef0123456789abcdef';

test('no proxy configured -> direct connection', () => {
  assert.equal(buildProxyConfig({}), undefined);
});

test('SOCKS5 proxy', () => {
  const p = buildProxyConfig({ TELEGRAM_PROXY_IP: '10.0.0.1', TELEGRAM_PROXY_PORT: '1080' });
  assert.deepEqual(p, { ip: '10.0.0.1', port: 1080, socksType: 5, username: undefined, password: undefined });
  assert.equal(describeProxy(p), 'SOCKS5 10.0.0.1:1080');
});

test('MTProxy with plain and dd-prefixed secrets', () => {
  assert.equal(normalizeMtproxySecret(HEX16.toUpperCase()), HEX16);
  assert.equal(normalizeMtproxySecret(`dd${HEX16}`), `dd${HEX16}`);
  const p = buildProxyConfig({ TELEGRAM_PROXY_IP: 'p.example', TELEGRAM_PROXY_PORT: '443', TELEGRAM_PROXY_SECRET: HEX16 });
  assert.equal(p.MTProxy, true);
  assert.ok(!describeProxy(p).includes(HEX16), 'secret never appears in logs');
});

test('MTProxy base64url secret is converted to hex', () => {
  const b64 = Buffer.from(HEX16, 'hex').toString('base64url');
  assert.equal(normalizeMtproxySecret(b64), HEX16);
});

test('Fake-TLS (ee) secrets: key and SNI domain are split out, hex or base64', () => {
  const ee = `ee${HEX16}${Buffer.from('www.google.com').toString('hex')}`;
  const p = buildProxyConfig({ TELEGRAM_PROXY_IP: 'p.example', TELEGRAM_PROXY_PORT: '443', TELEGRAM_PROXY_SECRET: ee });
  assert.equal(p.secret, HEX16);
  assert.equal(p.fakeTlsDomain, 'www.google.com');
  assert.equal(p.MTProxy, true);
  assert.equal(describeProxy(p), 'MTProxy (Fake-TLS, SNI www.google.com) p.example:443');
  assert.deepEqual(parseMtproxySecret(Buffer.from(ee, 'hex').toString('base64url')), parseMtproxySecret(ee));
});

test('Fake-TLS secret with a garbage domain part is rejected', () => {
  assert.throws(() => parseMtproxySecret(`ee${HEX16}00ff10`), /not a hostname/);
});

test('invalid port rejected', () => {
  assert.throws(() => buildProxyConfig({ TELEGRAM_PROXY_IP: 'x', TELEGRAM_PROXY_PORT: 'abc' }), /valid port/);
});

test('proxy share links: t.me/proxy, tg://proxy and t.me/socks', () => {
  const ee = `ee${HEX16}${Buffer.from('www.vtb.ru').toString('hex')}`;
  const a = parseProxyLink(`https://t.me/proxy?server=mtproto.online&port=443&secret=${ee}`);
  assert.equal(describeProxy(a), 'MTProxy (Fake-TLS, SNI www.vtb.ru) mtproto.online:443');
  const b = parseProxyLink('tg://proxy?server=65.109.98.231&port=443&secret=3XnnAQIAAQAH8AMDhuJMOt0');
  assert.ok(b.secret.startsWith('dd'), 'base64 dd secret');
  const c = parseProxyLink('https://t.me/socks?server=10.0.0.1&port=1080&user=u&pass=p');
  assert.equal(describeProxy(c), 'SOCKS5 10.0.0.1:1080');
  assert.equal(c.username, 'u');
  assert.throws(() => parseProxyLink('https://example.com/'), /not a t.me\/proxy/);
});

test('route list: single proxy first, then links (file + inline), deduped, bad links skipped', () => {
  const warnings = [];
  const link = (ip) => `https://t.me/proxy?server=${ip}&port=443&secret=dd${HEX16}`;
  const routes = buildProxyCandidates(
    {
      TELEGRAM_PROXY_IP: '9.9.9.9',
      TELEGRAM_PROXY_PORT: '1080',
      TELEGRAM_PROXY_LINKS: `${link('1.1.1.1')}, not-a-link`,
      TELEGRAM_PROXY_LINKS_FILE: 'proxies.txt',
    },
    { readFile: () => `# my list\n${link('2.2.2.2')}\n${link('1.1.1.1')}\n`, warn: (m) => warnings.push(m) }
  );
  assert.deepEqual(routes.map((r) => r.ip), ['9.9.9.9', '1.1.1.1', '2.2.2.2']);
  assert.equal(warnings.length, 1);
});

test('no proxy configured at all -> one direct route', () => {
  assert.deepEqual(buildProxyCandidates({}), [undefined]);
});
