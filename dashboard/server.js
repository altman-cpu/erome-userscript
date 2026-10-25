'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 4200;
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const USERSCRIPT_PATH = path.resolve(__dirname, '..', 'erome.user.js');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  const reqPath = (req.url || '/').split('?')[0];

  // Serve the real Tampermonkey userscript directly from the repo root
  if (reqPath === '/erome.user.js') {
    fs.readFile(USERSCRIPT_PATH, (err, buf) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Unable to read erome.user.js');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(buf);
    });
    return;
  }

  // Synthetic local demo media paths respond cleanly without external network
  if (reqPath.startsWith('/demo-media/')) {
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    res.end();
    return;
  }

  if (reqPath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, brand: 'erome-clip-registry' }));
    return;
  }

  const safeRel = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '');
  const resolved = path.resolve(PUBLIC_DIR, safeRel);
  if (!resolved.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.stat(resolved, (err, stat) => {
    const target = !err && stat.isFile() ? resolved : path.join(PUBLIC_DIR, 'index.html');
    const ext = path.extname(target).toLowerCase();
    fs.readFile(target, (readErr, buf) => {
      if (readErr) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      res.end(buf);
    });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Angular Force Dashboard listening on http://${HOST}:${PORT}`);
});
