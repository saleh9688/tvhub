/* ============================================================
   بوابة الدخول — TV Hub
   لا يُحمَّل أي محتوى قبل التحقّق من بيانات الدخول.
   ملف data/vault.enc مشفّر AES-256-GCM بمفتاح مشتقّ من كلمة المرور
   عبر PBKDF2-SHA256، فسحب الملف وتجريبه خارج الموقع لا يفيد.

   مهم: لا تُخزَّن كلمة المرور في أي مكان. نخزّن فقط المفتاح المشتقّ
   في sessionStorage مع انتهاء صلاحية، ويُمحى بإغلاق التبويب أو بالخروج.
   ============================================================ */
const TVHubAuth = (() => {
  const VAULT = 'data/vault.enc';
  const AAD = new TextEncoder().encode('tvhub-vault-v1');
  const SS = 'tvhub.auth.session.v1';
  const TTL = 12 * 60 * 60 * 1000;      // 12 ساعة
  const FAIL_DELAY = 450;               // يبطئ التجريب المتكرّر يدويًا

  let header;                           // undefined = لم يُقرأ · null = لا يوجد قفل
  let resolver = null;                  // وعد الدخول المعلّق

  const $ = s => document.querySelector(s);
  const b2u8 = b64 => Uint8Array.from(
    atob(String(b64).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const u82b = u8 => btoa(String.fromCharCode.apply(null, u8));

  async function getHeader() {
    if (header !== undefined) return header;
    try {
      const r = await fetch(VAULT, { cache: 'no-store' });
      header = r.ok ? await r.json() : null;
    } catch (e) { header = null; }
    return header;
  }

  async function deriveKey(pass, h) {
    const base = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: b2u8(h.salt), iterations: h.iter, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, true, ['decrypt']);
  }

  async function gunzip(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('old-browser');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function decryptWith(key, h) {
    const ct = b2u8(h.ct), tag = b2u8(h.tag);
    const buf = new Uint8Array(ct.length + tag.length);
    buf.set(ct, 0); buf.set(tag, ct.length);
    const plain = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b2u8(h.iv), additionalData: AAD, tagLength: 128 }, key, buf));
    const bytes = h.zip === 'gzip' ? await gunzip(plain) : plain;
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  async function saveSession(key) {
    try {
      const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
      sessionStorage.setItem(SS, JSON.stringify({ k: u82b(raw), e: Date.now() + TTL }));
    } catch (e) { /* الجلسة راحة إضافية، وفقدانها لا يعطّل شيئًا */ }
  }

  async function restore() {
    try {
      const s = JSON.parse(sessionStorage.getItem(SS) || 'null');
      if (!s || !s.k || Date.now() > s.e) return null;
      const h = await getHeader();
      if (!h) return null;
      const key = await crypto.subtle.importKey(
        'raw', b2u8(s.k), { name: 'AES-GCM' }, true, ['decrypt']);
      return await decryptWith(key, h);
    } catch (e) {
      try { sessionStorage.removeItem(SS); } catch (e2) {}
      return null;
    }
  }

  function showErr(msg) { const e = $('#gErr'); if (e) e.textContent = msg || ''; }

  function openGate() {
    document.body.classList.add('gated');
    const g = $('#gate');
    if (g) g.classList.remove('hidden');
    showErr('');
    setTimeout(() => { try { $('#gUser').focus(); } catch (e) {} }, 80);
  }

  function closeGate() {
    const g = $('#gate');
    if (g) g.classList.add('hidden');
    document.body.classList.remove('gated');
  }

  async function submit(ev) {
    ev.preventDefault();
    const btn = $('#gGo');
    const user = ($('#gUser').value || '').trim();
    const pass = $('#gPass').value || '';
    if (!user || !pass) { showErr('أدخل اسم المستخدم وكلمة المرور'); return; }

    btn.disabled = true; btn.textContent = 'جارٍ التحقّق…'; showErr('');
    const t0 = Date.now();
    let ok = false;
    try {
      const h = await getHeader();
      if (!h) throw new Error('no-vault');
      const key = await deriveKey(pass, h);
      const pl = await decryptWith(key, h);       // فشل الوسم = كلمة مرور خطأ
      if (String(pl.user || '').trim().toLowerCase() !== user.toLowerCase())
        throw new Error('mismatch');

      await saveSession(key);
      ok = true;
      closeGate();
      const r = resolver; resolver = null;
      if (r) r(pl); else location.reload();
    } catch (e) {
      const wait = Math.max(0, FAIL_DELAY - (Date.now() - t0));
      setTimeout(() => {
        showErr(e && e.message === 'old-browser'
          ? 'متصفحك لا يدعم فكّ بيانات القفل — استخدم Chrome أو Edge حديثًا.'
          : 'اسم المستخدم أو كلمة المرور غير صحيحة');
        $('#gPass').value = '';
        try { $('#gPass').focus(); } catch (e2) {}
      }, wait);
    } finally {
      setTimeout(() => { btn.disabled = false; btn.textContent = 'دخول'; }, ok ? 0 : FAIL_DELAY);
    }
  }

  /**
   * نقطة الدخول الوحيدة لبيانات الموقع.
   * غير مقفل  → تحميل عادي من ملفات JSON.
   * مقفل      → جلسة صالحة، وإلا شاشة الدخول وننتظر.
   */
  async function load() {
    const h = await getHeader();

    if (!h) {
      const j = async p => {
        const r = await fetch(p, { cache: 'no-store' });
        if (!r.ok) throw new Error(p + ' → ' + r.status);
        return r.json();
      };
      const pair = await Promise.all([j('data/catalog.json'), j('data/categories.json')]);
      let verified = null;
      try { verified = await j('data/verified.json'); } catch (e) { /* اختياري */ }
      return { catalog: pair[0], categories: pair[1], verified };
    }

    const t = await restore();
    if (t) return t;

    const form = $('#gateForm');
    if (form && !form._wired) { form._wired = 1; form.addEventListener('submit', submit); }
    return new Promise(res => { resolver = res; openGate(); });
  }

  function logout() {
    try { sessionStorage.removeItem(SS); } catch (e) {}
    location.reload();
  }

  return {
    load,
    logout,
    isLocked: async () => !!(await getHeader()),
  };
})();
