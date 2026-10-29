'use strict';

/*
 * Boots the real app.js against a DOM stub built from index.html.
 *
 * The stub is small on purpose: it only implements what the terminal UI uses.
 * If app.js starts depending on a new primitive, this test is the first place
 * that notices, and every element it looks up must exist in the markup or the
 * lookup returns null and boot() throws (captured through console.warn).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

class Element {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this.className = '';
    this.textContent = '';
    this.classList = {
      add: () => {},
      remove: () => {},
      toggle: () => false,
      contains: () => false,
    };
  }

  // A document fragment behaves like the DOM: its children move, not itself.
  flatten(nodes) {
    const flat = [];
    nodes.forEach((node) => {
      if (node && node.tagName === '#FRAGMENT') {
        flat.push(...node.children);
      } else {
        flat.push(node);
      }
    });
    return flat;
  }

  append(...nodes) {
    this.children.push(...this.flatten(nodes));
  }

  appendChild(node) {
    const flat = this.flatten([node]);
    this.children.push(...flat);
    return flat[0];
  }

  prepend(node) {
    this.children.unshift(...this.flatten([node]));
  }

  replaceChildren(...nodes) {
    this.children = this.flatten(nodes);
  }

  remove() {
    this.removed = true;
  }

  get lastElementChild() {
    return this.children.length ? this.children[this.children.length - 1] : null;
  }

  addEventListener(type, handler) {
    const list = this.listeners.get(type) || [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  dispatch(type, event) {
    const synthetic = Object.assign({ target: this, preventDefault: () => {}, key: '' }, event || {});
    (this.listeners.get(type) || []).forEach((handler) => handler(synthetic));
    return synthetic;
  }

  focus() {
    document.activeElement = this;
  }

  blur() {
    document.activeElement = null;
  }

  click() {
    this.dispatch('click');
  }
}

const ids = new Map();
const idPattern = /\bid="([^"]+)"/g;
let idMatch = idPattern.exec(html);
while (idMatch) {
  const node = new Element(idMatch[1] === 'probe-input' ? 'textarea' : 'div');
  node.id = idMatch[1];
  ids.set(idMatch[1], node);
  idMatch = idPattern.exec(html);
}

const profileInputs = ['standard', 'hardened', 'ghost'].map((value) => {
  const input = new Element('input');
  input.value = value;
  input.checked = value === 'standard';
  return input;
});

const documentStub = {
  activeElement: null,
  body: new Element('body'),
  getElementById(id) {
    return ids.get(id) || null;
  },
  createElement(tag) {
    return new Element(tag);
  },
  createDocumentFragment() {
    return new Element('#fragment');
  },
  querySelectorAll(selector) {
    return selector === 'input[name="profile"]' ? profileInputs.slice() : [];
  },
  addEventListener() {},
};

const warnings = [];
const originalWarn = console.warn;
console.warn = (...args) => {
  warnings.push(args.join(' '));
};

const requests = [];
const windowStub = {
  addEventListener() {},
  fetch(url, init) {
    requests.push({ url, init });
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(fs.readFileSync(path.join(ROOT, 'erome.user.js'), 'utf8')),
    });
  },
};

// `navigator` is a getter-only accessor on newer Node versions.
function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

defineGlobal('document', documentStub);
defineGlobal('window', windowStub);
defineGlobal('location', { origin: 'https://hud.test', protocol: 'https:', hostname: 'hud.test', href: 'https://hud.test/' });
defineGlobal('navigator', { onLine: true, globalPrivacyControl: false });
global.setInterval = () => 0;
global.localStorage = {
  store: new Map(),
  get length() {
    return this.store.size;
  },
  key(index) {
    return Array.from(this.store.keys())[index] ?? null;
  },
  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  },
  setItem(key, value) {
    this.store.set(key, String(value));
  },
  removeItem(key) {
    this.store.delete(key);
  },
};

const core = require('../app.js');
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** Depth-first text of a stubbed node, the way textContent would read it. */
function textOf(node) {
  if (!node) {
    return '';
  }
  if (!node.children || node.children.length === 0) {
    return node.textContent || '';
  }
  return `${node.textContent || ''} ${node.children.map((child) => textOf(child)).join(' ')}`;
}

test('boot() renders the terminal without touching console.warn', async () => {
  await settle();
  console.warn = originalWarn;
  assert.deepEqual(warnings, []);
  assert.equal(ids.get('build-tag').textContent, `v${core.HUD_VERSION}`);
  assert.match(ids.get('clock').textContent, /^\d{2}:\d{2}:\d{2} · UTC[+-][\d.]+$/);
  assert.match(ids.get('policy-note').textContent, /STANDARD/);
  assert.match(ids.get('cache-mode').textContent, /STANDARD/);
  assert.equal(ids.get('sw-state').textContent, 'SW · UNSUPPORTED');
  assert.match(ids.get('probe-summary').textContent, /standing by/);
});

test('the userscript metadata panel reads the real file', async () => {
  await settle();
  const meta = ids.get('userscript-meta');
  assert.ok(meta.children.length >= 4, 'expected dt/dd pairs');
  const texts = meta.children.map((child) => child.textContent).join(' ');
  assert.match(texts, /version/);
  assert.match(texts, /\d+\.\d+\.\d+/);
  assert.equal(ids.get('userscript-install').href, 'erome.user.js');
});

test('the stream records the boot sequence', () => {
  const stream = ids.get('console-log');
  const joined = stream.children.map((line) => textOf(line)).join('\n');
  assert.match(joined, /GRID\/\/CORE v/);
  assert.match(joined, /policy standard/);
});

test('a synthetic probe sweep fills the table end to end', async () => {
  const input = ids.get('probe-input');
  input.value = ['demo://mp4/95.5', 'demo://webm/42.25', 'demo://unknown/1'].join('\n');
  ids.get('probe-run').dispatch('click');
  await new Promise((resolve) => setTimeout(resolve, 120));

  const rows = ids.get('probe-rows').children;
  assert.equal(rows.length, 3, 'one row per target');
  const durations = rows.map((row) => row.children[2].textContent);
  assert.deepEqual(durations.sort(), ['—', '1:35', '0:42'].sort());
  const states = rows.map((row) => row.children[1].textContent).sort();
  assert.deepEqual(states, ['NO METADATA', 'OK', 'OK']);
  assert.equal(requests.filter((entry) => String(entry.url).startsWith('demo://')).length, 0, 'demo targets never use window.fetch');
  assert.match(ids.get('probe-summary').textContent, /2 resolved/);
  assert.equal(ids.get('stat-ok').textContent, '2');
  assert.equal(ids.get('stat-failed').textContent, '1');
  assert.notEqual(ids.get('stat-bytes').textContent, '0 B');
});

test('switching profile rewrites the policy note and cache mode', () => {
  const ghost = profileInputs[2];
  ghost.checked = true;
  ghost.dispatch('change');
  assert.match(ids.get('policy-note').textContent, /GHOST/);
  assert.match(ids.get('policy-note').textContent, /No cache writes/);
  assert.match(ids.get('cache-mode').textContent, /DISABLED/);
});

test('clearing the queue empties the table', () => {
  ids.get('probe-clear').dispatch('click');
  assert.equal(ids.get('probe-rows').children.length, 0);
  assert.equal(ids.get('probe-input').value, '');
});
