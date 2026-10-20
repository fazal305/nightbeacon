import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { PromisedNetSockets, Logger } from 'telegram/extensions/index.js';
import {
  buildClientHello,
  signClientHello,
  stripPadding,
  applyProxyTransport,
  ConnectionTCPMTProxyFakeTLS,
} from './fakeTlsConnection.js';
import { buildProxyConfig } from './proxyConfig.js';

// The transport was verified end-to-end against two independent Fake-TLS
// proxy servers (alexbers/mtprotoproxy and 9seconds/mtg v2.2.8 — see
// docs/PIPELINE.md). These tests keep it honest in CI without them: the
// in-process server below is a direct port of mtprotoproxy's server-side
// handshake (handle_fake_tls_handshake / FakeTLSStreamReader) and of the
// obfuscated2 server handshake.

const DOMAIN = 'www.cloudflare.com';

function walkClientHello(rec) {
  assert.deepEqual([...rec.subarray(0, 3)], [0x16, 3, 1], 'TLS handshake record');
  assert.equal(rec.readUInt16BE(3), rec.length - 5, 'record length');
  assert.equal(rec[5], 1, 'ClientHello');
  assert.equal(rec.readUIntBE(6, 3), rec.length - 9, 'handshake length');
  let p = 9 + 2 + 32;
  const sidLen = rec[p];
  p += 1 + sidLen;
  p += 2 + rec.readUInt16BE(p); // cipher suites
  p += 1 + rec[p]; // compression
  const extEnd = p + 2 + rec.readUInt16BE(p);
  assert.equal(extEnd, rec.length, 'extensions length');
  p += 2;
  const exts = new Map();
  while (p < extEnd) {
    const type = rec.readUInt16BE(p);
    const len = rec.readUInt16BE(p + 2);
    exts.set(type, rec.subarray(p + 4, p + 4 + len));
    p += 4 + len;
  }
  assert.equal(p, extEnd, 'extensions parse exactly');
  return { sidLen, exts };
}

test('ClientHello: well-formed 517-byte TLS record with the SNI from the secret', () => {
  const hello = buildClientHello(DOMAIN);
  assert.equal(hello.length, 517);
  const { sidLen, exts } = walkClientHello(hello);
  assert.equal(sidLen, 32);
  const sni = exts.get(0x0000);
  assert.equal(sni.subarray(5).toString(), DOMAIN);
  assert.ok(exts.has(0x0033), 'key_share');
  assert.ok(exts.has(0x002b), 'supported_versions');
  assert.ok(hello.subarray(11, 43).equals(Buffer.alloc(32)), 'random zeroed before signing');
});

test('ClientHello random authenticates the client the way proxies check it', () => {
  const key = crypto.randomBytes(16);
  const hello = buildClientHello(DOMAIN);
  const now = Math.floor(Date.now() / 1000);
  signClientHello(hello, key, now);

  // mtprotoproxy: digest XOR HMAC(hello with zeroed random) = 28 zero bytes + timestamp
  const msg = Buffer.from(hello);
  msg.fill(0, 11, 43);
  const computed = crypto.createHmac('sha256', key).update(msg).digest();
  const xored = Buffer.from(hello.subarray(11, 43).map((b, i) => b ^ computed[i]));
  assert.ok(xored.subarray(0, 28).equals(Buffer.alloc(28)));
  assert.equal(xored.readUInt32LE(28), now);
});

// --- in-process Fake-TLS MTProxy (port of mtprotoproxy) + echo "DC" -------
function startFakeTlsProxy(key) {
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let state = 'hello';
    let dec, enc, plain = Buffer.alloc(0);
    sock.on('error', () => {});
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (state === 'hello') {
        if (buf.length < 5) return;
        const len = buf.readUInt16BE(3);
        if (buf.length < 5 + len) return;
        const hs = buf.subarray(0, 5 + len);
        buf = buf.subarray(5 + len);
        const digest = hs.subarray(11, 43);
        const msg = Buffer.from(hs);
        msg.fill(0, 11, 43);
        const computed = crypto.createHmac('sha256', key).update(msg).digest();
        const xored = Buffer.from(digest.map((b, i) => b ^ computed[i]));
        const ts = xored.readUInt32LE(28);
        if (!xored.subarray(0, 28).equals(Buffer.alloc(28)) || Math.abs(Date.now() / 1000 - ts) > 5) {
          sock.destroy(); // like a real proxy: unauthenticated clients just get dropped
          return;
        }
        const sessId = hs.subarray(44, 44 + hs[43]);
        const exts = Buffer.concat([Buffer.from('002e00330024001d0020', 'hex'), crypto.randomBytes(32), Buffer.from('002b00020304', 'hex')]);
        const srvHello = Buffer.concat([Buffer.from([3, 3]), Buffer.alloc(32), Buffer.from([sessId.length]), sessId, Buffer.from([0x13, 0x01, 0]), exts]);
        const http = crypto.randomBytes(1500);
        const len2 = (n) => Buffer.from([n >> 8, n & 0xff]);
        const pkt = Buffer.concat([
          Buffer.from([0x16, 3, 3]), len2(srvHello.length + 4), Buffer.from([2, 0]), len2(srvHello.length), srvHello,
          Buffer.from('140303000101', 'hex'), Buffer.from([0x17, 3, 3]), len2(http.length), http,
        ]);
        crypto.createHmac('sha256', key).update(digest).update(pkt).digest().copy(pkt, 11);
        sock.write(pkt);
        state = 'records';
      }
      // FakeTLSStreamReader: skip ChangeCipherSpec, unwrap ApplicationData
      while (state !== 'hello' && buf.length >= 5 && buf.length >= 5 + buf.readUInt16BE(3)) {
        const type = buf[0];
        const body = buf.subarray(5, 5 + buf.readUInt16BE(3));
        buf = buf.subarray(5 + body.length);
        if (type === 0x14) continue;
        assert.equal(type, 0x17);
        if (!dec) {
          // obfuscated2 server side (with secret); header is the first 64 bytes
          plain = Buffer.concat([plain, body]);
          if (plain.length < 64) continue;
          const h = plain.subarray(0, 64);
          const rev = Buffer.from(h.subarray(8, 56)).reverse();
          const sha = (a) => crypto.createHash('sha256').update(Buffer.concat([a, key])).digest();
          dec = crypto.createDecipheriv('aes-256-ctr', sha(h.subarray(8, 40)), h.subarray(40, 56));
          enc = crypto.createCipheriv('aes-256-ctr', sha(rev.subarray(0, 32)), rev.subarray(32, 48));
          const ph = dec.update(h);
          server.lastTag = ph.readUInt32LE(56);
          server.lastDc = ph.readInt16LE(60);
          plain = dec.update(plain.subarray(64));
        } else {
          plain = Buffer.concat([plain, dec.update(body)]);
        }
        // padded intermediate: echo each frame back (padding included)
        while (plain.length >= 4 && plain.length >= 4 + plain.readInt32LE(0)) {
          const frame = plain.subarray(0, 4 + plain.readInt32LE(0));
          plain = plain.subarray(frame.length);
          const out = enc.update(frame);
          for (let i = 0; i < out.length; i += 16384) {
            const chunk = out.subarray(i, i + 16384);
            sock.write(Buffer.concat([Buffer.from([0x17, 3, 3, chunk.length >> 8, chunk.length & 0xff]), chunk]));
          }
        }
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function connectionFor(port, keyHex) {
  const proxy = buildProxyConfig({
    TELEGRAM_PROXY_IP: '127.0.0.1',
    TELEGRAM_PROXY_PORT: String(port),
    TELEGRAM_PROXY_SECRET: `ee${keyHex}${Buffer.from(DOMAIN).toString('hex')}`,
  });
  return new ConnectionTCPMTProxyFakeTLS({
    ip: '149.154.167.51', port: 443, dcId: 2, loggers: new Logger('error'), proxy, socket: PromisedNetSockets, testServers: false,
  });
}

test('Fake-TLS round trip through a proxy: handshake verified, packets of every size survive intact', async () => {
  const key = crypto.randomBytes(16);
  const server = await startFakeTlsProxy(key);
  const conn = connectionFor(server.address().port, key.toString('hex'));
  try {
    await conn.connect();
    for (const size of [20, 300, 40000]) {
      const pkt = Buffer.concat([Buffer.alloc(8), crypto.randomBytes(8), Buffer.from(Int32Array.of(size).buffer), crypto.randomBytes(size)]);
      await conn.send(pkt);
      assert.ok((await conn.recv()).equals(pkt), `${size}-byte packet`);
    }
    assert.equal(server.lastTag, 0xdddddddd, 'secure (padded intermediate) protocol tag');
    assert.equal(server.lastDc, 2);
  } finally {
    await conn.disconnect();
    server.close();
  }
});

test('Fake-TLS with the wrong secret fails with an actionable error', async () => {
  const server = await startFakeTlsProxy(crypto.randomBytes(16));
  const conn = connectionFor(server.address().port, crypto.randomBytes(16).toString('hex'));
  try {
    await assert.rejects(conn.connect(), /Fake-TLS MTProxy: .*wrong TELEGRAM_PROXY_SECRET/);
  } finally {
    server.close();
  }
});

test('stripPadding recovers the exact MTProto packet', () => {
  const enc = Buffer.concat([crypto.randomBytes(8), crypto.randomBytes(16), crypto.randomBytes(64)]);
  enc[0] |= 1; // non-zero auth_key_id
  for (let pad = 0; pad < 16; pad++) {
    assert.ok(stripPadding(Buffer.concat([enc, crypto.randomBytes(pad)])).equals(enc), `encrypted, pad ${pad}`);
  }
  const plain = Buffer.concat([Buffer.alloc(8), crypto.randomBytes(8), Buffer.from(Int32Array.of(12).buffer), crypto.randomBytes(12)]);
  assert.ok(stripPadding(Buffer.concat([plain, crypto.randomBytes(13)])).equals(plain), 'unencrypted');
  const transportError = Buffer.from(Int32Array.of(-404).buffer);
  assert.ok(stripPadding(transportError).equals(transportError), '4-byte transport error code untouched');
});

test('TelegramClient uses the Fake-TLS transport for an ee secret, GramJS defaults otherwise', () => {
  const key = '0123456789abcdef0123456789abcdef';
  const fake = buildProxyConfig({ TELEGRAM_PROXY_IP: '1.2.3.4', TELEGRAM_PROXY_PORT: '443', TELEGRAM_PROXY_SECRET: `ee${key}${Buffer.from(DOMAIN).toString('hex')}` });
  const c1 = new TelegramClient(new StringSession(''), 1, 'x', { proxy: fake });
  applyProxyTransport(c1, fake);
  assert.equal(c1._connection, ConnectionTCPMTProxyFakeTLS);

  const plain = buildProxyConfig({ TELEGRAM_PROXY_IP: '1.2.3.4', TELEGRAM_PROXY_PORT: '443', TELEGRAM_PROXY_SECRET: `dd${key}` });
  const c2 = new TelegramClient(new StringSession(''), 1, 'x', { proxy: plain });
  const before = c2._connection;
  applyProxyTransport(c2, plain);
  assert.equal(c2._connection, before);
});
