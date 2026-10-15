/* ============================================================
   بوابة الدخول — TV Hub (نظام الحسابات المتعددة)

   لا يُحمَّل أي محتوى قبل التحقّق. الآلية:

     data/users.json  ملف عام: لكل مستخدم مفتاح رئيسي **مغلَّف**
                      بكلمة مروره عبر PBKDF2-SHA256 ×300000.
     data/vault.enc   المحتوى مشفّرًا بالمفتاح الرئيسي (AES-256-GCM).

   فسحب الملفَّين لا يكشف شيئًا: بلا كلمة مرور صحيحة لا يُفتح الغلاف،
   وبلا المفتاح الرئيسي لا يُقرأ المحتوى.

   لا تُخزَّن كلمة المرور إطلاقًا. المخزَّن هو المفتاح الرئيسي في
   sessionStorage، ويُمحى بإغلاق التبويب أو بزر الخروج.

   الواجهة المتوقَّعة من app.js:  load() · isLocked() · logout()
   ============================================================ */
const TVHubAuth = (() => {
  const USERS = 'data/users.json';
  const VAULT = 'data/vault.enc';
  const AAD_USER = new TextEncoder().encode('tvhub-user-v2');
  const AAD_LABEL = new TextEncoder().encode('tvhub-label-v2');
  const AAD_VAULT = new TextEncoder().encode('tvhub-vault-v2');
  const SS = 'tvhub.auth.session.v2';
  const TTL = 12 * 60 * 60 * 1000;       // 12 ساعة
  const FAIL_DELAY = 450;                // يبطئ التجريب اليدوي المتكرّر

  let usersDoc = null;                   // ملف الحسابات العام
  let me = null;                         // { admin, label, created }
  let mkRaw = null;                      // المفتاح الرئيسي (بايتات)
  let locked = null;                     // true/false
  let LOAD = null;                       // وعد واحد مشترك
  let release = null;                    // يُحلّ بعد نجاح الدخول
  let onUnlock = null;                   // إشعار لوحدة الإدارة

  const $ = s => document.querySelector(s);
  const subtle = () => crypto.subtle;
  const b2u8 = b64 => Uint8Array.from(
    atob(String(b64).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

  /* الباني (tools/vault-lib.cjs) يخزّن النصّ المشفّر والوسم في حقلين منفصلين
     (ct و tag)، بينما WebCrypto يتوقّع الوسم **ملحقًا** بالنصّ المشفّر.
     فدمجهما شرط نجاح الفكّ — بدونه يفشل التحقّق دائمًا وتظهر رسالة
     «كلمة المرور غير صحيحة» حتى مع كلمة مرور صحيحة. */
  function ctTag(ctB64, tagB64) {
    const ct = b2u8(ctB64), tag = b2u8(tagB64);
    const out = new Uint8Array(ct.length + tag.length);
    out.set(ct, 0);
    out.set(tag, ct.length);
    return out;
  }

  /* ---------- بيانات الحسابات ---------- */
  async function getUsers() {
    if (usersDoc) return usersDoc;
    try {
      const r = await fetch(USERS, { cache: 'no-store' });
      usersDoc = r.ok ? await r.json() : null;
    } catch (_) { usersDoc = null; }
    return usersDoc;
  }

  /* بصمة اسم المستخدم — مطابقة لِما تبنيه tools/vault-lib.cjs */
  async function userId(user) {
    const doc = await getUsers();
    const data = new TextEncoder().encode(doc.pepper + ':' + String(user).trim().toLowerCase());
    const h = await subtle().digest('SHA-256', data);
    return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function deriveKek(pass, saltB64, iter) {
    const base = await subtle().importKey(
      'raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
    return subtle().deriveKey(
      { name: 'PBKDF2', salt: b2u8(saltB64), iterations: iter, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  }

  /* ---------- فكّ المحتوى ---------- */
  async function openVault(keyBytes) {
    const r = await fetch(VAULT, { cache: 'no-store' });
    if (!r.ok) throw new Error('لا يوجد ملف خزنة');
    const v = await r.json();
    const key = await subtle().importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
    const gz = new Uint8Array(await subtle().decrypt(
      { name: 'AES-GCM', iv: b2u8(v.iv), additionalData: AAD_VAULT, tagLength: 128 },
      key, ctTag(v.ct, v.tag)));
    const text = await new Response(
      new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    return JSON.parse(text);
  }

  /* ---------- مسار الدخول ---------- */
  async function tryLogin(user, pass) {
    const doc = await getUsers();
    if (!doc || !doc.users || !doc.users.length) return { open: true };

    const id = await userId(user);
    const entry = doc.users.find(e => e.u === id);
    if (!entry) return { error: 'اسم المستخدم أو كلمة المرور غير صحيحة.' };

    let raw;
    try {
      const kek = await deriveKek(pass, entry.salt, entry.iter || doc.iter || 300000);
      raw = new Uint8Array(await subtle().decrypt(
        { name: 'AES-GCM', iv: b2u8(entry.iv), additionalData: AAD_USER, tagLength: 128 },
        kek, ctTag(entry.wk, entry.tag)));
    } catch (_) {
      return { error: 'اسم المستخدم أو كلمة المرور غير صحيحة.' };
    }

    // الاسم الظاهر مشفّر بالمفتاح الرئيسي — لا يُعرض قبل إثبات الملكية
    let label = user;
    try {
      const lk = await subtle().importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
      label = new TextDecoder().decode(await subtle().decrypt(
        { name: 'AES-GCM', iv: b2u8(entry.lb.iv), additionalData: AAD_LABEL, tagLength: 128 },
        lk, ctTag(entry.lb.ct, entry.lb.tag)));
    } catch (_) { /* نكتفي باسم الدخول */ }

    return { raw, me: { admin: !!entry.admin, label, created: entry.created, id } };
  }

  /* ---------- الجلسة ---------- */
  function saveSession() {
    try {
      sessionStorage.setItem(SS, JSON.stringify({
        mk: btoa(String.fromCharCode.apply(null, mkRaw)), me, t: Date.now(),
      }));
    } catch (_) { }
  }

  function restoreSession() {
    try {
      const s = JSON.parse(sessionStorage.getItem(SS) || 'null');
      if (!s || !s.t || Date.now() - s.t > TTL) { sessionStorage.removeItem(SS); return null; }
      return s;
    } catch (_) { return null; }
  }

  /* ---------- الواجهة ---------- */
  function showGate(msg) {
    const g = $('#gate');
    if (!g) return;
    g.classList.remove('hidden');
    $('#gErr').textContent = msg || '';
  }
  function hideGate() { const g = $('#gate'); if (g) g.classList.add('hidden'); }

  function wireForm() {
    const f = $('#gateForm');
    if (!f || f._wired) return;
    f._wired = true;

    /* زرّ إظهار كلمة المرور — يحوّل الحقل إلى نصّ عادي ليتأكّد المستخدم
       مما كتبه فعلًا. هذا أشيع سبب لفشل الدخول: كتابة صحيحة في ظنّه. */
    const eye = $('#gEye');
    if (eye) {
      eye.addEventListener('click', () => {
        const p = $('#gPass');
        const show = p.type === 'password';
        p.type = show ? 'text' : 'password';
        eye.classList.toggle('on', show);
        eye.title = show ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور';
        p.focus();
      });
    }

    /* Caps Lock سبب شائع ثانٍ. ننبّه فورًا بدل انتظار محاولة فاشلة. */
    const pw = $('#gPass');
    if (pw) {
      pw.addEventListener('keyup', ev => {
        const on = typeof ev.getModifierState === 'function' && ev.getModifierState('CapsLock');
        const err = $('#gErr');
        if (on && err && !err.textContent) err.textContent = 'تنبيه: مفتاح Caps Lock مفعّل.';
      });
    }

    f.addEventListener('submit', async ev => {
      ev.preventDefault();
      const btn = $('#gGo');
      btn.disabled = true; btn.textContent = 'جارٍ التحقّق…';
      $('#gErr').textContent = '';

      const r = await tryLogin($('#gUser').value, $('#gPass').value);
      if (r.error) {
        btn.disabled = false; btn.textContent = 'دخول';
        $('#gErr').textContent = r.error;
        $('#gPass').value = '';
        await new Promise(s => setTimeout(s, FAIL_DELAY));
        return;
      }

      try {
        const data = await openVault(r.raw);
        mkRaw = r.raw; me = r.me;
        saveSession();
        hideGate();
        if (onUnlock) onUnlock(data, me);
        if (release) { const f2 = release; release = null; f2(data); }
      } catch (_) {
        btn.disabled = false; btn.textContent = 'دخول';
        $('#gErr').textContent = 'تعذّر فتح المحتوى — الملف تالف أو غير مكتمل.';
      }
    });
  }

  /* ---------- نقطة الدخول ---------- */
  function load() {
    if (LOAD) return LOAD;
    LOAD = new Promise(async resolve => {
      wireForm();

      /* crypto.subtle متاح فقط في «سياق آمن»: HTTPS أو localhost.
         لو فُتح الموقع عبر عنوان شبكة محلية بـ http (مثل 192.168.x.x:8731)
         يفشل الدخول بلا سبب ظاهر — فنقولها صريحة بدل رسالة مضلّلة. */
      if (!crypto.subtle) {
        showGate('التشفير لا يعمل على هذا الاتصال. افتح الموقع عبر HTTPS أو localhost.');
        const go = $('#gGo');
        if (go) { go.disabled = true; go.textContent = 'الاتصال غير آمن'; }
        return;
      }

      // 1) جلسة محفوظة؟
      const s = restoreSession();
      if (s) {
        try {
          const data = await openVault(b2u8(s.mk));
          mkRaw = b2u8(s.mk); me = s.me; locked = true;
          hideGate();
          if (onUnlock) onUnlock(data, me);
          return resolve(data);
        } catch (_) { sessionStorage.removeItem(SS); }
      }

      // 2) هل الموقع مقفل؟
      const doc = await getUsers();
      locked = !!(doc && doc.users && doc.users.length);

      if (!locked) {
        // موقع مفتوح: نعمل كالسابق
        const g = $('#gate'); if (g) g.classList.add('hidden');
        try {
          const cat = await (await fetch('data/catalog.json', { cache: 'no-store' })).json();
          const cats = await (await fetch('data/categories.json', { cache: 'no-store' })).json();
          let ver = null;
          try { ver = await (await fetch('data/verified.json', { cache: 'no-store' })).json(); } catch (_) { }
          return resolve({ v: 1, catalog: cat, categories: cats, verified: ver });
        } catch (_) { return resolve({ v: 0, catalog: { channels: [] }, categories: { categories: [] } }); }
      }

      // 3) مقفل: ننتظر الدخول
      showGate('');
      $('#gUser').focus();
      release = resolve;
    });
    return LOAD;
  }

  async function isLocked() {
    if (locked !== null) return locked;
    const doc = await getUsers();
    locked = !!(doc && doc.users && doc.users.length);
    return locked;
  }

  function logout() {
    try { sessionStorage.removeItem(SS); } catch (_) { }
    location.reload();
  }

  /* وحدات أخرى (لوحة الإدارة) تستخدمها لإضافة حسابات */
  window.TVHubAuthInternals = { userId, deriveKek, b2u8, getUsers, refreshUsers: () => { usersDoc = null; LOAD = null; } };
  setTimeout(() => { window.dispatchEvent(new Event('tvhub-auth-ready')); }, 0);

  return {
    load, isLocked, logout, hideGate,
    current: () => me,
    usersDoc: () => usersDoc,
    masterKeyRaw: () => mkRaw,
    setUnlockHook: fn => { onUnlock = fn; },
  };
})();
