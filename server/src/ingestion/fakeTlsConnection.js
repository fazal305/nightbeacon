import crypto from 'node:crypto';
// Load GramJS's entry point first: its internal modules import each other in a
// cycle that only resolves when evaluation starts from the package root.
// Importing Connection.js first fails with "Class extends value undefined".
import 'telegram';
import { ObfuscatedConnection, PacketCodec } from 'telegram/network/connection/Connection.js';

// MTProxy Fake-TLS ("ee" secret) transport for GramJS.
//
// GramJS 2.26.22 (the latest release) only implements plain and "dd" MTProxy
// secrets. Fake-TLS proxies wrap the MTProto obfuscated2 stream inside
// something that looks like a TLS 1.3 session to DPI, which is why they are
// the ones that keep working on restrictive networks. Protocol, as
// implemented by Telegram's own clients (tdlib) and proxies (mtg,
// mtprotoproxy):
//
//  1. Client sends a TLS ClientHello whose 32-byte "random" field is
//     HMAC-SHA256(key, hello-with-zeroed-random), last 4 bytes XORed with the
//     current unix time (so the proxy can authenticate the client and reject
//     replays). SNI = the domain embedded in the secret.
//  2. Proxy answers ServerHello + ChangeCipherSpec + one ApplicationData
//     record; its "random" is HMAC-SHA256(key, client random + response with
//     zeroed random). We verify it — a mismatch means a wrong secret, or
//     something other than the proxy answering.
//  3. Everything afterwards is obfuscated2 (the same AES-256-CTR stream as
//     ordinary MTProxy, "secure"/padded-intermediate transport) carried in
//     TLS ApplicationData records.
//
// Verified end-to-end against independent proxy implementations — see
// docs/PIPELINE.md ("Telegram access through a Fake-TLS MTProxy").

const TLS_HELLO_LENGTH = 517; // what Chrome/tdlib send; padding fills the rest
const MAX_RECORD_PAYLOAD = 16384;
const CHANGE_CIPHER_SPEC = Buffer.from('140303000101', 'hex');
const SECURE_TAG = 0xdddddddd; // padded intermediate, required by Fake-TLS proxies

const u16 = (n) => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
const u24 = (n) => Buffer.from([(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
const ext = (type, body) => Buffer.concat([u16(type), u16(body.length), body]);
const list16 = (values) => Buffer.concat(values.map(u16));

// GREASE values (RFC 8701), as browsers send them — a hello without them is
// easy for DPI to tell apart from Chrome.
function greaseValues(count) {
  const out = [];
  while (out.length < count) {
    const b = crypto.randomInt(16);
    const v = (b << 12) | 0x0a00 | (b << 4) | 0x0a;
    if (out.length % 2 === 1 && out[out.length - 1] === v) continue; // tdlib keeps pairs distinct
    out.push(v);
  }
  return out;
}

function x25519PublicKey() {
  const { publicKey } = crypto.generateKeyPairSync('x25519');
  return publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
}

// Builds the ClientHello record with a zeroed random field (offset 11).
export function buildClientHello(domain) {
  const g = greaseValues(7);
  const host = Buffer.from(domain, 'ascii');

  const extensions = [
    ext(g[2], Buffer.alloc(0)),
    ext(0x0000, Buffer.concat([u16(host.length + 3), Buffer.from([0]), u16(host.length), host])), // server_name
    ext(0x0017, Buffer.alloc(0)), // extended_master_secret
    ext(0xff01, Buffer.from([0])), // renegotiation_info
    ext(0x000a, Buffer.concat([u16(8), list16([g[4], 0x001d, 0x0017, 0x0018])])), // supported_groups
    ext(0x000b, Buffer.from([1, 0])), // ec_point_formats
    ext(0x0023, Buffer.alloc(0)), // session_ticket
    ext(0x0010, Buffer.from('000c02683208687474702f312e31', 'hex')), // ALPN: h2, http/1.1
    ext(0x0005, Buffer.from([1, 0, 0, 0, 0])), // status_request
    ext(0x000d, Buffer.concat([u16(16), list16([0x0403, 0x0804, 0x0401, 0x0503, 0x0805, 0x0501, 0x0806, 0x0601])])),
    ext(0x0012, Buffer.alloc(0)), // signed_certificate_timestamp
    ext(
      0x0033, // key_share: GREASE + x25519
      (() => {
        const shares = Buffer.concat([u16(g[4]), u16(1), Buffer.from([0]), u16(0x001d), u16(32), x25519PublicKey()]);
        return Buffer.concat([u16(shares.length), shares]);
      })()
    ),
    ext(0x002d, Buffer.from([1, 1])), // psk_key_exchange_modes
    ext(0x002b, Buffer.concat([Buffer.from([10]), list16([g[6], 0x0304, 0x0303, 0x0302, 0x0301])])), // supported_versions
    ext(0x001b, Buffer.from([2, 0, 2])), // compress_certificate
    ext(g[3], Buffer.from([0])),
  ];

  const ciphers = [g[0], 0x1301, 0x1302, 0x1303, 0xc02b, 0xc02f, 0xc02c, 0xc030, 0xcca9, 0xcca8, 0xc013, 0xc014, 0x009c, 0x009d, 0x002f, 0x0035];
  const head = Buffer.concat([
    Buffer.from([3, 3]),
    Buffer.alloc(32), // random — filled in after signing
    Buffer.from([32]),
    crypto.randomBytes(32), // session id
    u16(ciphers.length * 2),
    list16(ciphers),
    Buffer.from([1, 0]), // compression: null
  ]);

  let extBytes = Buffer.concat(extensions);
  // record(5) + handshake header(4) + head + ext length(2) + extensions + padding ext header(4)
  const unpadded = 5 + 4 + head.length + 2 + extBytes.length + 4;
  if (unpadded <= TLS_HELLO_LENGTH) {
    extBytes = Buffer.concat([extBytes, ext(0x0015, Buffer.alloc(TLS_HELLO_LENGTH - unpadded))]);
  }

  const body = Buffer.concat([head, u16(extBytes.length), extBytes]);
  const handshake = Buffer.concat([Buffer.from([1]), u24(body.length), body]);
  return Buffer.concat([Buffer.from([0x16, 3, 1]), u16(handshake.length), handshake]);
}

const hmac = (key, ...parts) => {
  const h = crypto.createHmac('sha256', key);
  for (const p of parts) h.update(p);
  return h.digest();
};

// Fills in the authenticated random field: HMAC with its last 4 bytes XORed
// with the unix timestamp (little-endian), as the proxy expects.
export function signClientHello(hello, key, unixTime = Math.floor(Date.now() / 1000)) {
  const digest = hmac(key, hello);
  digest.writeUInt32LE((digest.readUInt32LE(28) ^ unixTime) >>> 0, 28);
  digest.copy(hello, 11);
  return digest;
}

export function verifyServerHello(response, clientRandom, key) {
  const zeroed = Buffer.from(response);
  zeroed.fill(0, 11, 43);
  const expected = hmac(key, clientRandom, zeroed);
  return crypto.timingSafeEqual(expected, response.subarray(11, 43));
}

// Client side of the obfuscated2 handshake (same construction as ordinary
// MTProxy), using the "secure" protocol tag.
export function obfuscatedHeader(key, dcId) {
  let random;
  for (;;) {
    random = crypto.randomBytes(64);
    const first = random.readUInt32LE(0);
    const forbidden = [0x44414548, 0x54534f50, 0x20544547, 0x4954504f, 0xdddddddd, 0xeeeeeeee, 0x02010316];
    if (random[0] !== 0xef && !forbidden.includes(first) && random.readUInt32LE(4) !== 0) break;
  }
  random.writeUInt32LE(SECURE_TAG, 56);
  random.writeInt16LE(dcId, 60);

  const reversed = Buffer.from(random.subarray(8, 56)).reverse();
  const sha = (...b) => crypto.createHash('sha256').update(Buffer.concat(b)).digest();
  const encryptor = crypto.createCipheriv('aes-256-ctr', sha(random.subarray(8, 40), key), random.subarray(40, 56));
  const decryptor = crypto.createDecipheriv('aes-256-ctr', sha(reversed.subarray(0, 32), key), reversed.subarray(32, 48));

  const encrypted = encryptor.update(random);
  const header = Buffer.concat([random.subarray(0, 56), encrypted.subarray(56, 64)]);
  return { header, encryptor, decryptor };
}

class FakeTlsIO {
  constructor(socket, key, domain, dcId) {
    this.socket = socket;
    this.key = key;
    this.domain = domain;
    this.dcId = dcId;
    this.plain = Buffer.alloc(0);
  }

  async handshake() {
    const hello = buildClientHello(this.domain);
    const clientRandom = signClientHello(hello, this.key);
    this.socket.write(hello);

    let parts;
    try {
      parts = await this.readServerHello();
    } catch (err) {
      if (err.message.startsWith('Fake-TLS MTProxy:')) throw err;
      // Fake-TLS proxies silently drop clients they can't authenticate.
      throw new Error(
        `Fake-TLS MTProxy: proxy closed the connection during the TLS handshake (${err.message}). ` +
          'Usual causes: wrong TELEGRAM_PROXY_SECRET, this machine\'s clock is off (the proxy rejects ' +
          'timestamps more than a few seconds old — check NTP), or the proxy is down/blocked.'
      );
    }
    if (!verifyServerHello(Buffer.concat(parts), clientRandom, this.key)) {
      throw new Error('Fake-TLS MTProxy: server response is not signed with this secret (wrong TELEGRAM_PROXY_SECRET?)');
    }

    const { header, encryptor, decryptor } = obfuscatedHeader(this.key, this.dcId);
    this.encryptor = encryptor;
    this.decryptor = decryptor;
    this.socket.write(CHANGE_CIPHER_SPEC);
    this.writeRecords(header);
  }

  async readServerHello() {
    const parts = [];
    for (;;) {
      const header = await this.socket.readExactly(5);
      if (parts.length === 0 && header[0] !== 0x16) {
        throw new Error('Fake-TLS MTProxy: server did not answer with a TLS ServerHello (wrong host/port, or not a Fake-TLS proxy)');
      }
      const body = await this.socket.readExactly(header.readUInt16BE(3));
      parts.push(header, body);
      if (header[0] === 0x17) break;
      if (parts.length > 8) throw new Error('Fake-TLS MTProxy: unexpected TLS handshake from server');
    }
    return parts;
  }

  writeRecords(data) {
    for (let i = 0; i < data.length; i += MAX_RECORD_PAYLOAD) {
      const chunk = data.subarray(i, i + MAX_RECORD_PAYLOAD);
      this.socket.write(Buffer.concat([Buffer.from([0x17, 3, 3]), u16(chunk.length), chunk]));
    }
  }

  write(data) {
    this.writeRecords(this.encryptor.update(data));
  }

  async read(n) {
    while (this.plain.length < n) {
      const header = await this.socket.readExactly(5);
      const body = await this.socket.readExactly(header.readUInt16BE(3));
      if (header[0] === 0x14) continue; // ChangeCipherSpec — no payload
      if (header[0] !== 0x17) throw new Error(`Fake-TLS MTProxy: unexpected TLS record type ${header[0]}`);
      this.plain = Buffer.concat([this.plain, this.decryptor.update(body)]);
    }
    const out = this.plain.subarray(0, n);
    this.plain = this.plain.subarray(n);
    return out;
  }
}

// Strips the 0–15 random padding bytes of the padded-intermediate transport.
// The true MTProto length is recoverable from the packet itself: encrypted
// packets are auth_key_id(8) + msg_key(16) + a multiple of 16 bytes;
// unencrypted ones carry their own length at offset 16.
export function stripPadding(body) {
  let len = body.length - (body.length % 4);
  if (len >= 24 && body.readBigUInt64LE(0) !== 0n) {
    len = 24 + Math.floor((len - 24) / 16) * 16;
  } else if (len >= 20 && body.readBigUInt64LE(0) === 0n) {
    const inner = body.readInt32LE(16);
    if (inner >= 0 && 20 + inner <= len) len = 20 + inner;
  }
  return body.subarray(0, len);
}

export class PaddedIntermediatePacketCodec extends PacketCodec {
  encodePacket(data) {
    const padding = crypto.randomBytes(crypto.randomInt(16));
    const length = Buffer.alloc(4);
    length.writeInt32LE(data.length + padding.length, 0);
    return Buffer.concat([length, data, padding]);
  }

  async readPacket(reader) {
    const length = (await reader.read(4)).readInt32LE(0);
    return stripPadding(await reader.read(length));
  }
}
PaddedIntermediatePacketCodec.tag = Buffer.from('dddddddd', 'hex');
PaddedIntermediatePacketCodec.obfuscateTag = Buffer.from('dddddddd', 'hex');

export class ConnectionTCPMTProxyFakeTLS extends ObfuscatedConnection {
  constructor(params) {
    const { proxy } = params;
    super({ ...params, ip: proxy.ip, port: proxy.port });
    this.PacketCodecClass = PaddedIntermediatePacketCodec;
    this._key = Buffer.from(proxy.secret, 'hex');
    this._domain = proxy.fakeTlsDomain;
  }

  async _initConn() {
    this._obfuscation = new FakeTlsIO(this.socket, this._key, this._domain, this._dcId);
    await this._obfuscation.handshake();
  }
}

// GramJS picks its own MTProxy connection class whenever the proxy has an
// `MTProxy` key (and ignores the `connection` option), so for a Fake-TLS
// proxy the class is swapped on the client after construction. Both places
// GramJS opens connections (main sender and exported/file senders) read
// `client._connection`. Keeping `MTProxy: true` on the proxy object still
// matters: it stops GramJS treating the proxy as SOCKS and makes it send
// InputClientProxy in initConnection.
export function applyProxyTransport(client, proxy) {
  if (!proxy?.fakeTlsDomain) return;
  if (!('_connection' in client)) {
    throw new Error('Unsupported GramJS version: cannot install the Fake-TLS MTProxy transport');
  }
  client._connection = ConnectionTCPMTProxyFakeTLS;
}
