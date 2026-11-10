'use strict';

/*
 * Dependency-free static server for the HUD.
 *
 * Service workers only run on https:// or localhost, so `file://` cannot test
 * the routing engine. This serves the repository as-is on localhost with the
 * right content types, no directory listing, and no path traversal.
 *
 *   node scripts/serve.js               # http://localhost:8000
 *   node scripts/serve.js --port 9000
 *   PORT=9000 HOST=0.0.0.0 node scripts/serve.js
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_PORT = 8000;

const TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
  ['.png', 'image/png'],
  ['.webmanifest', 'application/manifest+json'],
]);

function parseArgs(argv) {
  const options = { port: Number(process.env.PORT) || DEFAULT_PORT, host: process.env.HOST || '127.0.0.1' };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port' && argv[i + 1]) {
      options.port = Number(argv[i + 1]);
      i += 1;
    } else if (arg === '--host' && argv[i + 1]) {
      options.host = argv[i + 1];
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    }
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error(`invalid port: ${options.port}`);
  }
  return options;
}

/**
 * Reads `_headers` (the Cloudflare Pages / Netlify format) so the local preview
 * applies exactly the same security and cache policy as production.
 * Returns [{ pattern, headers: Map }].
 */
function loadHeaders(root) {
  const file = path.join(root || ROOT, '_headers');
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return [];
  }
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
    if (!current) {
      return;
    }
    const index = line.indexOf(':');
    if (index > 0) {
      current.headers.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
    }
  });
  return blocks;
}

/** Merges the catch-all block with the most specific matching block. */
function headersFor(urlPath, blocks) {
  const merged = new Map();
  if (!blocks || blocks.length === 0) {
    return merged;
  }
  const generic = blocks.find((block) => block.pattern === '/*');
  if (generic) {
    generic.headers.forEach((value, key) => merged.set(key, value));
  }
  blocks
    .filter((block) => block.pattern !== '/*' && (urlPath === block.pattern || urlPath.endsWith(block.pattern)))
    .forEach((block) => {
      block.headers.forEach((value, key) => merged.set(key, value));
    });
  return merged;
}

/** Maps a request path to a file inside ROOT, or null when it escapes. */
function resolvePath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch (error) {
    return null;
  }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const resolved = path.resolve(ROOT, relative);
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
    return null;
  }
  return resolved;
}

function createServer(options) {
  const settings = options || {};
  const extraHeaders = settings.headers || loadHeaders(settings.root || ROOT);
  return http.createServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
      response.end('method not allowed\n');
      return;
    }

    const target = resolvePath(request.url || '/');
    if (!target) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('forbidden\n');
      return;
    }

    fs.stat(target, (statError, stats) => {
      if (statError || !stats.isFile()) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('not found\n');
        return;
      }
      const type = TYPES.get(path.extname(target).toLowerCase()) || 'application/octet-stream';
      const headers = {
        'content-type': type,
        'content-length': stats.size,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      };
      const urlPath = `/${path.relative(settings.root || ROOT, target).split(path.sep).join('/')}`;
      headersFor(urlPath, extraHeaders).forEach((value, key) => {
        // Content-Length is the server's business; everything else is policy.
        if (key.toLowerCase() !== 'content-length') {
          headers[key.toLowerCase()] = value;
        }
      });
      response.writeHead(200, headers);
      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      fs.createReadStream(target)
        .on('error', () => {
          response.destroy();
        })
        .pipe(response);
    });
  });
}

if (require.main === module) {
  const options = parseArgs(process.argv);
  if (options.help) {
    process.stdout.write('usage: node scripts/serve.js [--port 8000] [--host 127.0.0.1]\n');
    process.exit(0);
  }
  const server = createServer();
  server.listen(options.port, options.host, () => {
    process.stdout.write(`GRID//CORE shell on http://${options.host}:${options.port}/\n`);
    process.stdout.write('service worker requires localhost or https — this counts\n');
  });
  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createServer, resolvePath, parseArgs, loadHeaders, headersFor, ROOT };
