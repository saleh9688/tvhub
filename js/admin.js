/* ============================================================
   لوحة إدارة الحسابات — TV Hub

   تظهر للمشرفين فقط. تُضيف/تحذف الحسابات وتغيّر كلمات المرور،
   كل ذلك في المتصفح بلا أي أداة خارجية.

   لا تعيد تشفير المحتوى إطلاقًا: المفتاح الرئيسي ثابت، وما يتغيّر
   هو data/users.json فقط (كيلوبايت واحد).

   النشر: عبر واجهة GitHub البرمجية بتوكن يضعه المشرف بنفسه
   ويُحفظ في متصفحه وحده (localStorage). لا توكن مضمَّن في الكود.
   ============================================================ */
const TVHubAdmin = (() => {
  const LS_TOKEN = 'tvhub.gh.token';
  const LS_REPO = 'tvhub.gh.repo';
  const LS_PENDING = 'tvhub.users.pending';
  const AAD_USER = new TextEncoder().encode('tvhub-user-v2');
  const AAD_LABEL = new TextEncoder().encode('tvhub-label-v2');
  const ITER = 300000;

  let mk = null, me = null, doc = null, dirty = false;

  const $ = s => document.querySelector(s);
  const subtle = () => crypto.subtle;
  const b64u8 = b => btoa(String.fromCharCode.apply(null, b));
  const u8b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');

  async function aesEnc(keyBytes, plainBuf, aad) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const k = await subtle().importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
    const ct = new Uint8Array(await subtle().encrypt(
      { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, k, plainBuf));
    return { iv: b64u8(iv), tag: b64u8(ct.slice(-16)), ct: b64u8(ct.slice(0, -16)) };
  }
  async function aesDec(keyBytes, rec, aad) {
    const k = await subtle().importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
    // Node يخزّن الوسم منفصلًا، وWeb Crypto يتوقّعه ملحقًا بالنصّ المشفّر
    const all = new Uint8Array([...u8b64(rec.ct), ...u8b64(rec.tag)]);
    return new Uint8Array(await subtle().decrypt(
      { name: 'AES-GCM', iv: u8b64(rec.iv), additionalData: aad, tagLength: 128 }, k, all));
  }

  async function pbkdf2(pass, saltB64, iter) {
    const base = await subtle().importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveBits']);
    const bits = await subtle().deriveBits(
      { name: 'PBKDF2', salt: u8b64(saltB64), iterations: iter, hash: 'SHA-256' }, base, 256);
    return new Uint8Array(bits);
  }

  async function labelOf(entry) {
    try {
      const t = await aesDec(mk, entry.lb, AAD_LABEL);
      return new TextDecoder().decode(t);
    } catch (_) { return '(غير مقروء)'; }
  }

  async function buildEntry(user, pass, label, admin) {
    const saltBytes = crypto.getRandomValues(new Uint8Array(16));
    const salt = b64u8(saltBytes);
    const kek = await pbkdf2(pass, salt, ITER);
    const wk = await aesEnc(kek, mk, AAD_USER);
    const lb = await aesEnc(mk, new TextEncoder().encode(label || user), AAD_LABEL);
    const id = await userId(user);

    return {
      u: id, salt, iter: ITER,
      iv: wk.iv, tag: wk.tag, wk: wk.ct,
      lb: { iv: lb.iv, tag: lb.tag, ct: lb.ct },
      admin: !!admin,
      created: new Date().toISOString(),
    };
  }

  async function userId(user) {
    const data = new TextEncoder().encode(doc.pepper + ':' + String(user).trim().toLowerCase());
    return hex(await subtle().digest('SHA-256', data));
  }

  /* ---------- النشر ---------- */
  async function gh(method, path, body, token) {
    const H = {
      'Authorization': 'token ' + token,
      'User-Agent': 'tvhub-admin',
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (body) H['Content-Type'] = 'application/json';
    const r = await fetch('https://api.github.com' + path,
      { method, headers: H, body: body ? JSON.stringify(body) : undefined });
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch (_) { }
    return { ok: r.ok, status: r.status, json: j, text: txt };
  }

  async function publish(token, repo) {
    const rel = 'data/users.json';
    const content = btoa(unescape(encodeURIComponent(JSON.stringify(doc, null, 1))));

    const cur = await gh('GET', `/repos/${repo}/contents/${rel}?ref=main`, null, token);
    const body = { message: 'accounts: update users.json', content, branch: 'main' };
    if (cur.ok && cur.json && cur.json.sha) body.sha = cur.json.sha;

    const r = await gh('PUT', `/repos/${repo}/contents/${rel}`, body, token);
    if (!r.ok) throw new Error(`${r.status} ${(r.json && r.json.message) || r.text.slice(0, 90)}`);
    return r.json.html_url || '';
  }

  /* ---------- الرسم ---------- */
  async function renderList() {
    const box = $('#admList');
    if (!box) return;

    const rows = [];
    for (const e of doc.users) {
      const lb = await labelOf(e);
      const isMe = me && e.u === me.id;
      rows.push(`<div class="admRow">
        <div class="admWho">
          <div class="admName">${esc(lb)}${isMe ? ' <span class="admTag">أنت</span>' : ''}</div>
          <div class="admSub">${e.admin ? 'مشرف ★' : 'مشاهد'} · ${new Date(e.created).toLocaleDateString('ar-EG')}</div>
        </div>
        <button class="admX" data-del="${esc(e.u)}" title="حذف الحساب">✕</button>
      </div>`);
    }
    box.innerHTML = rows.join('') || '<div class="empty">لا حسابات</div>';

    const n = doc.users.length, a = doc.users.filter(e => e.admin).length;
    $('#admCount').textContent = `${n} حساب (${a} مشرف)`;
    $('#admDirty').classList.toggle('hidden', !dirty);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function note(msg, bad) {
    const n = $('#admNote');
    n.textContent = msg || '';
    n.className = 'admNote' + (bad ? ' bad' : '');
  }

  /* ---------- حفظ التغييرات غير المنشورة ----------

     بلا هذا، تبقى أي إضافة في ذاكرة الصفحة وحدها فتُفقد بمجرّد إعادة
     التحميل أو إغلاق التبويب. فيظنّ المستخدم أنه أضاف الحساب، ثم يتعجّب
     من رفض الدخول — وهذا بالضبط ما حدث فعلًا. نحفظها محليًا حتى تُنشر. */
  function savePending() {
    try { localStorage.setItem(LS_PENDING, JSON.stringify(doc)); } catch (_) {}
  }

  function markDirty() {
    dirty = true;
    savePending();
    $('#admDirty').classList.remove('hidden');
    paintBadge();
  }

  function clearPending() {
    dirty = false;
    try { localStorage.removeItem(LS_PENDING); } catch (_) {}
    $('#admDirty').classList.add('hidden');
    paintBadge();
  }

  /* علامة على زرّ «الحسابات» حتى لا تُنسى تغييرات غير منشورة */
  function paintBadge() {
    const b = $('#btnAccounts');
    if (!b) return;
    b.textContent = dirty ? 'الحسابات ●' : 'الحسابات';
    b.title = dirty ? 'لديك تغييرات غير منشورة' : '';
  }

  /* ---------- التشغيل ---------- */
  async function addUser() {
    const user = $('#admUser').value.trim();
    const label = $('#admLabel').value.trim();
    const pass = $('#admPass').value;
    const admin = $('#admAdmin').checked;

    if (!user) return note('اكتب اسم الدخول.', true);
    if (pass.length < 8) return note('كلمة المرور 8 أحرف على الأقل.', true);

    const id = await userId(user);
    if (doc.users.some(e => e.u === id)) return note(`«${user}» موجود بالفعل.`, true);

    note('جارٍ التغليف (PBKDF2 ×300000)…');
    doc.users.push(await buildEntry(user, pass, label || user, admin));
    markDirty();

    $('#admUser').value = ''; $('#admLabel').value = ''; $('#admPass').value = '';
    $('#admAdmin').checked = false;
    note(`✓ أُضيف «${label || user}». لم يبقَ إلا النشر.`);
    renderList();
  }

  async function delUser(id) {
    const e = doc.users.find(x => x.u === id);
    if (!e) return;
    if (me && e.u === me.id) return note('لا يمكنك حذف حسابك الحالي.', true);
    if (e.admin && doc.users.filter(x => x.admin).length === 1)
      return note('هذا آخر مشرف — لا يمكن حذفه.', true);

    const lb = await labelOf(e);
    if (!confirm(`حذف «${lb}»؟`)) return;
    doc.users = doc.users.filter(x => x.u !== id);
    markDirty();
    note(`✓ حُذف «${lb}».`);
    renderList();
  }

  async function doPublish() {
    const token = ($('#admToken').value || '').trim();
    const repo = ($('#admRepo').value || '').trim();
    if (!token) return note('بلا توكن لا يمكن النشر التلقائي — استخدم «تنزيل users.json» وارفعه إلى data/users.json في المستودع.', true);
    if (!/^[^/]+\/[^/]+$/.test(repo)) return note('صيغة المستودع: المالك/الاسم', true);

    const btn = $('#admGo');
    btn.disabled = true; note('جارٍ النشر…');
    try {
      localStorage.setItem(LS_TOKEN, token);
      localStorage.setItem(LS_REPO, repo);
      const url = await publish(token, repo);
      clearPending();
      note('✓ نُشرت الحسابات على الموقع. ستُطبَّق على كل الأجهزة فورًا.');
      window.dispatchEvent(new Event('tvhub-admin-published'));
    } catch (e) {
      const m = String((e && e.message) || e);
      if (/403/.test(m)) {
        note('التوكن لا يملك صلاحية الكتابة على هذا المستودع. أنشئ توكنًا جديدًا '
           + '(Fine-grained) بصلاحية Contents: Read and write. '
           + 'حساباتك محفوظة ولم تُفقد — ويمكنك النشر بلا توكن بزرّ «تنزيل users.json».', true);
      } else if (/401|Bad credentials/i.test(m)) {
        note('التوكن غير صالح أو منتهٍ. أنشئ توكنًا جديدًا بصلاحية Contents: Read and write.', true);
      } else {
        note('فشل النشر: ' + m + ' — حساباتك محفوظة، ويمكنك النشر بلا توكن بزرّ «تنزيل users.json».', true);
      }
    }
    btn.disabled = false;
  }

  function download() {
    const blob = new Blob([JSON.stringify(doc, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'users.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    note('نُزّل users.json — ارفعه إلى data/users.json في المستودع.');
  }

  function open() {
    const p = $('#admin');
    p.classList.remove('hidden');
    const t = localStorage.getItem(LS_TOKEN) || '';
    const r = localStorage.getItem(LS_REPO) || 'saleh9688/tvhub';
    $('#admToken').value = t;
    $('#admRepo').value = r;
    renderList();
    paintBadge();
    note(dirty
      ? '⚠ لديك تغييرات غير منشورة — اضغط «نشر التغييرات» لتُطبَّق على كل الأجهزة.'
      : '', dirty);
  }
  function close() { $('#admin').classList.add('hidden'); }

  function wire() {
    const f = $('#admForm');
    if (!f || f._wired) return;
    f._wired = true;
    f.addEventListener('submit', ev => { ev.preventDefault(); addUser(); });
    $('#admList').addEventListener('click', ev => {
      const b = ev.target.closest('[data-del]');
      if (b) delUser(b.dataset.del);
    });
    $('#admGo').addEventListener('click', doPublish);
    $('#admDl').addEventListener('click', download);
    $('#admClose').addEventListener('click', close);
    $('#btnAccounts').addEventListener('click', open);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !$('#admin').classList.contains('hidden')) close();
    });
  }

  function init(data, who) {
    me = who;
    mk = TVHubAuth.masterKeyRaw();
    doc = TVHubAuth.usersDoc();

    if (!mk || !doc) return;                 // موقع مفتوح بلا حسابات
    if (!me || !me.admin) return;            // لوحة الإدارة للمشرفين فقط

    const b = $('#btnAccounts');
    if (b) b.classList.remove('hidden');

    /* استرجاع تغييرات لم تُنشر بعد — نجت من إعادة تحميل الصفحة */
    try {
      const pend = localStorage.getItem(LS_PENDING);
      if (pend) {
        const p = JSON.parse(pend);
        if (p && Array.isArray(p.users) && p.users.length) { doc = p; dirty = true; }
      }
    } catch (_) {}

    wire();
    paintBadge();
    if (dirty) note('⚠ لديك تغييرات غير منشورة من قبل — اضغط «نشر التغييرات».', true);
  }

  // نلتقط لحظة نجاح الدخول (تعمل أيضًا مع الجلسة المحفوظة)
  TVHubAuth.setUnlockHook(init);
  if (TVHubAuth.current()) init(null, TVHubAuth.current());

  return { open, close, init, publish, download };
})();
