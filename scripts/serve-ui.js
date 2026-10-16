// Static server for the terminal UI (frontend/) on http://localhost:3000.
// Replaces `python -m http.server`: no Python needed, and Content-Type is set explicitly
// (Python on Windows reads MIME types from the registry, which can make browsers treat
// index.html as a download -> net::ERR_ABORTED in Playwright).
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.UI_PORT || 3000);
const ROOT = path.resolve(__dirname, '..', 'frontend');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  if (urlPath.endsWith('/')) urlPath += 'index.html';

  const file = path.resolve(ROOT, '.' + urlPath);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      console.log(`404 ${req.method} ${req.url}`);
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use - close the other UI window and try again.`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

// No host argument: listens on both IPv4 and IPv6, so localhost works either way.
server.listen(PORT, () => {
  console.log(`Terminal UI serving ${ROOT}`);
  console.log(`  http://localhost:${PORT}   (Ctrl+C to stop)`);
});
