/* خادم محلي بسيط لتشغيل TV Hub Web على ويندوز بدون إنترنت.
   الاستعمال:  node server.cjs [المنفذ]
   ثم افتح:    http://localhost:8731                                    */
const http = require('http');
const fs   = require('fs');
const path = require('path');
const url  = require('url');

const ROOT = __dirname;
const PORT = Number(process.argv[2] || 8731);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
};

http.createServer((req, res) => {
  let p = decodeURIComponent(url.parse(req.url).pathname);
  if (p.endsWith('/')) p += 'index.html';

  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }

  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 ' + p);
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}).listen(PORT, () => {
  console.log('TV Hub Web يعمل على:  http://localhost:' + PORT);
  console.log('أغلق هذه النافذة لإيقافه.');
});
