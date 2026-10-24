'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

/* ------------------------------------------------------------------ *
 * Minimal DOM good enough to run the real boot() path in Node
 * ------------------------------------------------------------------ */

class ClassList {
  constructor() {
    this.set = new Set();
  }

  add(name) {
    this.set.add(name);
  }

  remove(name) {
    this.set.delete(name);
  }

  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : Boolean(force);
    if (on) {
      this.set.add(name);
    } else {
      this.set.delete(name);
    }
    return on;
  }

  contains(name) {
    return this.set.has(name);
  }
}

function matchesSimple(element, simple) {
  // Supports tag, .class, #id and compounds such as `ul.navbar-right`.
  const id = (simple.match(/#([\w-]+)/) || [])[1];
  const classes = Array.from(simple.matchAll(/\.([\w-]+)/g), (match) => match[1]);
  const tag = simple.replace(/[.#][\w-]+/g, '');
  if (id && element.id !== id) {
    return false;
  }
  const classNames = element.className.split(/\s+/).filter(Boolean);
  const hasClass = (name) => element.classList.contains(name) || classNames.includes(name);
  if (!classes.every(hasClass)) {
    return false;
  }
  return !tag || element.tagName.toLowerCase() === tag.toLowerCase();
}

function matchesChain(element, parts) {
  let index = parts.length - 1;
  if (!matchesSimple(element, parts[index])) {
    return false;
  }
  let node = element.parentNode;
  index -= 1;
  while (index >= 0) {
    while (node && !matchesSimple(node, parts[index])) {
      node = node.parentNode;
    }
    if (!node) {
      return false;
    }
    node = node.parentNode;
    index -= 1;
  }
  return true;
}

function matches(element, selector) {
  return selector.split(',').some((part) => matchesChain(element, part.trim().split(/\s+/)));
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.classList = new ClassList();
    this.listeners = {};
    this.id = '';
    this.className = '';
    this.tagName = tagName.toUpperCase();
    this._text = '';
    this.type = '';
    this.value = '';
  }

  get previousSibling() {
    if (!this.parentNode) {
      return null;
    }
    const index = this.parentNode.children.indexOf(this);
    return index > 0 ? this.parentNode.children[index - 1] : null;
  }

  get nextSibling() {
    if (!this.parentNode) {
      return null;
    }
    const index = this.parentNode.children.indexOf(this);
    return index >= 0 && index + 1 < this.parentNode.children.length
      ? this.parentNode.children[index + 1]
      : null;
  }

  get textContent() {
    return this._text + this.children.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    this._text = String(value);
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child, reference) {
    const index = this.children.indexOf(reference);
    child.parentNode = this;
    if (index < 0) {
      this.children.push(child);
    } else {
      this.children.splice(index, 0, child);
    }
    return child;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'id') {
      this.id = String(value);
    }
    if (name === 'class') {
      this.className = String(value);
    }
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }

  addEventListener(type, handler) {
    if (!this.listeners[type]) {
      this.listeners[type] = [];
    }
    this.listeners[type].push(handler);
  }

  dispatch(type) {
    (this.listeners[type] || []).forEach((handler) => handler({ preventDefault() {} }));
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (matches(node, selector)) {
        return node;
      }
      node = node.parentNode;
    }
    return null;
  }

  querySelectorAll(selector) {
    const found = [];
    const walk = (node) => {
      node.children.forEach((child) => {
        if (matches(child, selector)) {
          found.push(child);
        }
        walk(child);
      });
    };
    walk(this);
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

function createDocument() {
  const document = {
    head: new FakeElement('head'),
    body: new FakeElement('body'),
    documentElement: new FakeElement('html'),
    visibilityState: 'visible',
    location: { pathname: '/a/example', hash: '', search: '' },
    listeners: {},
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (text) => {
      const node = new FakeElement('#text');
      node.textContent = text;
      return node;
    },
    addEventListener(type, handler) {
      if (!document.listeners[type]) {
        document.listeners[type] = [];
      }
      document.listeners[type].push(handler);
    },
    querySelectorAll(selector) {
      return document.body.querySelectorAll(selector).concat(document.head.querySelectorAll(selector));
    },
    querySelector(selector) {
      return document.querySelectorAll(selector)[0] || null;
    },
    getElementById(id) {
      return document.querySelectorAll(`#${id}`)[0] || null;
    },
  };
  return document;
}

function fakeStorage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    get length() {
      return map.size;
    },
    key: (index) => Array.from(map.keys())[index] ?? null,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    dump: () => Object.fromEntries(map),
  };
}

function buildPage(document, videoCount = 2) {
  const nav = document.body.appendChild(document.createElement('div'));
  nav.id = 'app-navbar-collapse';
  const navList = nav.appendChild(document.createElement('ul'));
  navList.className = 'navbar-right';

  const albums = [];
  for (let i = 0; i < videoCount; i += 1) {
    const album = document.body.appendChild(document.createElement('div'));
    album.className = 'album';
    const counter = album.appendChild(document.createElement('span'));
    counter.className = 'album-videos';
    counter.textContent = String(i + 1);

    const group = album.appendChild(document.createElement('div'));
    group.className = 'media-group';
    const container = group.appendChild(document.createElement('div'));
    container.className = 'video';
    const player = container.appendChild(document.createElement('div'));
    player.className = 'player';
    const video = player.appendChild(document.createElement('video'));
    const source = video.appendChild(document.createElement('source'));
    source.src = `https://cdn.example/video-${i}.webm`;
    albums.push({ album, group, container, player, video, source });
  }
  return { nav, albums };
}

const DURATIONS = [65000, 5000];

function seededStorage(milliseconds = DURATIONS, config = null) {
  const seed = Object.fromEntries(
    milliseconds.map((value, index) => [
      `$vl2#https://cdn.example/video-${index}.webm`,
      JSON.stringify({ v: value, t: Date.now() }),
    ]),
  );
  if (config) {
    seed['$vl2#~config'] = JSON.stringify({ v: config, t: Date.now() });
  }
  return fakeStorage(seed);
}

// The sweep re-arms itself; let only short timers actually run so the stub does
// not busy-loop, and never execute the multi-second sweep.
const fakeSetTimeout = (fn, ms) => {
  if (!ms || ms < 1000) {
    return setTimeout(fn, ms || 0);
  }
  return 1;
};

function loadUserscript(document, window) {
  globalThis.document = document;
  globalThis.window = window;
  globalThis.history = {
    replaceState(state, title, url) {
      document.location.hash = '';
      document.location.search = url.includes('?') ? `?${url.split('?')[1]}` : '';
    },
  };
  const path = require.resolve('../erome.user.js');
  delete require.cache[path];
  require(path);
}

test('boot() renders anchors, durations and the filter panel', async () => {
  const document = createDocument();
  const { albums, nav } = buildPage(document);
  const storage = fakeStorage(Object.fromEntries(
    DURATIONS.map((milliseconds, index) => [
      `$vl2#https://cdn.example/video-${index}.webm`,
      JSON.stringify({ v: milliseconds, t: Date.now() }),
    ]),
  ));
  const window = {
    localStorage: storage,
    location: document.location,
    requestAnimationFrame: (fn) => fn(),
    setTimeout: fakeSetTimeout,
    clearTimeout: () => {},
    addEventListener() {},
  };

  loadUserscript(document, window);
  await new Promise((resolve) => setTimeout(resolve, 10));

  albums.forEach(({ player, video }, index) => {
    const anchor = player.previousSibling;
    assert.ok(anchor, 'expected a link before the player');
    assert.equal(anchor.className, 'erome-vl-link');
    assert.equal(anchor.textContent, `https://cdn.example/video-${index}.webm`);
    // The markup is `<span>1:05</span> <a>url</a>` before the player.
    const span = anchor.parentNode.querySelector('.erome-vl-duration');
    assert.ok(span, 'expected a duration span');
    assert.equal(span.textContent, index === 0 ? '1:05' : '0:05');
    assert.equal(video.dataset.length, index === 0 ? '65' : '5');
  });

  const panel = document.getElementById('erome-vl-panel');
  assert.ok(panel, 'expected the minimum-length panel');
  const slider = document.getElementById('erome-vl-minlength');
  assert.ok(Number(slider.max) >= 65);
  assert.equal(document.getElementById('erome-vl-output').textContent, 'Off');

  assert.equal(document.getElementById('erome-vl-status').textContent, '2 loaded');

  const onlyVideos = nav.querySelector('a');
  assert.equal(onlyVideos.textContent, 'only videos');
});

test('the slider hides videos shorter than the minimum and persists it', async () => {
  const document = createDocument();
  const { albums } = buildPage(document);
  const storage = fakeStorage(Object.fromEntries(
    DURATIONS.map((milliseconds, index) => [
      `$vl2#https://cdn.example/video-${index}.webm`,
      JSON.stringify({ v: milliseconds, t: Date.now() }),
    ]),
  ));
  const window = {
    localStorage: storage,
    location: document.location,
    requestAnimationFrame: (fn) => fn(),
    setTimeout: fakeSetTimeout,
    clearTimeout: () => {},
    addEventListener() {},
  };

  loadUserscript(document, window);
  await new Promise((resolve) => setTimeout(resolve, 10));

  const slider = document.getElementById('erome-vl-minlength');
  slider.value = '10';
  slider.dispatch('input');

  assert.equal(albums[0].container.classList.contains('erome-vl-hidden'), false, '1:05 stays visible');
  assert.equal(albums[1].container.classList.contains('erome-vl-hidden'), true, '0:05 is hidden');
  assert.equal(document.getElementById('erome-vl-output').textContent, '0:10');

  const saved = JSON.parse(storage.getItem('$vl2#~config'));
  assert.equal(saved.v.minSeconds, 10);
});

test('the only-videos nav item filters album thumbnails and updates the hash', async () => {
  const document = createDocument();
  document.location.pathname = '/search';
  const { albums, nav } = buildPage(document);
  const window = {
    localStorage: fakeStorage(),
    location: document.location,
    requestAnimationFrame: (fn) => fn(),
    setTimeout: fakeSetTimeout,
    clearTimeout: () => {},
    addEventListener() {},
  };

  loadUserscript(document, window);
  await new Promise((resolve) => setTimeout(resolve, 10));

  const link = nav.querySelector('a');
  link.dispatch('click');
  assert.equal(document.location.hash, '#onlyvideos=1');

  link.dispatch('click');
  assert.equal(document.location.hash, '#onlyvideos=2');
  assert.equal(link.textContent, 'only videos (2+)');
  assert.equal(albums[0].album.classList.contains('erome-vl-hidden'), true, 'album with 1 video is hidden');
  assert.equal(albums[1].album.classList.contains('erome-vl-hidden'), false, 'album with 2 videos survives');

  // Third click passes the highest album count, so it wraps back to off.
  link.dispatch('click');
  assert.equal(document.location.hash, '');
  albums.forEach(({ album }) => {
    assert.equal(album.classList.contains('erome-vl-hidden'), false, 'wrapping to off restores every album');
  });
  assert.equal(link.textContent, 'only videos');
});

test('a deep link restores the saved only-videos level', async () => {
  const document = createDocument();
  document.location.pathname = '/search';
  document.location.hash = '#onlyvideos=2';
  const { albums } = buildPage(document);
  const window = {
    localStorage: fakeStorage(),
    location: document.location,
    requestAnimationFrame: (fn) => fn(),
    setTimeout: fakeSetTimeout,
    clearTimeout: () => {},
    addEventListener() {},
  };

  loadUserscript(document, window);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(albums[0].album.classList.contains('erome-vl-hidden'), true);
  assert.equal(albums[1].album.classList.contains('erome-vl-hidden'), false);
});

test('album pages hide media groups without a video', async () => {
  const document = createDocument();
  document.location.pathname = '/a/example';
  document.location.hash = '#onlyvideos=1';

  const groups = [];
  for (let i = 0; i < 2; i += 1) {
    const group = document.body.appendChild(document.createElement('div'));
    group.className = 'media-group';
    const holder = group.appendChild(document.createElement('div'));
    holder.className = i === 0 ? 'video' : 'image';
    holder.appendChild(document.createElement('img'));
    groups.push(group);
  }

  const window = {
    localStorage: fakeStorage(),
    location: document.location,
    requestAnimationFrame: (fn) => fn(),
    setTimeout: fakeSetTimeout,
    clearTimeout: () => {},
    addEventListener() {},
  };

  loadUserscript(document, window);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(groups[0].classList.contains('erome-vl-hidden'), false, 'the video group stays');
  assert.equal(groups[1].classList.contains('erome-vl-hidden'), true, 'the image-only group is hidden');
});

test('a saved minimum larger than the default range is restored, not clamped', async () => {
  const document = createDocument();
  buildPage(document);
  const window = {
    localStorage: seededStorage(DURATIONS, { minSeconds: 120 }),
    location: document.location,
    requestAnimationFrame: (fn) => fn(),
    setTimeout: fakeSetTimeout,
    clearTimeout: () => {},
    addEventListener() {},
  };

  loadUserscript(document, window);
  await new Promise((resolve) => setTimeout(resolve, 10));

  const slider = document.getElementById('erome-vl-minlength');
  assert.equal(slider.value, '120');
  assert.ok(Number(slider.max) >= 120, 'range must include the remembered value');
  assert.equal(document.getElementById('erome-vl-output').textContent, '2:00');
});

test('single-video pages ignore a saved minimum so nothing disappears', async () => {
  const document = createDocument();
  const { albums } = buildPage(document, 1);
  const window = {
    localStorage: seededStorage(DURATIONS, { minSeconds: 120 }),
    location: document.location,
    requestAnimationFrame: (fn) => fn(),
    setTimeout: fakeSetTimeout,
    clearTimeout: () => {},
    addEventListener() {},
  };

  loadUserscript(document, window);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(document.getElementById('erome-vl-panel'), null, 'no slider means no way to undo');
  assert.equal(albums[0].container.classList.contains('erome-vl-hidden'), false);
});

test('private mode clears cached durations and survives a reload', async () => {
  const document = createDocument();
  buildPage(document);
  const storage = seededStorage();
  let menuCallback = null;
  globalThis.GM = {
    registerMenuCommand(label, callback) {
      menuCallback = callback;
    },
    xmlHttpRequest() {
      return { abort() {} };
    },
  };

  const window = {
    localStorage: storage,
    location: document.location,
    requestAnimationFrame: (fn) => fn(),
    setTimeout: fakeSetTimeout,
    clearTimeout: () => {},
    addEventListener() {},
  };

  loadUserscript(document, window);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(typeof menuCallback, 'function', 'the private-mode menu entry is registered');
  assert.ok(storage.getItem('$vl2#https://cdn.example/video-0.webm'), 'duration cached before private mode');

  menuCallback();

  assert.equal(storage.getItem('$vl2#https://cdn.example/video-0.webm'), null, 'cache cleared');
  const config = JSON.parse(storage.getItem('$vl2#~config'));
  assert.equal(config.v.privateMode, true, 'private mode is remembered');

  menuCallback();
  const restored = JSON.parse(storage.getItem('$vl2#~config'));
  assert.equal(restored.v.privateMode, false);
  delete globalThis.GM;
});

test('failed probes are reported instead of leaving the panel at Loading', async () => {
  const document = createDocument();
  buildPage(document);
  delete globalThis.GM;
  const window = {
    localStorage: fakeStorage(),
    location: document.location,
    requestAnimationFrame: (fn) => fn(),
    setTimeout: fakeSetTimeout,
    clearTimeout: () => {},
    addEventListener() {},
  };

  loadUserscript(document, window);
  await new Promise((resolve) => setTimeout(resolve, 30));

  const status = document.getElementById('erome-vl-status').textContent;
  assert.match(status, /^0 loaded/);
  assert.match(status, /2 unavailable/);
  albumsAreVisible(document);
});

function albumsAreVisible(document) {
  document.querySelectorAll('.album').forEach((album) => {
    assert.equal(album.classList.contains('erome-vl-hidden'), false);
  });
}
