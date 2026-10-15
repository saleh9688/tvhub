/* خادم محلي لتشغيل TV Hub Web على ويندوز، مع وسيط CORS.

   الاستعمال:  node server.cjs [المنفذ]     ثم افتح http://localhost:8731

   لماذا الوسيط؟ كثير من مضيفات البث لا ترسل ترويسة Access-Control-Allow-Origin،
   فيمنع المتصفح قراءة قائمة التشغيل أو المقاطع رغم أن الرابط سليم. الخادم لا
   يخضع لقيد المتصفح، فيجلب الملف ثم يعيده لنا مع الترويسة المطلوبة.
   مثال:  /proxy?url=https%3A%2F%2Fsoccerfull.net%2Fhls%2F14254.m3u8          */
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const ROOT = __dirname;
const PORT = Number(process.argv[2] || 8731);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.mpd':  'application/dash+xml',
  '.ts':   'video/mp2t',
  '.mp4':  'video/mp4',
};

function allowCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', '*');
}

/** يمرّر طلبًا واحدًا إلى المصدر ويعيد الجسم كما وصل. */
function pipeThrough(req, res, target, referer) {
  let u;
  try { u = new URL(target); }
  catch (e) { allowCors(res); res.writeHead(400); return res.end('bad url'); }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    allowCors(res); res.writeHead(400); return res.end('bad scheme');
  }

  const headers = {
    'User-Agent': UA,
    'Accept': '*/*',
    // كثير من مضيفات HLS ترفض الطلب بلا Referer يطابق أصلها
    'Referer': referer || (u.origin + '/'),
  };
  if (req.headers.range) headers['Range'] = req.headers.range;

  const mod = u.protocol === 'https:' ? https : http;
  const up = mod.request(u, { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers }, (r) => {
    allowCors(res);
    res.writeHead(r.statusCode || 502, {
      'Content-Type': r.headers['content-type'] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    r.pipe(res);
  });

  up.on('error', (e) => {
    if (res.headersSent) return res.destroy();
    allowCors(res);
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('proxy error: ' + e.message);
  });
  up.setTimeout(25000, () => up.destroy(new Error('timeout')));
  up.end();
}

http.createServer((req, res) => {
  let parsed;
  try { parsed = new URL(req.url, 'http://localhost'); }
  catch (e) { res.writeHead(400); return res.end(); }

  if (req.method === 'OPTIONS') { allowCors(res); res.writeHead(204); return res.end(); }

  /* ---------- الوسيط ---------- */
  if (parsed.pathname === '/proxy') {
    const target = parsed.searchParams.get('url');
    if (!target) { allowCors(res); res.writeHead(400); return res.end('missing url'); }
    return pipeThrough(req, res, target, parsed.searchParams.get('ref'));
  }

  /* ---------- الملفات ---------- */
  let p = decodeURIComponent(parsed.pathname);
  if (p.endsWith('/')) p += 'index.html';

  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }

  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 ' + p);
    }
    allowCors(res);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}).listen(PORT, () => {
  console.log('TV Hub Web يعمل على:  http://localhost:' + PORT);
  console.log('الوسيط متاح على:      http://localhost:' + PORT + '/proxy?url=…');
  console.log('أغلق هذه النافذة لإيقاف الخادم.');
});
