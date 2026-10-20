import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProxyConfig, normalizeMtproxySecret, describeProxy } from './proxyConfig.js';

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

test('Fake-TLS (ee) secrets are rejected at startup with an actionable message', () => {
  const ee = `ee${HEX16}${Buffer.from('www.google.com').toString('hex')}`;
  assert.throws(() => normalizeMtproxySecret(ee), /Fake-TLS/);
});

test('invalid port rejected', () => {
  assert.throws(() => buildProxyConfig({ TELEGRAM_PROXY_IP: 'x', TELEGRAM_PROXY_PORT: 'abc' }), /valid port/);
});
