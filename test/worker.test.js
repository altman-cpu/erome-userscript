'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const worker = require('../sw.js');

const ORIGIN = 'https://hud.test';

function request(overrides) {
  const base = {
    method: 'GET',
    url: `${ORIGIN}/index.html`,
    mode: 'no-cors',
    headers: { has: () => false },
  };
  return Object.assign(base, overrides || {});
}

function withRange() {
  return { has: (name) => name.toLowerCase() === 'range' };
}

test('the worker exports a versioned cache namespace', () => {
  assert.match(worker.SW_VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(worker.CACHE_VERSION, `${worker.CACHE_PREFIX}v${worker.SW_VERSION}`);
  assert.ok(worker.SHELL_CACHE.startsWith(worker.CACHE_VERSION));
  assert.notEqual(worker.SHELL_CACHE, worker.ASSET_CACHE);
});

test('the shell list contains the files that actually exist', () => {
  assert.ok(worker.SHELL_ASSETS.includes('app.js'));
  assert.ok(worker.SHELL_ASSETS.includes('sw.js'));
  worker.SHELL_ASSETS.forEach((asset) => {
    const target = asset.replace(/^\.\//, '');
    if (target === '') {
      return;
    }
    assert.ok(fs.existsSync(path.join(__dirname, '..', target)), `${asset} is precached but missing`);
  });
});

test('navigations go network-first', () => {
  assert.equal(worker.chooseStrategy(request({ mode: 'navigate' }), ORIGIN), 'navigation');
  assert.equal(worker.chooseStrategy(request({ mode: 'navigate', url: `${ORIGIN}/deep/link` }), ORIGIN), 'navigation');
});

test('shell assets are served stale-while-revalidate', () => {
  ['/', '/index.html', '/styles.css', '/app.js', '/sw.js'].forEach((pathname) => {
    assert.equal(worker.chooseStrategy(request({ url: `${ORIGIN}${pathname}` }), ORIGIN), 'shell', pathname);
  });
  assert.equal(worker.chooseStrategy(request({ url: `${ORIGIN}/nested/app.js` }), ORIGIN), 'shell');
});

test('the userscript is network-first so the download is never stale', () => {
  assert.equal(worker.chooseStrategy(request({ url: `${ORIGIN}/erome.user.js` }), ORIGIN), 'userscript');
});

test('unknown same-origin paths are left to the network', () => {
  assert.equal(worker.chooseStrategy(request({ url: `${ORIGIN}/media/clip.mp4` }), ORIGIN), 'network');
  assert.equal(worker.chooseStrategy(request({ url: `${ORIGIN}/api/state` }), ORIGIN), 'network');
});

test('range requests are never intercepted', () => {
  const ranged = request({ url: `${ORIGIN}/app.js`, headers: withRange() });
  assert.equal(worker.chooseStrategy(ranged, ORIGIN), 'passthrough');
  const rangedCrossOrigin = request({ url: 'https://cdn.test/clip.mp4', headers: withRange() });
  assert.equal(worker.chooseStrategy(rangedCrossOrigin, ORIGIN), 'passthrough');
});

test('cross-origin requests pass straight through', () => {
  assert.equal(worker.chooseStrategy(request({ url: 'https://cdn.test/app.js' }), ORIGIN), 'passthrough');
  assert.equal(worker.chooseStrategy(request({ url: 'https://cdn.test/index.html', mode: 'navigate' }), ORIGIN), 'passthrough');
});

test('non-GET methods and exotic schemes are untouched', () => {
  assert.equal(worker.chooseStrategy(request({ method: 'POST' }), ORIGIN), 'passthrough');
  assert.equal(worker.chooseStrategy(request({ method: 'HEAD' }), ORIGIN), 'passthrough');
  assert.equal(worker.chooseStrategy(request({ url: 'data:text/plain,hi' }), ORIGIN), 'passthrough');
  assert.equal(worker.chooseStrategy(request({ url: 'blob:https://hud.test/123' }), ORIGIN), 'passthrough');
  assert.equal(worker.chooseStrategy(null, ORIGIN), 'passthrough');
  assert.equal(worker.chooseStrategy(request({ url: 'not a url' }), ORIGIN), 'passthrough');
});

test('isShellAsset normalises trailing slashes and the app root', () => {
  assert.equal(worker.isShellAsset('/'), true);
  assert.equal(worker.isShellAsset(''), true);
  assert.equal(worker.isShellAsset('/styles.css/'), true);
  assert.equal(worker.isShellAsset('/icon.png'), false);
  assert.equal(worker.isShellAsset('/about/styles.css'), true);
});

test('isUserscript matches only the userscript path', () => {
  assert.equal(worker.isUserscript('/erome.user.js'), true);
  assert.equal(worker.isUserscript('/dist/erome.user.js'), true);
  assert.equal(worker.isUserscript('/erome.user.js.map'), false);
  assert.equal(worker.isUserscript('/erome.user.json'), false);
});

test('the worker never registers itself when required from Node', () => {
  assert.equal(typeof globalThis.addEventListener, 'undefined');
  assert.equal(typeof worker.precacheShell, 'undefined');
});
