'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const api = require('../erome.user.js');

/* ------------------------------------------------------------------ *
 * Tiny binary builders so the parsers are tested against real bytes
 * ------------------------------------------------------------------ */

function encodeSize(value) {
  for (let width = 1; width <= 8; width += 1) {
    const max = Math.pow(2, 7 * width) - 1;
    if (value < max) {
      const bytes = new Array(width);
      let rest = value;
      for (let i = width - 1; i >= 0; i -= 1) {
        bytes[i] = rest & 0xff;
        rest = Math.floor(rest / 256);
      }
      bytes[0] |= 0x80 >> (width - 1);
      return bytes;
    }
  }
  throw new Error('size too large');
}

function idBytes(id) {
  const bytes = [];
  let rest = id;
  while (rest > 0) {
    bytes.unshift(rest & 0xff);
    rest = Math.floor(rest / 256);
  }
  return bytes;
}

function element(id, payload) {
  return [...idBytes(id), ...encodeSize(payload.length), ...payload];
}

function uintBytes(value, width) {
  const bytes = new Array(width);
  let rest = value;
  for (let i = width - 1; i >= 0; i -= 1) {
    bytes[i] = rest & 0xff;
    rest = Math.floor(rest / 256);
  }
  return bytes;
}

function float64(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeDoubleBE(value, 0);
  return [...buffer];
}

function float32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeFloatBE(value, 0);
  return [...buffer];
}

function webmBytes({ ticks, scale, floatWidth = 8 }) {
  const info = element(0x1549a966, [
    ...element(0x2ad7b1, uintBytes(scale, 3)),
    ...element(0x4489, floatWidth === 4 ? float32(ticks) : float64(ticks)),
  ]);
  const header = element(0x1a45dfa3, element(0x4286, uintBytes(1, 1)));
  const cluster = element(0x1f43b675, [0x00, 0x00, 0x00, 0x00]);
  const segment = element(0x18538067, [...info, ...cluster]);
  return new Uint8Array([...header, ...segment]);
}

function box(type, payload) {
  const size = 8 + payload.length;
  return [...uintBytes(size, 4), ...[...type].map((c) => c.charCodeAt(0)), ...payload];
}

function mvhd({ version = 0, timescale, duration }) {
  const body = version === 1
    ? [
      version, 0, 0, 0,
      ...new Array(16).fill(0),
      ...uintBytes(timescale, 4),
      ...uintBytes(Math.floor(duration / 4294967296), 4),
      ...uintBytes(duration % 4294967296, 4),
      ...new Array(80).fill(0),
    ]
    : [
      version, 0, 0, 0,
      ...new Array(8).fill(0),
      ...uintBytes(timescale, 4),
      ...uintBytes(duration, 4),
      ...new Array(80).fill(0),
    ];
  return box('mvhd', body);
}

function mp4Bytes({ timescale = 1000, duration = 1000, version = 0, extraBoxes = [] } = {}) {
  const ftyp = box('ftyp', [...[...'isom'].map((c) => c.charCodeAt(0)), ...uintBytes(512, 4), ...'isomiso2'.split('').map((c) => c.charCodeAt(0))]);
  const moov = box('moov', [...mvhd({ version, timescale, duration }), ...extraBoxes]);
  return new Uint8Array([...ftyp, ...moov]);
}

/* ------------------------------------------------------------------ *
 * formatDuration
 * ------------------------------------------------------------------ */

test('formatDuration renders mm:ss and h:mm:ss', () => {
  assert.equal(api.formatDuration(0), '0:00');
  assert.equal(api.formatDuration(1000), '0:01');
  assert.equal(api.formatDuration(61000), '1:01');
  assert.equal(api.formatDuration(3600000), '1:00:00');
  assert.equal(api.formatDuration(3723000), '1:02:03');
  assert.equal(api.formatDuration(59999), '0:59');
});

test('formatDuration rejects junk instead of printing NaN', () => {
  assert.equal(api.formatDuration(NaN), '');
  assert.equal(api.formatDuration(-1), '');
  assert.equal(api.formatDuration(Infinity), '');
  assert.equal(api.formatDuration('60000'), '');
  assert.equal(api.formatDuration(null), '');
});

/* ------------------------------------------------------------------ *
 * WebM / Matroska
 * ------------------------------------------------------------------ */

test('reads a float64 Duration with the default 1ms timecode scale', () => {
  const bytes = webmBytes({ ticks: 5000, scale: 1000000 });
  assert.equal(api.parseDurationBytes(bytes), 5000);
});

test('reads a float32 Duration', () => {
  const bytes = webmBytes({ ticks: 12000, scale: 1000000, floatWidth: 4 });
  assert.equal(api.parseDurationBytes(bytes), 12000);
});

test('applies a non-default TimecodeScale', () => {
  // 65000 ticks of 0.1 ms each = 6500 ms
  const bytes = webmBytes({ ticks: 65000, scale: 100000 });
  assert.equal(api.parseDurationBytes(bytes), 6500);
});

test('ignores Cluster contents and still finds Info', () => {
  const bytes = webmBytes({ ticks: 42000, scale: 1000000 });
  assert.equal(api.parseDurationBytes(bytes), 42000);
});

test('returns null when the header is truncated before Duration', () => {
  const bytes = webmBytes({ ticks: 5000, scale: 1000000 });
  assert.equal(api.parseDurationBytes(bytes.slice(0, 12)), null);
});

test('readVint decodes widths and flags unknown sizes', () => {
  assert.deepEqual(api.readVint(new Uint8Array([0x81]), 0), { value: 1, width: 1, unknown: false });
  assert.deepEqual(api.readVint(new Uint8Array([0x40, 0x01]), 0), { value: 1, width: 2, unknown: false });
  assert.equal(api.readVint(new Uint8Array([0xff]), 0).unknown, true);
  assert.equal(api.readVint(new Uint8Array([0x00]), 0), null);
});

/* ------------------------------------------------------------------ *
 * MP4
 * ------------------------------------------------------------------ */

test('reads mvhd version 0', () => {
  const bytes = mp4Bytes({ timescale: 1000, duration: 65432 });
  assert.equal(api.parseDurationBytes(bytes), 65432);
});

test('reads mvhd version 1', () => {
  const bytes = mp4Bytes({ timescale: 90000, duration: 900000, version: 1 });
  assert.equal(api.parseDurationBytes(bytes), 10000);
});

test('finds moov that sits after mdat in a tail window', () => {
  const mdat = box('mdat', new Array(64).fill(0));
  // 6000 ticks at 1000 ticks/second = 6 seconds
  const moov = box('moov', mvhd({ version: 0, timescale: 1000, duration: 6000 }));
  const tail = new Uint8Array([...mdat, ...moov]);
  assert.equal(api.parseMp4Duration(tail), 6000);
});

test('returns null for an mp4 whose mvhd payload is truncated', () => {
  const full = mp4Bytes({ timescale: 1000, duration: 5000 });
  // Cut into the mvhd body so timescale/duration are not yet present.
  assert.equal(api.parseMp4Duration(full.slice(0, full.length - 100)), null);
});

test('sniffContainer distinguishes webm from mp4', () => {
  assert.equal(api.sniffContainer(webmBytes({ ticks: 1, scale: 1000000 })), 'webm');
  assert.equal(api.sniffContainer(mp4Bytes()), 'mp4');
  assert.equal(api.sniffContainer(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), null);
});

test('binary garbage never throws', () => {
  const junk = new Uint8Array(2048);
  for (let i = 0; i < junk.length; i += 1) {
    junk[i] = (i * 37) % 256;
  }
  assert.equal(api.parseDurationBytes(junk), null);
  assert.equal(api.parseDurationBytes(new Uint8Array(0)), null);
});

/* ------------------------------------------------------------------ *
 * Hash state
 * ------------------------------------------------------------------ */

test('parseHash reads the onlyvideos count', () => {
  assert.deepEqual(api.parseHash('#onlyvideos=3'), { onlyVideos: 3 });
  assert.deepEqual(api.parseHash('#foo=1&onlyvideos=2'), { onlyVideos: 2 });
  assert.deepEqual(api.parseHash(''), { onlyVideos: null });
  assert.deepEqual(api.parseHash('#onlyvideos=0'), { onlyVideos: null });
  assert.deepEqual(api.parseHash('#onlyvideos=abc'), { onlyVideos: null });
});

test('buildHash round-trips through parseHash', () => {
  assert.equal(api.buildHash(0), '');
  assert.deepEqual(api.parseHash(api.buildHash(4)), { onlyVideos: 4 });
});

/* ------------------------------------------------------------------ *
 * Cache
 * ------------------------------------------------------------------ */

function fakeStorage(limit = Infinity) {
  const map = new Map();
  return {
    map,
    get length() {
      return map.size;
    },
    key(index) {
      return Array.from(map.keys())[index] ?? null;
    },
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      if (String(value).length > limit) {
        throw new Error('QuotaExceededError');
      }
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

test('store round-trips durations', () => {
  const store = api.createStore(fakeStorage());
  store.setDuration('https://example/a.mp4', 12345);
  assert.equal(store.getDuration('https://example/a.mp4'), 12345);
  assert.equal(store.getDuration('https://example/missing.mp4'), null);
});

test('store expires entries older than the ttl', () => {
  const storage = fakeStorage();
  const store = api.createStore(storage, { ttl: 1000 });
  storage.setItem('$vl2#old', JSON.stringify({ v: 5000, t: Date.now() - 5000 }));
  assert.equal(store.getDuration('old'), null);
  assert.equal(storage.getItem('$vl2#old'), null);
});

test('store drops corrupt entries instead of throwing', () => {
  const storage = fakeStorage();
  const store = api.createStore(storage);
  storage.setItem('$vl2#broken', '{not json');
  assert.equal(store.getDuration('broken'), null);
  assert.equal(storage.getItem('$vl2#broken'), null);
});

test('store prunes the oldest half when it grows past the cap', () => {
  const storage = fakeStorage();
  const store = api.createStore(storage, { maxEntries: 6 });
  for (let i = 0; i < 12; i += 1) {
    storage.setItem(`$vl2#u${i}`, JSON.stringify({ v: 1000 + i, t: 1000 + i }));
  }
  store.prune();
  assert.ok(store.keys().length <= 6, `expected <= 6 keys, got ${store.keys().length}`);
});

test('store survives storage quota errors and keeps serving from memory', () => {
  const storage = fakeStorage(20);
  const store = api.createStore(storage);
  store.setDuration('https://example/long-url.mp4', 9999);
  assert.equal(store.getDuration('https://example/long-url.mp4'), 9999);
});

test('config is stored and never mistaken for a duration', () => {
  const storage = fakeStorage();
  const store = api.createStore(storage);
  store.setConfig({ minSeconds: 30, onlyVideos: 2, privateMode: true });
  store.setDuration('url', 1000);
  store.prune(true);
  assert.deepEqual(store.getConfig(), { minSeconds: 30, onlyVideos: 2, privateMode: true });
  assert.equal(store.getDuration('url'), 1000);
});

test('clear removes cached durations but not configuration', () => {
  const storage = fakeStorage();
  const store = api.createStore(storage);
  store.setConfig({ minSeconds: 5 });
  store.setDuration('a', 1000);
  store.setDuration('b', 2000);
  store.clear();
  assert.deepEqual(store.keys(), []);
  assert.deepEqual(store.getConfig(), { minSeconds: 5 });
});

/* ------------------------------------------------------------------ *
 * Network orchestration (GM stub)
 * ------------------------------------------------------------------ */

function installGm(handler) {
  const calls = [];
  globalThis.GM = {
    xmlHttpRequest(options) {
      calls.push(options);
      handler(options, calls.length);
      return { abort() {} };
    },
  };
  return calls;
}

function bytesResponse(bytes) {
  return {
    status: 206,
    response: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

test('resolveDuration uses the cache without a network call', async () => {
  const store = api.createStore(fakeStorage());
  store.setDuration('https://cdn.example/v.webm', 7000);
  const calls = installGm(() => {
    throw new Error('network should not be hit');
  });
  assert.equal(await api.resolveDuration('https://cdn.example/v.webm', store), 7000);
  assert.equal(calls.length, 0);
  delete globalThis.GM;
});

test('resolveDuration reads a webm header and caches the result', async () => {
  const store = api.createStore(fakeStorage());
  const calls = installGm((options) => options.onload(bytesResponse(webmBytes({ ticks: 30000, scale: 1000000 }))));
  const duration = await api.resolveDuration('https://cdn.example/v.webm', store);
  assert.equal(duration, 30000);
  assert.match(calls[0].headers.Range, /^bytes=0-\d+$/);
  assert.equal(store.getDuration('https://cdn.example/v.webm'), 30000);
  assert.equal(await api.resolveDuration('https://cdn.example/v.webm', store), 30000);
  assert.equal(calls.length, 1);
  delete globalThis.GM;
});

test('resolveDuration falls back to the tail when moov is not in the head', async () => {
  const store = api.createStore(fakeStorage());
  const head = mp4Bytes({ timescale: 1000, duration: 9000 });
  // Pretend the head window only contained ftyp: strip moov.
  const ftypOnly = head.slice(0, 24);
  const tail = new Uint8Array(mp4Bytes({ timescale: 1000, duration: 9000 }));
  const calls = installGm((options, n) => {
    options.onload(bytesResponse(n === 1 ? ftypOnly : tail));
  });
  assert.equal(await api.resolveDuration('https://cdn.example/v.mp4', store), 9000);
  assert.equal(calls.length, 2);
  assert.match(calls[1].headers.Range, /^bytes=-\d+$/);
  delete globalThis.GM;
});

test('resolveDuration forwards privacy headers', async () => {
  const store = api.createStore(fakeStorage());
  const calls = installGm((options) => options.onload(bytesResponse(webmBytes({ ticks: 1000, scale: 1000000 }))));
  await api.resolveDuration('https://cdn.example/p.webm', store, { 'Sec-GPC': '1', DNT: '1' });
  assert.equal(calls[0].headers['Sec-GPC'], '1');
  delete globalThis.GM;
});

test('resolveDuration swallows network failures', async () => {
  const store = api.createStore(fakeStorage());
  installGm((options) => options.onerror && options.onerror());
  assert.equal(await api.resolveDuration('https://cdn.example/down.webm', store), null);
  assert.equal(store.getDuration('https://cdn.example/down.webm'), null);
  delete globalThis.GM;
});

test('resolveDuration reports null when GM is missing', async () => {
  delete globalThis.GM;
  const store = api.createStore(fakeStorage());
  assert.equal(await api.resolveDuration('https://cdn.example/x.webm', store), null);
});

/* ------------------------------------------------------------------ *
 * Script metadata hygiene
 * ------------------------------------------------------------------ */

test('userscript metadata stays consistent with package.json', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const script = fs.readFileSync(path.join(__dirname, '..', 'erome.user.js'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

  const version = /@version\s+(\S+)/.exec(script);
  assert.ok(version, 'metadata block must declare @version');
  assert.equal(version[1], pkg.version);
  assert.match(script, /@match\s+https:\/\/www\.erome\.com\/\*/);
  assert.match(script, /@grant\s+GM\.xmlHttpRequest/);
  assert.match(script, /'use strict';/);
});

test('the script never injects HTML strings', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const script = fs.readFileSync(path.join(__dirname, '..', 'erome.user.js'), 'utf8');
  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

test('a WebM header that is truncated in the first window is retried wider', async () => {
  const store = api.createStore(fakeStorage());
  const full = webmBytes({ ticks: 44000, scale: 1000000 });
  // Cut before Info so the first window cannot yield a duration.
  const truncated = full.slice(0, 16);
  const calls = installGm((options, n) => {
    options.onload(bytesResponse(n === 1 ? truncated : full));
  });
  assert.equal(await api.resolveDuration('https://cdn.example/big.webm', store), 44000);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers.Range, `bytes=0-${api.MAX_HEAD_BYTES}`);
  assert.equal(calls[1].headers.Range, `bytes=0-${2 * 1024 * 1024 - 1}`);
  delete globalThis.GM;
});
