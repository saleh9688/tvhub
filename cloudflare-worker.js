/**
 * ============================================================
 *  TV Hub — وسيط CORS جاهز لـ Cloudflare Workers
 * ============================================================
 *
 *  لماذا؟ المتصفح يمنع تشغيل أي بثّ لا يرسل ترويسة Access-Control-Allow-Origin،
 *  وهذه حال أغلب مضيفات HLS. الوسيط يجلب الملف من خادم — حيث لا قيد للمتصفح —
 *  ثم يمرّره لنا مع الترويسة المطلوبة.
 *
 *  كيف تنشره (دقيقتان، مجاني بلا بطاقة):
 *    1. سجّل في  https://dash.cloudflare.com  (بريد إلكتروني فقط)
 *    2. Workers & Pages → Create → Worker → اختر اسمًا → Deploy
 *    3. Edit code → امسح الكل → الصق هذا الملف → Deploy
 *    4. انسخ الرابط مثل  https://tvhub.USER.workers.dev
 *    5. في TV Hub: زرّ «الوسيط» → الصق
 *         https://tvhub.USER.workers.dev/?url=
 *       ثم «اختبار» فيجب أن يظهر «يعمل».
 *
 *  الاستعمال المباشر:
 *      /?url=https%3A%2F%2Fhost%2Fplaylist.m3u8
 *      /p/https://host/playlist.m3u8          (يتيح الروابط النسبية تلقائيًا)
 *
 *  الحصة المجانية: 100,000 طلب يوميًا — تكفي لاستعمال شخصي أو عائلي بلا قلق.
 * ============================================================
 */

/* اتركه فارغًا للاستعمال المفتوح، أو ضع كلمة سر لمنع الآخرين من استهلاك حصتك.
   ملاحظة: إن وضعتها فالصق في التطبيق عنوانًا كهذا (بـ ?k= قبل ?url=):
       https://tvhub.USER.workers.dev/?k=سرّي&url=                          */
const TOKEN = '';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
};

export default {
  async fetch(request) {
    // المتصفح يسأل أولًا عن المسموح — نجيبه بلا تنفيذ أي طلب
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return text('الطريقة غير مدعومة', 405);
    }

    const u = new URL(request.url);

    if (TOKEN && u.searchParams.get('k') !== TOKEN) {
      return text('مفتاح غير صحيح', 403);
    }

    const target = pickTarget(u);
    if (!target) return text('مرّر الرابط في ?url= أو بعد /p/', 400);

    let t;
    try { t = new URL(target); } catch (e) { return text('رابط غير صالح', 400); }
    if (t.protocol !== 'http:' && t.protocol !== 'https:') {
      return text('بروتوكول غير مدعوم', 400);
    }
    /* حماية من استغلال الوسيط للوصول إلى شبكة داخلية أو نقاط بيانات سحابية
       (169.254.169.254 مثلًا). الخدمة عامة، فلا يجوز أن تُستعمل جسرًا. */
    if (isPrivateHost(t.hostname)) {
      return text('العنوان الداخلي غير مسموح', 403);
    }

    const headers = {
      'User-Agent': UA,
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      // كثير من مضيفات HLS ترفض الطلب بلا Referer يطابق أصلها
      'Referer': t.origin + '/',
    };
    if (request.headers.has('Range')) headers['Range'] = request.headers.get('Range');

    let up;
    try {
      up = await fetch(t.toString(), {
        method: request.method,
        headers,
        redirect: 'follow',
      });
    } catch (e) {
      return text('تعذّر الوصول إلى المصدر: ' + (e && e.message ? e.message : e), 502);
    }

    const ct = (up.headers.get('content-type') || '').toLowerCase();
    const out = new Headers(CORS);
    out.set('Content-Type', up.headers.get('content-type') || 'application/octet-stream');
    out.set('Cache-Control', 'no-store');
    for (const h of ['content-range', 'accept-ranges', 'content-length']) {
      const v = up.headers.get(h);
      if (v) out.set(h, v);
    }

    /* القوائم النصية: نُصلح ما كان نسبيًا حتى تعمل بمعزل عن التطبيق أيضًا.
       في التطبيق لا يضرّ — hls.js يحلّ النسبي مقابل الرابط الأصلي أصلًا. */
    if (up.status === 200 && request.method !== 'HEAD') {
      const isHls = /mpegurl/.test(ct) || /\.m3u8(\?|$)/i.test(t.pathname);
      const isMpd = /dash\+xml/.test(ct) || /\.mpd(\?|$)/i.test(t.pathname);

      if (isHls || isMpd) {
        let body;
        try { body = await up.text(); }
        catch (e) { return new Response(up.body, { status: 200, headers: out }); }
        body = isHls ? fixHls(body, t) : fixDash(body, t);
        out.set('Content-Type', isHls ? 'application/vnd.apple.mpegurl' : 'application/dash+xml');
        out.delete('content-length');
        return new Response(body, { status: 200, headers: out });
      }
    }

    // الوسائط (المقاطع) تمرّ كتدفّق بلا تحميل كامل في الذاكرة
    return new Response(up.body, { status: up.status, headers: out });
  },
};

/** يقرأ الهدف من ?url= أو من المسار بعد /p/ */
function pickTarget(u) {
  const q = u.searchParams.get('url');
  if (q) return q;
  if (u.pathname.startsWith('/p/')) {
    return decodeURIComponent(u.pathname.slice(3));
  }
  return null;
}

function text(msg, status) {
  const h = new Headers(CORS);
  h.set('Content-Type', 'text/plain; charset=utf-8');
  return new Response(msg, { status, headers: h });
}

/** يمنع استعمال الوسيط جسرًا إلى شبكة داخلية أو نقاط بيانات سحابية. */
function isPrivateHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h === '0.0.0.0' || h === '::' || h === '::1') return true;

  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;            // link-local والشبكة السحابية
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;  // CGNAT
    if (a >= 224) return true;                          // multicast/mahfuz
    return false;
  }

  if (h.includes(':')) {
    if (/^f[cd]/.test(h)) return true;                  // ULA
    if (/^fe[89ab]/.test(h)) return true;               // link-local
    if (h.startsWith('::ffff:')) return isPrivateHost(h.slice(7));
  }
  return false;
}

/** يحوّل رابطًا نسبيًا إلى مطلق مقابل الرابط الأصلي. */
function absolute(uri, base) {
  const s = String(uri || '').trim();
  if (!s) return uri;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;   // مطلق أو data:
  try { return new URL(s, base).href; } catch (e) { return uri; }
}

/** HLS: الأسطر التي ليست تعليقًا هي روابط مقاطع، وداخل الوسوم URI="…" */
function fixHls(body, base) {
  return body.split('\n').map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) {
      return line.replace(/URI="([^"]*)"/gi, (m, p1) => 'URI="' + absolute(p1, base) + '"');
    }
    return absolute(t, base);
  }).join('\n');
}

/**
 * DASH: القوالب النسبية تحتاج مرجعًا. نُصلح BaseURL إن وُجد، وإلا نحقن واحدًا
 * مطلقًا من مجلد الملف الأصلي — فتُحلّ كل قوالب المقاطع تجاه المضيف الصحيح.
 */
function fixDash(body, base) {
  const dir = new URL('.', base).href;
  if (/<BaseURL>/i.test(body)) {
    return body.replace(/<BaseURL>([^<]*)<\/BaseURL>/gi, (m, p1) =>
      '<BaseURL>' + absolute(p1, dir).replace(/&/g, '&amp;') + '</BaseURL>');
  }
  return body.replace(/(<MPD\b[^>]*>)/i,
    '$1<BaseURL>' + dir.replace(/&/g, '&amp;') + '</BaseURL>');
}
