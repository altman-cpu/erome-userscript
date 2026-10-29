'use strict';

/*
 * GRID//CORE service worker — multi-tab routing engine.
 *
 * The rules, in the order they are applied:
 *
 *   1. anything that is not a same-origin GET is left alone entirely: no
 *      respondWith, so cross-origin media probes, range requests and third
 *      party requests behave exactly as the browser would make them;
 *   2. navigations are network-first with a short timeout, falling back to the
 *      precached shell so a dead network still renders the console;
 *   3. the shell (document, stylesheet, app, this file) is
 *      stale-while-revalidate: instant from cache, refreshed for next load;
 *   4. the userscript is network-first and never cached, so
 *      "Download userscript" cannot silently hand out an old version;
 *   5. everything else same-origin goes straight to the network.
 *
 * Multi-tab: `clients.claim()` on activation and every cache deletion is
 * announced to all windows, so two tabs never disagree about the shell version.
 */

const SW_VERSION = '1.0.0';
const CACHE_PREFIX = 'gridcore-';
const CACHE_VERSION = `${CACHE_PREFIX}v${SW_VERSION}`;
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const ASSET_CACHE = `${CACHE_VERSION}-assets`;
const NAV_TIMEOUT_MS = 3500;

const SHELL_ASSETS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'sw.js',
];

const SCRIPT_PATH = 'erome.user.js';

function isShellAsset(pathname) {
  const target = pathname.replace(/\/+$/, '') || '/';
  return SHELL_ASSETS.some((entry) => {
    const normalized = entry.replace(/^\.\//, '').replace(/\/+$/, '');
    if (normalized === '' || normalized === '.') {
      return target === '/' || target === '';
    }
    return target === `/${normalized}` || target.endsWith(`/${normalized}`);
  });
}

function isUserscript(pathname) {
  return pathname.endsWith(`/${SCRIPT_PATH}`) || pathname === `/${SCRIPT_PATH}`;
}

/**
 * Pure routing decision, exported for the test-suite.
 * Returns 'passthrough' | 'navigation' | 'userscript' | 'shell' | 'network'.
 */
function chooseStrategy(request, origin) {
  if (!request || request.method !== 'GET') {
    return 'passthrough';
  }
  let url;
  try {
    url = new URL(request.url);
  } catch (error) {
    return 'passthrough';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'passthrough';
  }
  if (origin && url.origin !== origin) {
    return 'passthrough';
  }
  // A range request must reach the network untouched; rewriting it would make
  // duration probing slower and could break the byte offsets.
  const headers = request.headers;
  if (headers && typeof headers.has === 'function' && headers.has('range')) {
    return 'passthrough';
  }
  if (request.mode === 'navigate') {
    return 'navigation';
  }
  if (isUserscript(url.pathname)) {
    return 'userscript';
  }
  if (isShellAsset(url.pathname)) {
    return 'shell';
  }
  return 'network';
}

/* ------------------------------------------------------------------ *
 * Cache plumbing
 * ------------------------------------------------------------------ */

async function precacheShell() {
  const cache = await caches.open(SHELL_CACHE);
  await Promise.all(
    SHELL_ASSETS.map(async (asset) => {
      try {
        const response = await fetch(new Request(asset, { cache: 'reload' }));
        if (response.ok) {
          await cache.put(asset, response.clone());
        }
      } catch (error) {
        // One missing file must not abort the whole install.
      }
    }),
  );
}

async function deleteStaleCaches() {
  const names = await caches.keys();
  const stale = names.filter((name) => name.startsWith(CACHE_PREFIX) && !name.startsWith(CACHE_VERSION));
  await Promise.all(stale.map((name) => caches.delete(name)));
  return stale;
}

async function cacheStats() {
  const names = await caches.keys();
  let entries = 0;
  let bytes = 0;
  for (const name of names) {
    if (!name.startsWith(CACHE_PREFIX)) {
      continue;
    }
    const cache = await caches.open(name);
    const requests = await cache.keys();
    entries += requests.length;
    for (const request of requests) {
      const response = await cache.match(request);
      if (!response) {
        continue;
      }
      const length = Number(response.headers.get('content-length'));
      if (Number.isFinite(length) && length > 0) {
        bytes += length;
      }
    }
  }
  return { version: SW_VERSION, entries, bytes, caches: names.filter((name) => name.startsWith(CACHE_PREFIX)) };
}

async function purgeCaches() {
  const names = await caches.keys();
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(CACHE_PREFIX)) {
      continue;
    }
    const cache = await caches.open(name);
    removed += (await cache.keys()).length;
    await caches.delete(name);
  }
  return removed;
}

async function broadcast(payload) {
  const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clientList.forEach((client) => {
    try {
      client.postMessage(payload);
    } catch (error) {
      /* a closing tab can reject; ignore it */
    }
  });
}

/* ------------------------------------------------------------------ *
 * Strategies
 * ------------------------------------------------------------------ */

async function networkFirstNavigation(request) {
  const cache = await caches.open(SHELL_CACHE);
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  if (controller) {
    timer = setTimeout(() => controller.abort(), NAV_TIMEOUT_MS);
  }
  try {
    const attempt = controller ? new Request(request, { signal: controller.signal }) : request;
    const response = await fetch(attempt);
    if (response && response.ok) {
      cache.put(request, response.clone()).catch(() => {});
      return response;
    }
    throw new Error(`HTTP ${response ? response.status : 'unknown'}`);
  } catch (error) {
    const cached = (await cache.match(request)) || (await cache.match('index.html')) || (await cache.match('./'));
    if (cached) {
      return cached;
    }
    // Plain text on purpose: no HTML is ever synthesised by this worker.
    return new Response('GRID//CORE OFFLINE\n\nThe shell has not been cached yet. Reconnect and reload.\n', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request, { ignoreSearch: false });
  const network = fetch(request)
    .then((response) => {
      if (response && response.ok) {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    })
    .catch(() => null);
  if (cached) {
    return cached;
  }
  const fresh = await network;
  if (fresh) {
    return fresh;
  }
  return new Response('', { status: 504, statusText: 'Offline' });
}

async function networkFirstScript(request) {
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      return response;
    }
    throw new Error(`HTTP ${response ? response.status : 'unknown'}`);
  } catch (error) {
    // Nothing is written to cache: a stale userscript would be a lie.
    return new Response('Userscript unavailable while offline.\n', {
      status: 504,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
}

/* ------------------------------------------------------------------ *
 * Worker lifecycle (skipped when the file is required by Node)
 * ------------------------------------------------------------------ */

const IS_WORKER =
  typeof self !== 'undefined' &&
  typeof self.addEventListener === 'function' &&
  typeof caches !== 'undefined' &&
  typeof caches.open === 'function';

if (IS_WORKER) {
  self.addEventListener('install', (event) => {
    event.waitUntil(precacheShell());
  });

  self.addEventListener('activate', (event) => {
    event.waitUntil(
      deleteStaleCaches()
        .then(() => self.clients.claim())
        .then(() => broadcast({ type: 'ACTIVATED', version: SW_VERSION })),
    );
  });

  self.addEventListener('fetch', (event) => {
    const strategy = chooseStrategy(event.request, self.location.origin);
    if (strategy === 'passthrough') {
      return;
    }
    if (strategy === 'navigation') {
      event.respondWith(networkFirstNavigation(event.request));
      return;
    }
    if (strategy === 'shell') {
      event.respondWith(staleWhileRevalidate(event.request));
      return;
    }
    if (strategy === 'userscript') {
      event.respondWith(networkFirstScript(event.request));
      return;
    }
    // 'network': nothing to do, the browser handles it.
  });

  self.addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.type === 'SKIP_WAITING') {
      self.skipWaiting();
      return;
    }
    if (data.type === 'PURGE') {
      event.waitUntil(
        purgeCaches().then(async (removed) => {
          await broadcast({ type: 'PURGED', removed });
        }),
      );
      return;
    }
    if (data.type === 'STATS') {
      event.waitUntil(
        cacheStats().then((stats) => {
          if (event.source && typeof event.source.postMessage === 'function') {
            event.source.postMessage(Object.assign({ type: 'STATS' }, stats));
          }
        }),
      );
    }
  });
}

if (typeof module === 'object' && module && module.exports && typeof process === 'object') {
  module.exports = {
    SW_VERSION,
    CACHE_PREFIX,
    CACHE_VERSION,
    SHELL_CACHE,
    ASSET_CACHE,
    SHELL_ASSETS,
    chooseStrategy,
    isShellAsset,
    isUserscript,
  };
}
