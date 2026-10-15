/* ============================================================
   TV Hub — نسخة الويب
   واجهة عربية لكتالوج قنوات SportzX + مشغّل مدمج
   لا تتصل بأي خدمة خارجية: كل شيء محلي (كتالوج + مكتبتا تشغيل).
   ============================================================ */
'use strict';

/* ---------- أدوات مساعدة ---------- */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const LS = {
  fav:   'tvhubweb.favorites.v1',
  hist:  'tvhubweb.history.v1',
  probe: 'tvhubweb.probe.v1',
  only:  'tvhubweb.onlyWorking.v1',
};

const PROBE_TTL = 6 * 60 * 60 * 1000;   // 6 ساعات: المصادر الحيّة تموت وتعود
const SCAN_CAP  = 150;                  // سقف الفحص اليدوي
const MAX_AUTO  = 12;                   // سقف التبديل التلقائي

/* ---------- الحالة ---------- */
const S = {
  catalog: null, cats: null,
  vmap: new Map(),            // link -> بيانات الفحص المدمج
  probe: new Map(),           // link -> {ok, st, at, src}  (قياس هذا الجهاز)
  byId: new Map(),
  byStreamTitle: new Map(),
  byChannelTitle: new Map(),
  chNorm: [],
  resCache: new Map(),
  evCache: new Map(),
  fav: new Set(),
  hist: [],
  tab: 'live',
  catId: null,
  channel: null,
  event: null,
  only: false,
  query: '',
  scanning: false,
  scanned: 0,
  scanTotal: 0,
};

let hls = null, dash = null;
let curList = [], curIdx = -1, curBase = '', curTries = 0;

/* ============================================================
   تطبيع الأسماء — نفس منطق نسخة أندرويد
   ============================================================ */
const NOISE = /\b(fhd|uhd|hd|sd|4k|8k|hevc|h265|h264|backup|server|live|channel|the)\b/g;

function norm(s) {
  return String(s || '')
    .replace(/[\u064B-\u0652\u0670]/g, '')               // تشكيل
    .replace(/[\[\](){}«»"'’`.,:_\-\/\\|+*&^%$#@!~؛،؟]/g, ' ')
    .replace(NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
const WORDS = s => norm(s).split(' ').filter(Boolean);

/* ============================================================
   مفاتيح Widevine / ClearKey
   الشكل الغالب في الكتالوج: «KID:KEY» ست عشري، وله أشكال أخرى.
   ============================================================ */
const HEX32 = v => /^[0-9a-fA-F]{32}$/.test(v || '');

function b64ToHex(b) {
  try {
    const bin = atob(String(b).replace(/-/g, '+').replace(/_/g, '/'));
    let out = '';
    for (let i = 0; i < bin.length; i++) out += bin.charCodeAt(i).toString(16).padStart(2, '0');
    return HEX32(out) ? out : null;
  } catch (e) { return null; }
}

/**
 * يقرأ حقل api ويُرجع {kid,key} أو null.
 * يتجاهل المفاتيح التالفة (بعض الناشرين يحقن بايتات عشوائية وسط hex)
 * وعندها نتخطّى المصدر تلقائيًا بدل عرض رسالة طلب سيرفر ترخيص.
 */
function parseApi(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;

  if (s[0] === '{') {                              // مستند ClearKey جاهز
    try {
      const j = JSON.parse(s);
      const k = (j.keys || [])[0];
      if (k && k.kid && k.k) {
        const kid = b64ToHex(k.kid) || (HEX32(k.kid) ? k.kid : null);
        const key = b64ToHex(k.k)   || (HEX32(k.k)   ? k.k   : null);
        if (kid && key) return { kid: kid.toLowerCase(), key: key.toLowerCase() };
      }
    } catch (e) { /* تجاهل */ }
    return null;
  }

  if (/^https?:/i.test(s)) return null;            // رابط خدمة ClearKey — لا يُستعمل هنا

  const p = s.split(':').map(x => x.trim()).filter(Boolean);
  if (p.length === 2 && HEX32(p[0]) && HEX32(p[1]))
    return { kid: p[0].toLowerCase(), key: p[1].toLowerCase() };

  return null;
}

/* ============================================================
   حالة المصادر: قياس هذا الجهاز أولًا، ثم الفحص المدمج
   ============================================================ */
function loadProbe() {
  try {
    const j = JSON.parse(localStorage.getItem(LS.probe) || '{}');
    const now = Date.now();
    for (const [k, v] of Object.entries(j))
      if (v && now - (v.at || 0) < PROBE_TTL) S.probe.set(k, v);
  } catch (e) { /* تجاهل */ }
}
function persistProbe() {
  try {
    const o = {};
    for (const [k, v] of S.probe) o[k] = v;
    localStorage.setItem(LS.probe, JSON.stringify(o));
  } catch (e) { /* الحجم ممتلئ — تجاهل */ }
}

function stateOf(s) {
  if (!s || !s.link) return null;
  if (S.probe.has(s.link)) return S.probe.get(s.link);        // قياس هذا الجهاز = المرجع
  const v = S.vmap.get(s.link);
  return v ? { ok: !!v.media, st: v.st, at: 0, src: 'bundled' } : null;
}
const isGood    = s => { const p = stateOf(s); return !!(p && p.ok); };
const isChecked = s => !!stateOf(s);

function sortStreams(list) {
  return list.map((s, i) => ({ s, i }))
    .sort((a, b) =>
      (isGood(b.s) - isGood(a.s)) ||
      (isChecked(b.s) - isChecked(a.s)) ||
      (a.i - b.i))
    .map(x => x.s);
}

/* ============================================================
   حلّ الأسماء — بطاقات الموفّرين تحمل أسماء لا روابط
   ============================================================ */
function buildIndex() {
  S.byStreamTitle = new Map();
  S.byChannelTitle = new Map();
  S.chNorm = [];

  for (const ch of S.catalog.channels) {
    const ct = norm(ch.title);
    if (ct && !S.byChannelTitle.has(ct)) S.byChannelTitle.set(ct, ch);
    for (const s of ch.streams || []) {
      const st = norm(s.title);
      if (!st) continue;
      if (!S.byStreamTitle.has(st)) S.byStreamTitle.set(st, new Set());
      S.byStreamTitle.get(st).add(ch.id);
    }
    S.chNorm.push({ id: ch.id, n: ct, w: WORDS(ch.title) });
  }
}

function resolveNames(names) {
  const key = names.join('|');
  if (S.resCache.has(key)) return S.resCache.get(key);

  const out = [], seen = new Set();
  const add = ch => { if (ch && !seen.has(ch.id)) { seen.add(ch.id); out.push(ch); } };

  for (const raw of names) {
    const n = norm(raw);
    if (!n) continue;
    const w = WORDS(raw);

    // 1) مطابقة تامة لاسم البثّ
    let hit = false;
    const ids = S.byStreamTitle.get(n);
    if (ids) { for (const id of ids) add(S.byId.get(id)); hit = true; }
    if (hit) continue;

    // 2) مطابقة تامة لاسم القناة
    const c = S.byChannelTitle.get(n);
    if (c) { add(c); continue; }

    // 3) ضبابية: كل كلمات الاسم موجودة في اسم القناة
    if (w.length) {
      for (const e of S.chNorm) {
        if (!e.n) continue;
        let all = true;
        for (const x of w) if (!e.n.includes(x)) { all = false; break; }
        if (all) { add(S.byId.get(e.id)); hit = true; }
      }
    }
    if (hit) continue;

    // 4) تعويض بالعلامة: «BeIN Sports 2» غير موجود حرفيًا، فنجمع كل ما يبدأ بـ«bein»
    const brand = w[0];
    if (brand && brand.length >= 3) {
      for (const e of S.chNorm) {
        if (e.n.startsWith(brand)) add(S.byId.get(e.id));
      }
    }
  }

  const v = out.filter(Boolean);
  S.resCache.set(key, v);
  return v;
}

const isProvider = ch => !!ch && (ch.streams || []).length === 0 && (ch.formats || []).length > 0;

/**
 * مفتاح مميّز للعنصر.
 * مهم: معرّفات بطاقات الموفّرين تتقاطع مع معرّفات القنوات — كلتاهما يبدأ
 * من 1. فبطاقة «TNT Sports» رقمها 1، والقناة «TNT Sports 1» رقمها 1 أيضًا.
 * بلا هذا الفصل يُفتح العنصر الخطأ عند الضغط.
 */
const keyOf = ch => (isProvider(ch) ? 'p:' : 'c:') + ch.id;

/** مصادر أي عنصر: قناة عادية، أو بطاقة موفّر تُحلّ عبر formats */
function channelStreams(ch) {
  if (!ch) return [];
  if (ch.streams && ch.streams.length)
    return ch.streams.map(s => ({ ...s, _ch: ch.title }));
  if (ch.formats && ch.formats.length)
    return resolvedStreams(ch.formats);
  return [];
}
function resolvedStreams(names) {
  const out = [], seen = new Set();
  for (const ch of resolveNames(names))
    for (const s of (ch.streams || [])) {
      if (!s.link || seen.has(s.link)) continue;
      seen.add(s.link);
      out.push({ ...s, _ch: ch.title });
    }
  return out;
}

function goodCount(ch) { return channelStreams(ch).filter(isGood).length; }

function eventStreams(ev) {
  if (S.evCache.has(ev.id)) return S.evCache.get(ev.id);
  const v = resolvedStreams(ev.formats || []);
  S.evCache.set(ev.id, v);
  return v;
}

/* ============================================================
   الوقت
   SportzX يكتب «2026/10/23 05:30:00 +0000»
   ============================================================ */
function parseWhen(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s*([+-]\d{4})?/);
  if (!m) return null;
  const [, Y, M, D, h, mi, se, tz] = m;
  const off = tz ? tz.slice(0, 3) + ':' + tz.slice(3) : '+00:00';
  const d = new Date(`${Y}-${M}-${D}T${h}:${mi}:${se}${off}`);
  return isNaN(d) ? null : d;
}
function humanAgo(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'قبل لحظات';
  if (s < 3600) return `قبل ${Math.round(s / 60)} دقيقة`;
  if (s < 86400) return `قبل ${Math.round(s / 3600)} ساعة`;
  return `قبل ${Math.round(s / 86400)} يوم`;
}
function eventStatus(ev) {
  const a = parseWhen(ev.eventInfo && ev.eventInfo.startTime);
  const b = parseWhen(ev.eventInfo && ev.eventInfo.endTime);
  const now = Date.now();
  if (!a) return { key: 'unknown', label: '' };
  if (b && now > b.getTime()) return { key: 'ended', label: 'انتهت' };
  if (now >= a.getTime()) return { key: 'live', label: 'يُبثّ الآن' };
  const h = Math.round((a.getTime() - now) / 3600000);
  return { key: 'soon', label: h <= 1 ? 'تبدأ خلال ساعة' : `تبدأ بعد ${h} ساعة` };
}
const ORD = { live: 0, soon: 1, unknown: 2, ended: 3 };

/* ============================================================
   الإقلاع
   ============================================================ */
/* ============================================================
   مصدر البيانات الوحيد
   عند قفل الموقع تُقرأ البيانات من الخزنة المفكوكة (TVHubAuth.load)
   ولا يُطلب أي ملف JSON صريح — فلا يبقى محتوى يمكن الوصول إليه
   بلا بيانات الدخول. ولو لم يكن الموقع مقفلًا نرجع للتحميل العادي.
   ============================================================ */
let DATA_PROMISE = null;
function loadAll() {
  if (!DATA_PROMISE) DATA_PROMISE = TVHubAuth.load();
  return DATA_PROMISE;
}

async function loadJSON(p) {
  const v = await loadAll();
  const fromVault = {
    'data/catalog.json': v.catalog,
    'data/categories.json': v.categories,
    'data/verified.json': v.verified,
  }[p];
  if (fromVault) return fromVault;

  const r = await fetch(p, { cache: 'no-store' });
  if (!r.ok) throw new Error(p + ' → ' + r.status);
  return r.json();
}

async function boot() {
  try {
    const [catalog, cats] = await Promise.all([
      loadJSON('data/catalog.json'),
      loadJSON('data/categories.json'),
    ]);
    S.catalog = catalog;
    S.cats = cats;

    for (const ch of catalog.channels) S.byId.set(String(ch.id), ch);
    S.chMap = new Map();
    for (const c of catalog.channels) S.chMap.set('c:' + c.id, c);
    for (const cat of cats.categories || [])
      for (const ch of cat.channels || []) {
        const k = keyOf(ch);
        if (!S.chMap.has(k)) S.chMap.set(k, ch);
      }
    buildIndex();

    // ملف الفحص المدمج — اختياري: لو غاب نكمل بلا وسم «متحقَّق»
    try {
      const v = await loadJSON('data/verified.json');
      for (const [link, e] of Object.entries(v.links || {})) S.vmap.set(link, e);
    } catch (e) { /* اختياري */ }

    loadProbe();
    try { S.fav = new Set(JSON.parse(localStorage.getItem(LS.fav) || '[]')); } catch (e) {}
    try { S.hist = JSON.parse(localStorage.getItem(LS.hist) || '[]'); } catch (e) {}
    S.only = localStorage.getItem(LS.only) === '1';

    applyQuery();
    syncWorkingChip();
    renderTabs();
    render();
  } catch (e) {
    $('#list').innerHTML =
      `<div class="empty">تعذّر تحميل البيانات.<br><br><b>${esc(e.message)}</b><br><br>
       افتح الصفحة عبر خادم محلي أو من الرابط المنشور — المتصفح يمنع قراءة الملفات مباشرة.</div>`;
    setStatus('خطأ في التحميل', true);
  }
}

/* ============================================================
   روابط مباشرة — تفيد المشاركة والاختبار الآلي
   ?tab=working | ?ch=c:1 | ?ch=p:2 | ?ev=50002 | ?only=1
   ============================================================ */
function applyQuery() {
  let q;
  try { q = new URLSearchParams(location.search); } catch (e) { return; }

  if (q.get('only') === '1') S.only = true;

  const tab = q.get('tab');
  if (tab && TABS.some(t => t.id === tab)) S.tab = tab;

  const ch = q.get('ch');
  if (ch) {
    let obj = null;
    if (/^[cp]:/.test(ch)) obj = S.chMap.get(ch);
    else obj = S.chMap.get('c:' + ch) || S.chMap.get('p:' + ch);
    if (obj) { S.channel = obj; if (!tab) S.tab = 'channels'; }
  }

  const ev = q.get('ev');
  if (ev) {
    const e = (S.cats.events || []).find(x => String(x.id) === String(ev));
    if (e) { S.event = e; S.tab = 'live'; }
  }
}

/* ============================================================
   الشريط السفلي والتنبيهات
   ============================================================ */
function setStatus(txt, busy) {
  $('#status').innerHTML = `<span class="dot${busy ? ' busy' : ''}"></span><span>${esc(txt)}</span>`;
}
function toast(msg, ms) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms || 2600);
}

function baseStatus() {
  const n = S.catalog ? S.catalog.meta.counts : null;
  if (!n) return;
  const measured = S.probe.size;
  let s = `${n.channelsWithStreams} قناة · ${n.uniqueStreams} مصدر`;
  if (measured) s += ` · قِيس من هذا الجهاز: ${measured} مصدر`;
  setStatus(s);
}

/* ============================================================
   التبويبات
   ============================================================ */
const TABS = [
  { id: 'live',     label: 'مباشر' },
  { id: 'cats',     label: 'التصنيفات' },
  { id: 'channels', label: 'القنوات' },
  { id: 'fav',      label: 'المفضلة' },
  { id: 'recent',   label: 'الأخيرة' },
  { id: 'working',  label: 'تعمل الآن' },
];

function renderTabs() {
  $('#tabs').innerHTML = TABS.map(t =>
    `<button class="tab${S.tab === t.id ? ' on' : ''}" data-tab="${t.id}">${esc(t.label)}</button>`
  ).join('');
}

function goTab(id) {
  S.tab = id;
  S.catId = null; S.channel = null; S.event = null;
  renderTabs(); render();
}

/* ============================================================
   رسم الصفوف
   ============================================================ */
function protocolClass(p) {
  const k = String(p || '').toLowerCase();
  if (k === 'dash') return 'dash';
  if (k === 'hls') return 'hls';
  if (k === 'youtube') return 'yt';
  if (k === 'file') return 'file';
  return 'web';
}

function rowEventHTML(ev) {
  const st = eventStatus(ev);
  const streams = eventStreams(ev);
  const good = streams.filter(isGood).length;
  const info = ev.eventInfo || {};
  const fav = S.fav.has('e:' + ev.id);
  const sub = [
    st.label,
    `${streams.length} مصدر`,
    good ? `يعمل: ${good}` : null,
    info.eventName || null,
  ].filter(Boolean).join(' · ');

  return `<div class="row" data-act="ev" data-id="${esc(ev.id)}">
    <span class="badge ${st.key === 'live' ? 'ok' : st.key === 'ended' ? 'web' : 'hls'}">${
      st.key === 'live' ? 'مباشر' : st.key === 'ended' ? 'انتهت' : 'قادم'}</span>
    <div class="rMain">
      <div class="rTitle${good ? ' good' : ''}">${esc(ev.title || info.eventName || 'حدث')}</div>
      <div class="rSub">${esc(sub)}</div>
    </div>
    <button class="star${fav ? ' on' : ''}" data-act="fav" data-key="e:${esc(ev.id)}"
      title="مفضلة">★</button>
  </div>`;
}

function rowChannelHTML(ch) {
  const streams = channelStreams(ch);
  const good = streams.filter(isGood).length;
  const prov = isProvider(ch);
  const protos = [...new Set(streams.map(s => (s.protocol || '?').toUpperCase()))].slice(0, 3);
  const key = keyOf(ch);
  const fav = S.fav.has(key);

  const sub = [
    prov ? 'موفّر' : null,
    `${streams.length} مصدر`,
    protos.join('/'),
    good ? `يعمل: ${good}` : null,
  ].filter(Boolean).join(' · ');

  return `<div class="row" data-act="ch" data-key="${esc(key)}">
    <div class="rMain">
      <div class="rTitle${good ? ' good' : ''}">${esc(ch.title || 'قناة')}</div>
      <div class="rSub">${esc(sub)}</div>
    </div>
    <button class="star${fav ? ' on' : ''}" data-act="fav" data-key="${esc(key)}"
      title="مفضلة">★</button>
  </div>`;
}

function rowStreamHTML(s, i) {
  const checked = isChecked(s);
  const good = isGood(s);
  const ck = parseApi(s.api);
  const proto = (s.protocol || s.kind || '?').toUpperCase();
  const cls = good ? 'ok' : (checked ? 'mid' : 'no');

  let note;
  if (good && ck) note = 'مصدر يعمل — مُتحقَّق منه · مفتاح ClearKey مدمج — يُفكّ محليًا بلا سيرفر';
  else if (good) note = 'مصدر يعمل — مُتحقَّق منه على هذا الجهاز';
  else if (checked) note = 'استجاب لكن بلا وسائط مؤكّدة — قد لا يعمل';
  else if (ck) note = 'مفتاح ClearKey مدمج — لم يُفحص بعد';
  else if (s.drm) note = 'محمي بـWidevine — مفتاحه غير صالح في المصدر نفسه';
  else note = 'لم يُفحص بعد — قد لا يعمل';

  const badgeTxt = proto + (good ? ' ✓' : '');
  const badgeCls = good ? 'ok' : protocolClass(proto);

  return `<div class="row" data-act="play" data-i="${i}">
    <span class="badge ${badgeCls}">${esc(badgeTxt)}</span>
    <div class="rMain">
      <div class="rTitle${good ? ' good' : ''}">${esc(s.title || 'مصدر')}</div>
      <div class="rSub">${esc(s.host || s.link || '')}</div>
      <div class="rFlags ${cls}">${esc(note)}</div>
    </div>
  </div>`;
}

/* ============================================================
   الرئيسية
   ============================================================ */
function render() {
  renderTabs();
  const L = $('#list');
  const sub = $('#subbar');

  if (S.tab === 'live')     return renderLive(L, sub);
  if (S.tab === 'cats')     return renderCats(L, sub);
  if (S.tab === 'channels') return renderChannels(L, sub);
  if (S.tab === 'fav')      return renderFav(L, sub);
  if (S.tab === 'recent')   return renderRecent(L, sub);
  if (S.tab === 'working')  return renderWorking(L, sub);
}

function emptyBox(title, hint) {
  return `<div class="empty"><b>${esc(title)}</b>${hint ? '<br><br>' + esc(hint) : ''}</div>`;
}

/* ---------- مباشر ---------- */
function renderLive(L, sub) {
  // شاشة مباراة مفتوحة؟ اعرضها بدل القائمة
  if (S.event) return renderEvent(L, sub);

  sub.classList.add('hidden');
  S.catId = null; S.channel = null;

  const q = norm(S.query);
  let evs = (S.cats.events || []).map(ev => ({ ev, st: eventStatus(ev) }));
  if (q) evs = evs.filter(x => norm(x.ev.title).includes(q) || norm(x.ev.eventInfo && x.ev.eventInfo.eventName).includes(q));
  if (S.only) evs = evs.filter(x => eventStreams(x.ev).some(isGood));

  evs.sort((a, b) => (ORD[a.st.key] - ORD[b.st.key]) ||
    ((parseWhen(a.ev.eventInfo && a.ev.eventInfo.startTime)?.getTime() || 0) -
     (parseWhen(b.ev.eventInfo && b.ev.eventInfo.startTime)?.getTime() || 0)));

  const liveN = evs.filter(x => x.st.key === 'live').length;
  baseStatus();
  if (!evs.length) return void (L.innerHTML = emptyBox('لا توجد مباريات مطابقة',
    S.only ? 'جرّب إطفاء «يعمل فقط».' : 'جرّب كلمة بحث أخرى.'));

  L.innerHTML =
    `<div class="catHead">يُبثّ الآن: ${liveN} · الإجمالي: ${evs.length} مباراة</div>` +
    evs.map(x => rowEventHTML(x.ev)).join('');
}

/* ---------- التصنيفات ---------- */
function renderCats(L, sub) {
  if (S.channel) return renderChannel(L, sub);

  if (S.catId) {
    const cat = (S.cats.categories || []).find(c => String(c.id) === String(S.catId));
    if (!cat) { S.catId = null; return renderCats(L, sub); }
    sub.classList.remove('hidden');
    $('#subTitle').textContent = cat.title || 'تصنيف';
    let chs = cat.channels || [];
    $('#subMeta').textContent = `${chs.length} عنصر`;
    L.innerHTML = chs.map(rowChannelHTML).join('') ||
      emptyBox('لا عناصر في هذا التصنيف');
    return;
  }

  sub.classList.add('hidden');
  const q = norm(S.query);
  let cats = S.cats.categories || [];
  if (q) cats = cats.filter(c => norm(c.title).includes(q) || norm(c.catLink).includes(q));

  if (S.only) {
    cats = cats.filter(c => (c.channels || []).some(ch => {
      const st = channelStreams(ch);
      return st.some(isGood) || (st.length > 0 && (!ch.streams || !ch.streams.length));
    }));
  }

  if (!cats.length) return void (L.innerHTML = emptyBox('لا تصنيفات مطابقة'));

  L.innerHTML = cats.map(c => {
    const chs = c.channels || [];
    return `<div class="row" data-act="cat" data-id="${esc(c.id)}">
      <div class="rMain">
        <div class="rTitle">${esc(c.title || 'تصنيف')}</div>
        <div class="rSub">${chs.length} عنصر</div>
      </div>
      <span class="badge web">›</span>
    </div>`;
  }).join('');
}

/* ---------- القنوات ---------- */
function renderChannels(L, sub) {
  if (S.channel) return renderChannel(L, sub);
  sub.classList.add('hidden');

  const q = norm(S.query);
  let chs = S.catalog.channels;
  if (q) chs = chs.filter(c => norm(c.title).includes(q) ||
    (c.streams || []).some(s => norm(s.title).includes(q)));

  if (S.only) chs = chs.filter(c => goodCount(c) > 0);

  const shown = chs.slice(0, 800);
  baseStatus();
  if (!shown.length) return void (L.innerHTML = emptyBox('لا قنوات مطابقة',
    S.only ? 'جرّب إطفاء «يعمل فقط».' : null));

  L.innerHTML =
    `<div class="catHead">${chs.length} قناة${chs.length > shown.length ? ` · يُعرض ${shown.length}` : ''}</div>` +
    shown.map(rowChannelHTML).join('');
}

/* ---------- المفضلة ---------- */
function renderFav(L, sub) {
  sub.classList.add('hidden');
  const ids = [...S.fav];
  if (!ids.length) return void (L.innerHTML =
    emptyBox('لا مفضلة بعد', 'اضغط النجمة ★ على أي قناة أو مباراة لإضافتها.'));

  const chs = [], evs = [];
  for (const k of ids) {
    const [t, id] = k.split(':');
    if (t === 'c' || t === 'p') { const c = S.chMap.get(k); if (c) chs.push(c); }
    if (t === 'e') {
      const e = (S.cats.events || []).find(x => String(x.id) === String(id));
      if (e) evs.push(e);
    }
  }

  let html = '';
  if (evs.length) html += `<div class="catHead">مباريات محفوظة</div>` + evs.map(rowEventHTML).join('');
  if (chs.length) html += `<div class="catHead">قنوات محفوظة</div>` + chs.map(rowChannelHTML).join('');
  L.innerHTML = html || emptyBox('لا مفضلة بعد');
}

/* ---------- الأخيرة ---------- */
function renderRecent(L, sub) {
  sub.classList.add('hidden');
  if (!S.hist.length) return void (L.innerHTML =
    emptyBox('لا سجل تشغيل بعد', 'شغّل أي مصدر وسيظهر هنا.'));

  L.innerHTML = `<div class="catHead">آخر ${S.hist.length} تشغيل</div>` +
    S.hist.map(h => `<div class="row" data-act="hist" data-key="${esc(h.key)}">
      <div class="rMain">
        <div class="rTitle">${esc(h.title)}</div>
        <div class="rSub">${esc(h.sub || '')} · ${esc(humanAgo(h.at))}</div>
      </div>
    </div>`).join('') +
    `<div style="text-align:center;margin-top:16px">
       <button class="chip" data-act="clearhist">حذف كل السجل</button></div>`;
}

/* ---------- تعمل الآن ---------- */
function renderWorking(L, sub) {
  if (S.channel) return renderChannel(L, sub);
  sub.classList.add('hidden');

  const q = norm(S.query);

  // نشمل بطاقات الموفّرين: مصادرها تأتي من حلّ أسماء formats، وهي قنوات حقيقية للمستخدم
  const providerCards = [];
  for (const cat of S.cats.categories || [])
    for (const ch of cat.channels || [])
      if (isProvider(ch) && !providerCards.some(x => keyOf(x) === keyOf(ch)))
        providerCards.push(ch);

  let chs = [...S.catalog.channels, ...providerCards]
    .map(ch => ({ ch, st: channelStreams(ch), g: goodCount(ch) }));
  chs = chs.filter(x => x.g > 0 || isProvider(x.ch));
  if (q) chs = chs.filter(x => norm(x.ch.title).includes(q));
  chs.sort((a, b) => b.g - a.g || String(a.ch.title).localeCompare(String(b.ch.title), 'ar'));

  const totalGood = S.catalog.channels.reduce((n, c) => n + goodCount(c), 0);
  const scanned = S.probe.size;
  baseStatus();
  if (!chs.length) return void (L.innerHTML = emptyBox('لا مصادر عاملة',
    scanned ? 'الفحص لم يجد مصادر عاملة في المعروض.'
            : 'اضغط «افحص المعروض» ليقيس هذا الجهاز المصادر الآن.'));

  L.innerHTML =
    `<div class="catHead">${chs.length} قناة فيها مصدر عامل · ${totalGood} مصدر يعمل${
      scanned ? ` · قِيس ${scanned}` : ' (من الفحص المدمج)'}</div>` +
    chs.slice(0, 800).map(x => rowChannelHTML(x.ch)).join('');
}

/* ---------- شاشة القناة ---------- */
function renderChannel(L, sub) {
  const ch = S.channel;
  const list = sortStreams(channelStreams(ch));
  sub.classList.remove('hidden');
  $('#subTitle').textContent = ch.title || 'قناة';
  const good = list.filter(isGood).length;
  $('#subMeta').textContent =
    `متوفّر ${list.length} مصدر` + (good ? ` · يعمل منها ${good} ✓` : '') +
    (S.only ? ' · الترشيح مُفعّل' : '');

  let shown = list;
  if (S.only) shown = list.filter(isGood);

  if (!shown.length) {
    L.innerHTML = emptyBox('لا مصادر عاملة في هذه القناة',
      S.only ? 'جرّب إطفاء «يعمل فقط» لرؤية كل المصادر.'
             : 'لم يُعثر على مصادر لهذه القناة.');
    return;
  }

  L.innerHTML = `<div class="catHead">اضغط أي مصدر للتشغيل — المرتّب أولًا هو الأرجح</div>` +
    shown.map((s, i) => rowStreamHTML(s, list.indexOf(s))).join('');

  window._curChannelList = list;
}

/* ---------- شاشة المباراة ---------- */
function renderEvent(L, sub) {
  const ev = S.event;
  const list = sortStreams(eventStreams(ev));
  const info = ev.eventInfo || {};
  sub.classList.remove('hidden');
  $('#subTitle').textContent = ev.title || info.eventName || 'مباراة';
  const st = eventStatus(ev);
  const good = list.filter(isGood).length;
  $('#subMeta').textContent =
    [st.label, `${list.length} مصدر`, good ? `يعمل منها ${good} ✓` : null,
     info.eventName].filter(Boolean).join(' · ');

  let shown = S.only ? list.filter(isGood) : list;
  if (!shown.length) return void (L.innerHTML = emptyBox('لا مصادر لهذه المباراة',
    S.only ? 'جرّب إطفاء «يعمل فقط».' : 'لم يُحلّ أي مصدر من أسماء هذه المباراة.'));

  L.innerHTML = shown.map((s, i) => rowStreamHTML(s, list.indexOf(s))).join('');
  window._curEventList = list;
}

/* ============================================================
   المشغّل
   ============================================================ */
function showOverlay(txt) { const o = $('#pOverlay'); o.textContent = txt; o.classList.add('show'); }
function hideOverlay()    { $('#pOverlay').classList.remove('show'); }
function setNote(txt)     { $('#pNote').textContent = txt || ''; }

function stopEngine() {
  if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
  if (dash) { try { dash.reset(); } catch (e) {} dash = null; }
  const v = $('#video');
  try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) {}
}

function openPlayer(list, idx, baseTitle) {
  if (!list || !list.length) return;
  curList = list; curIdx = -1; curBase = baseTitle || ''; curTries = 0;
  $('#player').classList.remove('hidden');
  openSource(idx);
}

function openSource(i) {
  const s = curList[i];
  if (!s || !s.link) return;
  curIdx = i;
  stopEngine();
  setNote('');
  showOverlay('جارٍ التشغيل…');
  $('#pTitle').textContent = (curBase ? curBase + ' — ' : '') + (s.title || 'مصدر');

  const link = s.link;
  const kind = String(s.kind || '').toLowerCase();
  const isDash = kind === 'dash' || /\.mpd(\?|#|$)/i.test(link);
  const isHls  = kind === 'hls'  || /\.m3u8(\?|#|$)/i.test(link);
  const ck = parseApi(s.api);
  const video = $('#video');

  record(s);

  if (isDash && window.dashjs) {
    if (ck) setNote('مصدر محمي — يتم فكّه محليًا بـ ClearKey بلا سيرفر ترخيص.');
    dash = dashjs.MediaPlayer().create();
    dash.on('error', () => onEngineFail());
    if (ck) {
      try {
        dash.setProtectionData({ 'org.w3.clearkey': { clearkeys: { [ck.kid]: ck.key } } });
      } catch (e) {}
    }
    try {
      dash.initialize(video, link, true);
      dash.on(dashjs.MediaPlayer.events.PLAYBACK_PLAYING, () => hideOverlay());
      dash.on(dashjs.MediaPlayer.events.PLAYBACK_STARTED, () => hideOverlay());
    } catch (e) { onEngineFail(); }
    return;
  }

  if (isHls && window.Hls && Hls.isSupported()) {
    hls = new Hls({ enableWorker: true, lowLatencyMode: false, maxBufferLength: 20 });
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      hideOverlay();
      video.play().catch(() => {});
    });
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (data && data.fatal) {
        // سقوط الصوت لا يُسقط الفيديو — نوضّح السبب بدل صمت محيّر
        if (data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR) return;
        onEngineFail(data);
      }
    });
    try { hls.attachMedia(video); hls.loadSource(link); } catch (e) { onEngineFail(); }
    return;
  }

  // مسار مباشر: mp4 / أي رابط يعرفه المتصفح
  try {
    video.src = link;
    video.play().then(() => hideOverlay()).catch(() => {
      hideOverlay();
      setNote('المتصفح بدأ التشغيل لكن قد يحتاج ضغطة على زرّ التشغيل.');
    });
  } catch (e) { onEngineFail(); }
}

function onEngineFail() {
  const s = curList[curIdx];
  if (tryNextSource()) return;
  const msg = [
    'تعذّر تشغيل المصادر المتاحة.',
    curList.length > 1 ? `جُرّب ${Math.min(curTries, curList.length)} مصدر بديل.` : '',
    'أسباب شائعة: الرابط ميت، أو المضيف يمنع المتصفح (CORS)، أو القناة تحتاج فكّ DRM غير متاح.',
  ].filter(Boolean).join('\n');
  showOverlay(msg);
}

function tryNextSource() {
  if (curTries >= MAX_AUTO) return false;
  for (let j = curIdx + 1; j < curList.length; j++) {
    if (!curList[j].link) continue;
    curTries++;
    openSource(j);
    return true;
  }
  return false;
}

function closePlayer() {
  stopEngine();
  $('#player').classList.add('hidden');
  curList = []; curIdx = -1;
}

/* ============================================================
   السجل والمفضلة
   ============================================================ */
function record(s) {
  const title = s.title || 'مصدر';
  const key = s.link || title;
  S.hist = S.hist.filter(h => h.key !== key);
  S.hist.unshift({ key, title, sub: (s._ch || s.host || ''), at: Date.now() });
  S.hist = S.hist.slice(0, 40);
  try { localStorage.setItem(LS.hist, JSON.stringify(S.hist)); } catch (e) {}
}

function toggleFav(key) {
  if (S.fav.has(key)) { S.fav.delete(key); toast('أُزيلت من المفضلة'); }
  else { S.fav.add(key); toast('أُضيفت للمفضلة'); }
  try { localStorage.setItem(LS.fav, JSON.stringify([...S.fav])); } catch (e) {}
  render();
}

/* ============================================================
   الفحص الحيّ — GET بمدى صغير، لأن كثيرًا من المضيفات ترفض HEAD
   ============================================================ */
async function probe(s) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(s.link, {
      headers: { Range: 'bytes=0-2048' },
      signal: ctrl.signal, redirect: 'follow', mode: 'cors', cache: 'no-store',
    });
    clearTimeout(t);
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    const buf = await r.arrayBuffer();
    const head = new TextDecoder('utf-8').decode(new Uint8Array(buf).slice(0, 80));
    const media = /mpegurl|dash\+xml|octet-stream|video\/|mp2t|mp4/.test(ct) ||
                  head.includes('#EXTM3U') || head.includes('<MPD');
    return { ok: r.ok && media, st: r.status, at: Date.now(), src: 'device' };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, st: 0, at: Date.now(), src: 'device' };
  }
}

async function runPool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k]); }
  });
  await Promise.all(workers);
}

async function scanCurrent() {
  if (S.scanning) { toast('الفحص جارٍ بالفعل…'); return; }

  let targets = [];
  if (S.channel)        targets = channelStreams(S.channel);
  else if (S.event)     targets = eventStreams(S.event);
  else {
    // الرئيسية: نفحص مصادر المعروض فقط (سقف) — فحص 2032 قناة بلا فائدة
    const chs = S.tab === 'working'
      ? S.catalog.channels
      : S.catalog.channels.slice(0, 40);
    for (const ch of chs) {
      targets.push(...channelStreams(ch).slice(0, 4));
      if (targets.length >= SCAN_CAP) break;
    }
  }

  const seen = new Set();
  targets = targets.filter(s => s.link && !seen.has(s.link) && seen.add(s.link)).slice(0, SCAN_CAP);
  if (!targets.length) { toast('لا توجد مصادر لفحصها'); return; }

  S.scanning = true; S.scanned = 0; S.scanTotal = targets.length;
  $('#btnScan').classList.add('on');

  await runPool(targets, 8, async s => {
    S.probe.set(s.link, await probe(s));
    S.scanned++;
    setStatus(`جارٍ الفحص… ${S.scanned}/${S.scanTotal}`, true);
    if (S.scanned % 8 === 0) render();      // نرتّب وهو يفحص — العامل يطفو للأعلى
  });

  persistProbe();
  S.scanning = false;
  $('#btnScan').classList.remove('on');
  render();
  const ok = targets.filter(isGood).length;
  toast(`اكتمل الفحص: ${ok} يعمل من ${targets.length}`);
}

/* ============================================================
   الأحداث
   ============================================================ */
function onListClick(e) {
  const star = e.target.closest('[data-act="fav"]');
  if (star) { e.stopPropagation(); toggleFav(star.dataset.key); return; }

  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const a = btn.dataset.act;

  if (a === 'cat') {
    S.catId = btn.dataset.id; S.channel = null; render();
    window.scrollTo(0, 0); $('#list').scrollTop = 0; return;
  }
  if (a === 'ch') {
    const ch = S.chMap.get(String(btn.dataset.key));
    if (!ch) return;
    S.channel = ch; S.event = null; render(); $('#list').scrollTop = 0; return;
  }
  if (a === 'ev') {
    const ev = (S.cats.events || []).find(x => String(x.id) === String(btn.dataset.id));
    if (!ev) return;
    S.event = ev; S.channel = null; S.catId = null; S.tab = 'live';
    render(); $('#list').scrollTop = 0; return;
  }
  if (a === 'play') {
    const list = S.channel ? window._curChannelList : window._curEventList;
    if (!list) return;
    openPlayer(list, parseInt(btn.dataset.i, 10), S.channel ? S.channel.title : (S.event ? S.event.title : ''));
    return;
  }
  if (a === 'hist') {
    const h = S.hist.find(x => x.key === btn.dataset.key);
    if (h) {
      const all = S.catalog.channels.flatMap(c => channelStreams(c));
      const s = all.find(x => x.link === h.key);
      if (s) openPlayer([s], 0, h.sub || '');
      else toast('لم يعد هذا المصدر في الكتالوج');
    }
    return;
  }
  if (a === 'clearhist') {
    S.hist = [];
    try { localStorage.removeItem(LS.hist); } catch (e) {}
    render(); toast('حُذف سجل التشغيل'); return;
  }
}

/* ============================================================
   الربط
   ============================================================ */
function hook() {
  $('#tabs').addEventListener('click', e => {
    const b = e.target.closest('[data-tab]');
    if (b) goTab(b.dataset.tab);
  });

  $('#list').addEventListener('click', onListClick);

  $('#btnBack').addEventListener('click', () => {
    if (S.event)   { S.event = null;   render(); $('#list').scrollTop = 0; return; }
    if (S.channel) { S.channel = null; render(); $('#list').scrollTop = 0; return; }
    if (S.catId)   { S.catId = null;   render(); $('#list').scrollTop = 0; return; }
  });

  let qt = null;
  $('#search').addEventListener('input', e => {
    clearTimeout(qt);
    qt = setTimeout(() => { S.query = e.target.value.trim(); render(); }, 180);
  });

  $('#btnWorking').addEventListener('click', () => {
    S.only = !S.only;
    try { localStorage.setItem(LS.only, S.only ? '1' : '0'); } catch (e) {}
    syncWorkingChip(); render();
  });

  $('#btnScan').addEventListener('click', scanCurrent);

  // زرّ الخروج يظهر فقط عندما يكون الموقع مقفلًا
  if ($('#btnLogout')) {
    $('#btnLogout').addEventListener('click', () => TVHubAuth.logout());
    TVHubAuth.isLocked().then(l => { if (l) $('#btnLogout').classList.remove('hidden'); });
  }

  $('#btnClose').addEventListener('click', closePlayer);
  $('#btnNext').addEventListener('click', () => {
    if (curIdx < 0) return;
    curTries = 0;
    if (!tryNextSource()) toast('لا مصدر تالٍ');
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('#player').classList.contains('hidden')) closePlayer();
  });
}

function syncWorkingChip() {
  const b = $('#btnWorking');
  b.classList.toggle('on', S.only);
  b.textContent = S.only ? 'يعمل فقط ✓' : 'يعمل فقط';
}

/* ---------- تشغيل ---------- */
hook();
boot();

// تحديث حالة الشريط السفلي عند كل تغيير
setInterval(() => { if (!S.scanning) baseStatus(); }, 5000);
