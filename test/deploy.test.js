'use strict';

/*
 * Guards for the deployment surface.
 *
 * These are cheap, but they catch the two failure modes that only show up after
 * a deploy: headers that drift out of sync with the page's own CSP, and a
 * published shell that no longer matches the files on disk.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');

/** Parses an `_headers` file into [{ pattern, headers: Map }]. */
function parseHeadersFile(source) {
  const blocks = [];
  let current = null;
  source.split('\n').forEach((rawLine) => {
    const line = rawLine.replace(/#.*$/, '').trimEnd();
    if (!line.trim()) {
      return;
    }
    if (!/^\s/.test(line)) {
      current = { pattern: line.trim(), headers: new Map() };
      blocks.push(current);
      return;
    }
    assert.ok(current, `header line outside a block: ${line}`);
    const index = line.indexOf(':');
    assert.ok(index > 0, `malformed header line: ${line}`);
    current.headers.set(line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim());
  });
  return blocks;
}

function blockFor(blocks, pattern) {
  return blocks.find((block) => block.pattern === pattern) || null;
}

/** The CSP in index.html, as the browser would read it. */
function metaCsp() {
  const match = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(read('index.html'));
  assert.ok(match, 'index.html is missing its CSP meta tag');
  return match[1];
}

const headers = parseHeadersFile(read('_headers'));
const vercel = JSON.parse(read('vercel.json'));

test('_headers parses into well-formed blocks', () => {
  assert.ok(headers.length >= 5, `expected several blocks, got ${headers.length}`);
  assert.equal(blockFor(headers, '/*').headers.get('x-content-type-options'), 'nosniff');
  assert.equal(blockFor(headers, '/*').headers.get('referrer-policy'), 'no-referrer');
  assert.match(blockFor(headers, '/*').headers.get('strict-transport-security'), /max-age=\d+/);
  assert.match(blockFor(headers, '/*').headers.get('permissions-policy'), /camera=\(\)/);
});

test('the CSP header and the CSP meta tag are identical', () => {
  const header = blockFor(headers, '/*').headers.get('content-security-policy');
  assert.ok(header, '_headers must carry a CSP');
  assert.equal(header, metaCsp(), 'header and meta CSP drifted apart');
  assert.match(header, /default-src 'self'/);
  assert.match(header, /object-src 'none'/);
  assert.equal(header.includes('unsafe-inline'), false, 'unsafe-inline defeats the point');
  assert.equal(header.includes('unsafe-eval'), false);
  assert.match(header, /connect-src 'self' https:/, 'probes need an outbound allowance');
});

test('vercel.json repeats the same policy and cache rules', () => {
  const generic = vercel.headers.find((entry) => entry.source === '/(.*)');
  assert.ok(generic, 'vercel.json needs a catch-all block');
  const map = new Map(generic.headers.map((header) => [header.key.toLowerCase(), header.value]));
  assert.equal(map.get('content-security-policy'), metaCsp());
  assert.equal(map.get('x-content-type-options'), 'nosniff');

  const worker = vercel.headers.find((entry) => entry.source === '/sw.js');
  const workerHeaders = new Map(worker.headers.map((header) => [header.key.toLowerCase(), header.value]));
  assert.equal(workerHeaders.get('cache-control'), 'no-cache');
  assert.equal(workerHeaders.get('service-worker-allowed'), '/');
});

test('the service worker is never long-cached', () => {
  const worker = blockFor(headers, '/sw.js');
  assert.ok(worker, '_headers needs an /sw.js block');
  assert.equal(worker.headers.get('cache-control'), 'no-cache');
  assert.equal(worker.headers.get('service-worker-allowed'), '/');
});

test('every specific _headers path exists on disk', () => {
  headers
    .filter((block) => block.pattern !== '/*')
    .forEach((block) => {
      const relative = block.pattern.replace(/^\//, '');
      assert.ok(fs.existsSync(path.join(ROOT, relative)), `${block.pattern} is not a file in this repo`);
    });
});

test('the deploy workflow publishes exactly the shell and nothing else', () => {
  const workflow = read('.github/workflows/deploy.yml');
  const publishLine = /cp ([^\n]+) _site\//.exec(workflow);
  assert.ok(publishLine, 'workflow must assemble _site with an explicit copy');
  const published = publishLine[1].trim().split(/\s+/).filter(Boolean);
  assert.deepEqual(published.sort(), ['_headers', 'app.js', 'erome.user.js', 'index.html', 'styles.css', 'sw.js']);
  published.forEach((file) => assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} is published but missing`));
  assert.equal(/cp\s+-r|cp\s+\.\s/.test(workflow), false, 'never copy the whole checkout into the artifact');
});

test('the workflow gates on the verification suite first', () => {
  const workflow = read('.github/workflows/deploy.yml');
  assert.match(workflow, /npm run verify/);
  assert.match(workflow, /needs: verify/);
  assert.ok(workflow.indexOf('npm run verify') < workflow.indexOf('deploy-pages'));
  assert.match(workflow, /permissions:\s*\n\s*contents: read\s*\n\s*pages: write\s*\n\s*id-token: write/);
  assert.equal(/secrets\./.test(workflow), false, 'deployment must not require a secret');
});

test('no deployment file smuggles a credential into the static build', () => {
  const files = ['_headers', 'vercel.json', 'DEPLOY.md', '.github/workflows/deploy.yml'];
  const pattern = /(api[_-]?key|client[_-]?secret|access[_-]?token|password)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{8,}/i;
  files.forEach((file) => {
    assert.equal(pattern.test(read(file)), false, `${file} looks like it contains a credential`);
  });
  ['app.js', 'index.html', 'sw.js'].forEach((file) => {
    const source = read(file);
    assert.equal(/\bsk-[A-Za-z0-9]{16,}/.test(source), false, `${file} contains what looks like an API key`);
  });
});

test('DEPLOY.md documents the constraints that actually apply', () => {
  const doc = read('DEPLOY.md');
  assert.match(doc, /unmetered/i, 'Cloudflare bandwidth claim');
  assert.match(doc, /private repository cannot publish Pages on the free plan/i);
  assert.match(doc, /no API key/i);
  assert.match(doc, /bareworker\.js/, 'the checklist correction should stay documented');
  assert.equal(/hardcode your (static )?keys/i.test(doc.replace(/^.*hardcode your static keys.*$/im, '')), false);
});

test('the dev server and the deploy both serve the same five files', () => {
  const { SHELL_ASSETS } = require('../sw.js');
  const files = SHELL_ASSETS.map((asset) => asset.replace(/^\.\//, '')).filter(Boolean);
  assert.deepEqual(files.sort(), ['app.js', 'index.html', 'styles.css', 'sw.js']);
  assert.ok(fs.existsSync(path.join(ROOT, 'erome.user.js')));
});
