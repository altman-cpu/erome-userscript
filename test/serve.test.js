'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const { createServer, resolvePath, parseArgs, loadHeaders, headersFor, ROOT } = require('../scripts/serve.js');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(address.port);
    });
  });
}

function get(port, requestPath, method) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path: requestPath, method: method || 'GET' },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    request.on('error', reject);
    request.end();
  });
}

test('resolvePath maps the root to index.html', () => {
  assert.equal(resolvePath('/'), path.join(ROOT, 'index.html'));
  assert.equal(resolvePath('/app.js?v=2'), path.join(ROOT, 'app.js'));
  assert.equal(resolvePath('//styles.css'), path.join(ROOT, 'styles.css'));
});

test('resolvePath refuses traversal and malformed escapes', () => {
  assert.equal(resolvePath('/../etc/passwd'), null);
  assert.equal(resolvePath('/%2e%2e/%2e%2e/etc/passwd'), null);
  assert.equal(resolvePath('/%zz'), null);
});

test('parseArgs validates the port', () => {
  assert.equal(parseArgs(['node', 'serve.js']).port, 8000);
  assert.equal(parseArgs(['node', 'serve.js', '--port', '9010']).port, 9010);
  assert.equal(parseArgs(['node', 'serve.js', '--host', '0.0.0.0']).host, '0.0.0.0');
  assert.throws(() => parseArgs(['node', 'serve.js', '--port', '0']), /invalid port/);
  assert.throws(() => parseArgs(['node', 'serve.js', '--port', 'nope']), /invalid port/);
});

test('the dev server serves the shell with correct types', async () => {
  const server = createServer();
  const port = await listen(server);
  try {
    const index = await get(port, '/');
    assert.equal(index.status, 200);
    assert.match(index.headers['content-type'], /text\/html/);
    assert.match(index.body, /GRID\/\/CORE/);
    // `_headers` wins over the built-in default, exactly like production.
    assert.equal(index.headers['cache-control'], 'no-cache');
    assert.equal(index.headers['x-content-type-options'], 'nosniff');

    const app = await get(port, '/app.js');
    assert.equal(app.status, 200);
    assert.match(app.headers['content-type'], /text\/javascript/);

    const worker = await get(port, '/sw.js');
    assert.match(worker.headers['content-type'], /text\/javascript/);
    assert.match(worker.body, /chooseStrategy/);

    const style = await get(port, '/styles.css');
    assert.match(style.headers['content-type'], /text\/css/);

    const userscript = await get(port, '/erome.user.js');
    assert.equal(userscript.status, 200);
    assert.match(userscript.body, /==UserScript==/);
  } finally {
    server.close();
  }
});

test('the dev server answers 404, 405 and 403 correctly', async () => {
  const server = createServer();
  const port = await listen(server);
  try {
    assert.equal((await get(port, '/nope.txt')).status, 404);
    assert.equal((await get(port, '/', 'POST')).status, 405);
    assert.equal((await get(port, '/%2e%2e/%2e%2e/etc/passwd')).status, 403);
    assert.equal((await get(port, '/scripts')).status, 404);
  } finally {
    server.close();
  }
});

test('HEAD returns headers without a body', async () => {
  const server = createServer();
  const port = await listen(server);
  try {
    const head = await get(port, '/index.html', 'HEAD');
    assert.equal(head.status, 200);
    assert.ok(Number(head.headers['content-length']) > 0);
    assert.equal(head.body, '');
  } finally {
    server.close();
  }
});

test('the dev server applies _headers the same way production does', async () => {
  const server = createServer();
  const port = await listen(server);
  try {
    const shell = await get(port, '/');
    assert.equal(shell.headers['x-content-type-options'], 'nosniff');
    assert.equal(shell.headers['referrer-policy'], 'no-referrer');
    assert.match(shell.headers['content-security-policy'], /default-src 'self'/);
    assert.equal(shell.headers['cache-control'], 'no-cache');

    const worker = await get(port, '/sw.js');
    assert.equal(worker.headers['cache-control'], 'no-cache');
    assert.equal(worker.headers['service-worker-allowed'], '/');

    // Content-Length stays the server's business, never the policy file's.
    assert.equal(Number(shell.headers['content-length']) > 0, true);
  } finally {
    server.close();
  }
});

test('headersFor merges the catch-all block with the specific one', () => {
  const blocks = loadHeaders();
  assert.ok(blocks.length >= 5);
  const generic = headersFor('/nothing-here.txt', blocks);
  assert.equal(generic.get('Cache-Control'), 'public, max-age=0, must-revalidate');
  assert.equal(generic.has('Service-Worker-Allowed'), false);

  const worker = headersFor('/sw.js', blocks);
  assert.equal(worker.get('Cache-Control'), 'no-cache');
  assert.equal(worker.get('Service-Worker-Allowed'), '/');

  // Nested deploys (GitHub Pages project paths) still match.
  assert.equal(headersFor('/erome-userscript/app.js', blocks).get('Cache-Control'), 'no-cache');
  assert.deepEqual([...headersFor('/x', [])], []);
});
