'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const core = require('../app.js');

const ROOT = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

test('formatDuration pads seconds and grows to hours', () => {
  assert.equal(core.formatDuration(0), '0:00');
  assert.equal(core.formatDuration(9500), '0:09');
  assert.equal(core.formatDuration(95500), '1:35');
  assert.equal(core.formatDuration(3600000), '1:00:00');
  assert.equal(core.formatDuration(7322000), '2:02:02');
  assert.equal(core.formatDuration(-1), '');
  assert.equal(core.formatDuration(Number.NaN), '');
  assert.equal(core.formatDuration('12'), '');
});

test('formatBytes uses binary units with one decimal', () => {
  assert.equal(core.formatBytes(0), '0 B');
  assert.equal(core.formatBytes(1023), '1023 B');
  assert.equal(core.formatBytes(2048), '2.0 KB');
  assert.equal(core.formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(core.formatBytes(-5), '0 B');
  assert.equal(core.formatBytes(undefined), '0 B');
});

test('formatAge keeps a short scale', () => {
  assert.equal(core.formatAge(0), '0s');
  assert.equal(core.formatAge(59_000), '59s');
  assert.equal(core.formatAge(90_000), '1m');
  assert.equal(core.formatAge(3 * 3600_000), '3h');
  assert.equal(core.formatAge(50 * 3600_000), '2d');
  assert.equal(core.formatAge(-1), '—');
});

/* ------------------------------------------------------------------ *
 * Container parsers
 * ------------------------------------------------------------------ */

test('sniffContainer recognises EBML and ISO-BMFF', () => {
  assert.equal(core.sniffContainer(core.buildWebmFixture(10)), 'webm');
  assert.equal(core.sniffContainer(core.buildMp4Fixture(10)), 'mp4');
  assert.equal(core.sniffContainer(core.buildCorruptFixture()), null);
  assert.equal(core.sniffContainer(new Uint8Array(4)), null);
});

test('parseMp4Duration reads mvhd version 0', () => {
  const value = core.parseMp4Duration(core.buildMp4Fixture(95.5));
  assert.ok(value !== null);
  assert.ok(Math.abs(value - 95_500) < 2, `got ${value}`);
});

test('parseMp4Duration reads mvhd version 1 with a 90 kHz timescale', () => {
  const value = core.parseMp4Duration(core.buildMp4Fixture(3600, { version: 1, timescale: 90_000 }));
  assert.ok(value !== null);
  assert.ok(Math.abs(value - 3_600_000) < 120, `got ${value}`);
});

test('parseMp4Duration recovers a moov that sits behind the requested window', () => {
  const full = core.buildMp4Fixture(120);
  const moovOnly = full.subarray(24);
  const value = core.parseMp4Duration(moovOnly);
  assert.ok(value !== null);
  assert.ok(Math.abs(value - 120_000) < 2, `got ${value}`);
});

test('parseMp4Duration rejects garbage and empty input', () => {
  assert.equal(core.parseMp4Duration(core.buildCorruptFixture()), null);
  assert.equal(core.parseMp4Duration(new Uint8Array(8)), null);
  assert.equal(core.parseMp4Duration(null), null);
});

test('parseWebmDuration reads Duration scaled by TimecodeScale', () => {
  const value = core.parseWebmDuration(core.buildWebmFixture(42.25));
  assert.ok(value !== null);
  assert.ok(Math.abs(value - 42_250) < 2, `got ${value}`);
});

test('parseWebmDuration honours a custom TimecodeScale', () => {
  const value = core.parseWebmDuration(core.buildWebmFixture(10, { timecodeScale: 100_000 }));
  assert.ok(value !== null);
  assert.ok(Math.abs(value - 10_000) < 2, `got ${value}`);
});

test('parseWebmDuration rejects random bytes', () => {
  assert.equal(core.parseWebmDuration(core.buildCorruptFixture()), null);
  assert.equal(core.parseWebmDuration(new Uint8Array(0)), null);
});

test('durationFromBytes labels the container it found', () => {
  const webm = core.durationFromBytes(core.buildWebmFixture(7));
  const mp4 = core.durationFromBytes(core.buildMp4Fixture(7));
  assert.equal(webm.container, 'webm');
  assert.equal(mp4.container, 'mp4');
  assert.equal(core.durationFromBytes(core.buildCorruptFixture()), null);
});

/* ------------------------------------------------------------------ *
 * Cache
 * ------------------------------------------------------------------ */

function fixedClock(start) {
  let now = start === undefined ? 1_000 : start;
  const clock = () => now;
  clock.advance = (delta) => {
    now += delta;
  };
  return clock;
}

test('cache round-trips {v,t} entries through a storage backend', () => {
  const storage = core.fakeStorage();
  const cache = core.createCache({ storage, prefix: 't#', now: () => 1000 });
  cache.set('https://a/1.mp4', 5000);
  assert.equal(storage.getItem('t#https://a/1.mp4'), JSON.stringify({ v: 5000, t: 1000 }));
  assert.deepEqual(cache.get('https://a/1.mp4'), { durationMs: 5000, savedAt: 1000 });
  assert.equal(cache.get('missing'), null);
});

test('cache refuses non-positive durations', () => {
  const cache = core.createCache({ storage: null, prefix: 't#' });
  cache.set('a', 0);
  cache.set('b', -10);
  cache.set('c', Number.NaN);
  assert.equal(cache.get('a'), null);
  assert.equal(cache.entries().length, 0);
});

test('cache expires entries after the TTL', () => {
  const clock = fixedClock(0);
  const cache = core.createCache({ storage: core.fakeStorage(), prefix: 't#', ttl: 1000, now: clock });
  cache.set('a', 10);
  clock.advance(500);
  assert.ok(cache.get('a'));
  clock.advance(600);
  assert.equal(cache.get('a'), null);
  assert.equal(cache.entries().length, 0);
});

test('cache drops corrupt entries instead of throwing', () => {
  const storage = core.fakeStorage();
  storage.setItem('t#broken', '{not json');
  storage.setItem('t#wrongshape', JSON.stringify({ v: 'x', t: 1 }));
  const cache = core.createCache({ storage, prefix: 't#', now: () => 1000 });
  assert.equal(cache.get('broken'), null);
  assert.equal(storage.getItem('t#broken'), null);
  assert.equal(cache.get('wrongshape'), null);
});

test('cache evicts the oldest entries past the cap', () => {
  const clock = fixedClock(0);
  const cache = core.createCache({ storage: core.fakeStorage(), prefix: 't#', maxEntries: 3, now: clock });
  ['a', 'b', 'c', 'd'].forEach((key, index) => {
    clock.advance(10);
    cache.set(key, 1000 + index);
  });
  const keys = cache.entries().map((entry) => entry.key);
  assert.deepEqual(keys.sort(), ['b', 'c', 'd']);
});

test('cache reports stats, exports JSON and purges', () => {
  const cache = core.createCache({ storage: core.fakeStorage(), prefix: 't#', now: () => 5000 });
  cache.set('a', 1000);
  cache.set('b', 2000);
  const stats = cache.stats();
  assert.equal(stats.count, 2);
  assert.ok(stats.bytes > 0);
  assert.equal(stats.maxEntries, 500);

  const exported = JSON.parse(cache.exportJson());
  assert.equal(exported.prefix, 't#');
  assert.equal(exported.entries.length, 2);
  assert.equal(new Date(exported.entries[0].savedAt).getTime(), 5000);

  assert.equal(cache.purge(), 2);
  assert.equal(cache.stats().count, 0);
});

test('a cache without a backend never touches storage and stays in memory', () => {
  const cache = core.createCache({ storage: null });
  assert.equal(cache.backend, 'memory');
  cache.set('a', 1234);
  assert.equal(cache.get('a').durationMs, 1234);
});

test('cache survives a storage that throws on write', () => {
  const hostile = {
    length: 0,
    key: () => null,
    getItem: () => null,
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
    removeItem: () => {},
  };
  const cache = core.createCache({ storage: hostile, prefix: 't#', now: () => 1 });
  cache.set('a', 900);
  assert.equal(cache.get('a').durationMs, 900);
});

/* ------------------------------------------------------------------ *
 * Privacy policy
 * ------------------------------------------------------------------ */

test('profiles differ in cache lifetime and logging', () => {
  const standard = core.resolvePolicy('standard');
  const hardened = core.resolvePolicy('hardened');
  const ghost = core.resolvePolicy('ghost');
  assert.equal(standard.ttl, 30 * 24 * 60 * 60 * 1000);
  assert.equal(hardened.ttl, 24 * 60 * 60 * 1000);
  assert.equal(hardened.maxEntries, 150);
  assert.equal(standard.logUrls, true);
  assert.equal(hardened.logUrls, false);
  assert.equal(ghost.cacheEnabled, false);
  assert.equal(ghost.remember, false);
});

test('Global Privacy Control forces GHOST and records the override', () => {
  const policy = core.resolvePolicy('standard', { gpc: true });
  assert.equal(policy.id, 'ghost');
  assert.equal(policy.requested, 'standard');
  assert.equal(policy.forcedByGpc, true);
  assert.equal(policy.cacheEnabled, false);
  assert.equal(core.resolvePolicy('ghost', { gpc: true }).forcedByGpc, false);
});

test('an unknown profile falls back to standard', () => {
  assert.equal(core.resolvePolicy('nope').id, 'standard');
  assert.equal(core.resolvePolicy(undefined).id, 'standard');
});

test('detectGpc only trusts an explicit true', () => {
  assert.equal(core.detectGpc({ globalPrivacyControl: true }), true);
  assert.equal(core.detectGpc({ globalPrivacyControl: 'true' }), false);
  assert.equal(core.detectGpc({}), false);
  assert.equal(core.detectGpc(null), false);
});

/* ------------------------------------------------------------------ *
 * Target normalisation
 * ------------------------------------------------------------------ */

test('normalizeTarget accepts http(s) and the demo scheme only', () => {
  assert.equal(core.normalizeTarget('https://cdn.test/a.mp4').href, 'https://cdn.test/a.mp4');
  assert.equal(core.normalizeTarget('demo://mp4/12').protocol, 'demo:');
  assert.equal(core.normalizeTarget('/relative.mp4', 'https://app.test/x/').href, 'https://app.test/relative.mp4');
  assert.equal(core.normalizeTarget('javascript:alert(1)'), null);
  assert.equal(core.normalizeTarget('ftp://cdn.test/a.mp4'), null);
  assert.equal(core.normalizeTarget('file:///etc/passwd'), null);
  assert.equal(core.normalizeTarget('   '), null);
  assert.equal(core.normalizeTarget(null), null);
});

test('classifyStatus knows what is worth a retry', () => {
  assert.equal(core.classifyStatus(429).retryable, true);
  assert.equal(core.classifyStatus(408).retryable, true);
  assert.equal(core.classifyStatus(503).retryable, true);
  assert.equal(core.classifyStatus(403).retryable, false);
  assert.equal(core.classifyStatus(404).retryable, false);
  assert.equal(core.classifyStatus(416).retryable, false);
});

/* ------------------------------------------------------------------ *
 * Proxy engine
 * ------------------------------------------------------------------ */

function mp4Response(seconds) {
  return new Response(core.buildMp4Fixture(seconds), {
    status: 206,
    headers: { 'content-type': 'video/mp4' },
  });
}

function countingFetch(handler) {
  const calls = [];
  const fetch = (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
  fetch.calls = calls;
  return fetch;
}

test('engine resolves a duration through the queue', async () => {
  const fetch = countingFetch(() => Promise.resolve(mp4Response(95.5)));
  const engine = core.createEngine({ fetch, retries: 0 });
  const result = await engine.probe('https://cdn.test/a.mp4');
  engine.dispose();
  assert.equal(result.ok, true);
  assert.equal(result.container, 'mp4');
  assert.ok(Math.abs(result.durationMs - 95_500) < 2);
  assert.equal(result.attempts, 1);
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].init.headers.Range, `bytes=0-${core.MAX_HEAD_BYTES - 1}`);
});

test('engine serves repeat probes from the cache without a request', async () => {
  const cache = core.createCache({ storage: null, prefix: 't#' });
  const fetch = countingFetch(() => Promise.resolve(mp4Response(30)));
  const engine = core.createEngine({ fetch, cache, retries: 0 });
  const first = await engine.probe('https://cdn.test/a.mp4');
  const second = await engine.probe('https://cdn.test/a.mp4');
  engine.dispose();
  assert.equal(first.via, 'network');
  assert.equal(second.via, 'cache');
  assert.equal(second.durationMs, first.durationMs);
  assert.equal(fetch.calls.length, 1);
  assert.equal(engine.stats().cacheHits, 1);
});

test('engine collapses duplicate in-flight probes', async () => {
  const fetch = countingFetch(() => new Promise((resolve) => setTimeout(() => resolve(mp4Response(12)), 10)));
  const engine = core.createEngine({ fetch, retries: 0 });
  const [a, b] = await Promise.all([
    engine.probe('https://cdn.test/same.mp4'),
    engine.probe('https://cdn.test/same.mp4'),
  ]);
  engine.dispose();
  assert.equal(a, b);
  assert.equal(fetch.calls.length, 1);
  assert.equal(engine.stats().deduped, 1);
});

test('engine never exceeds its concurrency budget', async () => {
  let inFlight = 0;
  let peak = 0;
  const fetch = () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    return new Promise((resolve) => {
      setTimeout(() => {
        inFlight -= 1;
        resolve(mp4Response(5));
      }, 8);
    });
  };
  const engine = core.createEngine({ fetch, concurrency: 2, retries: 0 });
  const results = await Promise.all(
    ['a', 'b', 'c', 'd'].map((name) => engine.probe(`https://cdn.test/${name}.mp4`)),
  );
  engine.dispose();
  assert.equal(results.every((result) => result.ok), true);
  assert.equal(peak, 2);
  assert.equal(engine.stats().active, 0);
});

test('engine retries a throttled response and then succeeds', async () => {
  const fetch = countingFetch((url, init, count) =>
    count === 1 ? Promise.resolve(new Response('', { status: 429 })) : Promise.resolve(mp4Response(20)),
  );
  const engine = core.createEngine({ fetch, retries: 2, retryBaseMs: 1, random: () => 0 });
  const result = await engine.probe('https://cdn.test/slow.mp4');
  engine.dispose();
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(result.via, 'retry');
  assert.equal(fetch.calls.length, 2);
  assert.equal(engine.stats().retries, 1);
});

test('engine gives up on a 404 without retrying', async () => {
  const fetch = countingFetch(() => Promise.resolve(new Response('', { status: 404 })));
  const engine = core.createEngine({ fetch, retries: 2, retryBaseMs: 1 });
  const result = await engine.probe('https://cdn.test/missing.mp4');
  engine.dispose();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'http-404');
  assert.equal(result.attempts, 1);
  assert.equal(fetch.calls.length, 1);
});

test('engine reports a timeout instead of hanging', async () => {
  const fetch = (url, init) =>
    new Promise((resolve, reject) => {
      if (!init.signal) {
        reject(new Error('no signal'));
        return;
      }
      init.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
  const engine = core.createEngine({ fetch, retries: 0, timeoutMs: 5 });
  const result = await engine.probe('https://cdn.test/hang.mp4');
  engine.dispose();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'timeout');
});

test('engine requests a tail range when an MP4 keeps moov at the end', async () => {
  const full = core.buildMp4Fixture(120);
  const ftypOnly = full.subarray(0, 24);
  const fetch = countingFetch((url, init) => {
    if (init.headers.Range.startsWith('bytes=-')) {
      return Promise.resolve(new Response(full, { status: 206 }));
    }
    return Promise.resolve(new Response(ftypOnly, { status: 206 }));
  });
  const engine = core.createEngine({ fetch, retries: 0 });
  const result = await engine.probe('https://cdn.test/tail.mp4');
  engine.dispose();
  assert.equal(result.ok, true);
  assert.ok(Math.abs(result.durationMs - 120_000) < 2);
  assert.equal(fetch.calls.length, 2);
  assert.ok(fetch.calls[1].init.headers.Range, `bytes=-${core.MAX_TAIL_BYTES}`);
});

test('engine reports files with no container metadata', async () => {
  const fetch = countingFetch(() => Promise.resolve(new Response(core.buildCorruptFixture(), { status: 206 })));
  const engine = core.createEngine({ fetch, retries: 0 });
  const result = await engine.probe('https://cdn.test/junk.bin');
  engine.dispose();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'no-duration');
  assert.equal(result.attempts, 1);
});

test('engine blocks cross-origin targets when the lock is on', async () => {
  const fetch = countingFetch(() => Promise.resolve(mp4Response(5)));
  const engine = core.createEngine({ fetch, sameOriginOnly: true, origin: 'https://app.test', retries: 0 });
  const blocked = await engine.probe('https://cdn.test/a.mp4');
  const allowed = await engine.probe('https://app.test/b.mp4');
  engine.dispose();
  assert.equal(blocked.error, 'cross-origin-blocked');
  assert.equal(allowed.ok, true);
  assert.equal(engine.stats().blocked, 1);
  assert.equal(fetch.calls.length, 1);
});

test('engine rejects non-http schemes before any request', async () => {
  const fetch = countingFetch(() => Promise.resolve(mp4Response(5)));
  const engine = core.createEngine({ fetch, retries: 0 });
  const result = await engine.probe('javascript:alert(1)');
  engine.dispose();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid-target');
  assert.equal(fetch.calls.length, 0);
});

test('engine can drop queued work and resolve it as cancelled', async () => {
  const fetch = () => new Promise((resolve) => setTimeout(() => resolve(mp4Response(5)), 20));
  const engine = core.createEngine({ fetch, concurrency: 1, retries: 0 });
  const first = engine.probe('https://cdn.test/one.mp4');
  const second = engine.probe('https://cdn.test/two.mp4');
  assert.equal(engine.purgePending(), 1);
  const cancelled = await second;
  await first;
  engine.dispose();
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.error, 'cancelled');
});

test('engine emits stats and retry events', async () => {
  const events = [];
  const fetch = countingFetch((url, init, count) =>
    count === 1 ? Promise.resolve(new Response('', { status: 429 })) : Promise.resolve(mp4Response(9)),
  );
  const engine = core.createEngine({ fetch, retries: 1, retryBaseMs: 1, random: () => 0 });
  engine.on((kind) => events.push(kind));
  await engine.probe('https://cdn.test/events.mp4');
  engine.dispose();
  assert.ok(events.includes('queued'));
  assert.ok(events.includes('retry'));
  assert.ok(events.includes('result'));
  assert.ok(events.includes('stats'));
});

test('createEngine insists on a fetch implementation', () => {
  assert.throws(() => core.createEngine({}), TypeError);
  assert.throws(() => core.createEngine(), TypeError);
});

/* ------------------------------------------------------------------ *
 * Diagnostics
 * ------------------------------------------------------------------ */

test('runSelfTest passes every check in this environment', async () => {
  const results = await core.runSelfTest();
  const failed = results.filter((result) => !result.pass);
  assert.deepEqual(failed, []);
  assert.ok(results.length >= 8);
});

/* ------------------------------------------------------------------ *
 * Static wiring guards — cheap, and they catch the classic drift bugs
 * ------------------------------------------------------------------ */

test('every element id read by app.js exists in index.html', () => {
  const app = read('app.js');
  const html = read('index.html');
  const ids = new Set();
  const pattern = /byId\('([^']+)'\)/g;
  let match = pattern.exec(app);
  while (match) {
    ids.add(match[1]);
    match = pattern.exec(app);
  }
  assert.ok(ids.size > 20, `only found ${ids.size} ids`);
  const missing = [...ids].filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, []);
});

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

test('the HUD ships no inline script, handler or HTML injection primitive', () => {
  const html = read('index.html');
  const app = stripComments(read('app.js'));
  const worker = stripComments(read('sw.js'));

  assert.ok(/<script src="app\.js" defer><\/script>/.test(html), 'app.js must be an external, deferred script');
  assert.equal(/<script(?![^>]*\bsrc=)/.test(html), false, 'no inline scripts');
  assert.equal(/\son[a-z]+\s*=/i.test(html), false, 'no inline event handlers');
  assert.ok(html.includes('Content-Security-Policy'), 'CSP meta tag required');
  assert.ok(html.includes("connect-src 'self' https:"));

  [app, worker].forEach((source) => {
    assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(/.test(source), false);
    assert.ok(source.includes("'use strict';"));
  });
});

test('the shell description matches what the files actually contain', () => {
  const html = read('index.html');
  ['styles.css', 'app.js', 'erome.user.js'].forEach((asset) => {
    assert.ok(fs.existsSync(path.join(ROOT, asset)), `${asset} missing`);
  });
  assert.ok(/rel="stylesheet" href="styles\.css"/.test(html));
  assert.ok(html.includes('id="probe-rows"'));
  assert.ok(html.includes('name="profile"'));
});
