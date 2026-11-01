// Local dev: serve public/ from this checkout, proxy /api/* to the server's
// edge-display over an SSH tunnel so the page runs on live data.
const { spawn } = require('node:child_process');
const Fs = require('node:fs');
const Http = require('node:http');
const Path = require('node:path');

const HOST = process.env.EDGE_HOST || 'cailin-server';
const PORT = Number(process.env.PORT || 8788);
const TUNNEL_PORT = 8789;
const REMOTE_PORT = Number(process.env.EDGE_REMOTE_PORT || require('../config.json').port);
const PUBLIC_DIR = Path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json' };

const tunnel = spawn('ssh', ['-N', '-L', `${TUNNEL_PORT}:127.0.0.1:${REMOTE_PORT}`, HOST], { stdio: 'inherit' });
process.on('exit', () => tunnel.kill());
process.on('SIGINT', () => process.exit());

Http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) {
    const up = Http.get({ port: TUNNEL_PORT, path: req.url }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', (e) => res.writeHead(502).end(e.message));
    return;
  }
  const p = new URL(req.url, 'http://x').pathname;
  const file = Path.join(PUBLIC_DIR, p === '/' ? 'index.html' : p);
  Fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': MIME[Path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`dev on http://localhost:${PORT} (api via ${HOST})`));
