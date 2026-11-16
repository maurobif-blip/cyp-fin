/* ===== CYP FIN: the rules of the shared database =====
   The same text runs in three places: inside the Google script (Code.gs), inside the app
   (to show a change at once and to work on one phone without a database), and in the tests.
   It never talks to Google directly: everything it needs comes through "store". */
var FIN_STATUSES = ['Waiting', 'Approved', 'Next week', 'Not approved', 'Paid', 'Cancelled'];
var FIN_ROLES = ['head', 'director', 'accountant', 'viewer'];
var FIN_TZ_MINUTES = 120; /* Zambia, UTC+2 */

function finNewDb() {
  return { v: 1, rev: 0, seq: 0, users: [], requests: [], deadlines: [], comments: [],
    settings: { rev: 0, noticeDays: 5, approvalDay: 4, countFrom: '2026-12-01', weeks: {} }, opIds: [] };
}

/* ---- dates: plain yyyy-mm-dd strings, no time zones inside ---- */
function finIsDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z')); }
function finDayNum(s) { return Math.round(Date.parse(s + 'T00:00:00Z') / 86400000); }
function finDayStr(n) { return new Date(n * 86400000).toISOString().slice(0, 10); }
function finAddDays(s, n) { return finDayStr(finDayNum(s) + n); }
function finWeekday(s) { return new Date(Date.parse(s + 'T00:00:00Z')).getUTCDay(); } /* 0 Sunday */
function finToday(nowIso) { return new Date(Date.parse(nowIso) + FIN_TZ_MINUTES * 60000).toISOString().slice(0, 10); }
/* working days after "from", up to and including "to" */
function finWorkDays(from, to) {
  var a = finDayNum(from), b = finDayNum(to), n = 0;
  if (b - a > 800) b = a + 800;
  for (var d = a + 1; d <= b; d++) { var w = (((d + 4) % 7) + 7) % 7; if (w !== 0 && w !== 6) n++; }
  return n;
}
/* the last day on which asking still gives "days" working days of notice */
function finAskBy(needed, days) {
  var d = finDayNum(needed), left = days, guard = 0;
  while (left > 0 && guard < 90) { var w = (((d + 4) % 7) + 7) % 7; if (w !== 0 && w !== 6) left--; d--; guard++; }
  return finDayStr(d);
}
/* the Monday of the week of a day: the name of that week */
function finWeekKey(s) { var w = finWeekday(s); return finAddDays(s, -((w + 6) % 7)); }
function finAddMonth(s) {
  var y = Number(s.slice(0, 4)), m = Number(s.slice(5, 7)), d = Number(s.slice(8, 10));
  m++; if (m > 12) { m = 1; y++; }
  var last = new Date(Date.UTC(y, m, 0)).getUTCDate(); if (d > last) d = last;
  return y + '-' + (m < 10 ? '0' : '') + m + '-' + (d < 10 ? '0' : '') + d;
}

/* ---- people ---- */
function finPublicUser(u) {
  return { id: u.id, name: u.name, role: u.role, sections: u.sections || [], admin: !!u.admin, active: u.active !== false, salt: u.salt, rev: u.rev || 0 };
}
function finFind(list, id) { for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; }
function finHasSection(u, code) { return (u.sections || []).indexOf(code) >= 0; }
function finSeesAll(u) { return u.role === 'director' || u.role === 'accountant' || u.role === 'viewer' || !!u.admin; }
function finSeesRequest(u, r) { return finSeesAll(u) || finHasSection(u, r.section) || r.by === u.id; }
function finCanAskFor(u, code) { return finHasSection(u, code) || u.role === 'accountant'; }
/* the dates of the agenda are kept by the Accountant, the Director and the administrator; a section head sees them and asks */
function finCanDeadline(u, code) { return u.role === 'director' || u.role === 'accountant' || !!u.admin; }
/* a comment on the app itself: which screen, which word, what the person says */
function finCommentRec(d, nowIso, by, byName, demo) {
  return { id: String(d.id), time: nowIso, by: by, byName: byName, demo: !!demo, page: finText(d.page, 40), target: finText(d.target, 160), text: finText(d.text, 600),
    version: finText(d.version, 20), phone: !!d.phone, done: false, doneBy: '', doneAt: '' };
}
function finText(x, max) { return String(x == null ? '' : x).replace(/\s+/g, ' ').trim().slice(0, max || 200); }

/* ---- one change. Returns {ok:true} or {ok:false, error:'...'}; "info" collects what the store must write ---- */
function finApply(db, u, op, nowIso, store, info) {
  var d = op.d || {}, t = op.t, today = finToday(nowIso), s = db.settings, r, x;
  function bump(rec) { db.rev++; rec.rev = db.rev; }
  function fail(e) { return { ok: false, error: e }; }
  function touched(rec, what, detail) {
    bump(rec);
    if (info) { if (info.requests.indexOf(rec) < 0) info.requests.push(rec); info.audit.push({ time: nowIso, user: u.name, action: what, no: rec.no || '', detail: detail || '' }); }
  }
  function audit(what, detail) { if (info) info.audit.push({ time: nowIso, user: u.name, action: what, no: '', detail: detail || '' }); }
  function saveFile(photo, name) {
    if (!photo || !photo.b64) return '';
    if (String(photo.b64).length > 1500000) return '';
    return store && store.saveFile ? store.saveFile(name, photo.mime || 'image/jpeg', photo.b64) : 'pending';
  }

  if (t === 'req_new') {
    if (!finCanAskFor(u, d.section)) return fail('section');
    if (!d.id || finFind(db.requests, d.id)) return fail('id');
    var what = finText(d.what, 160), amount = Number(d.amount);
    if (!what) return fail('what');
    if (!(amount > 0) || amount > 100000000) return fail('amount');
    if (!d.line) return fail('line');
    if (['P1', 'P2', 'P3'].indexOf(d.prio) < 0) return fail('prio');
    if (!finIsDate(d.needed)) return fail('date');
    var created = finIsDate(d.created) && d.created <= today && finDayNum(today) - finDayNum(d.created) <= 30 ? d.created : today;
    var notice = finWorkDays(created, d.needed), emergency = notice < s.noticeDays;
    if (emergency && (!finText(d.reason) || !finText(d.why))) return fail('reason');
    db.seq++;
    r = { id: String(d.id), no: 'R' + ('000' + db.seq).slice(-4), section: String(d.section), what: what, amount: Math.round(amount * 100) / 100,
      line: String(d.line), lineName: finText(d.lineName, 120), prio: d.prio, needed: d.needed, pay: d.pay === 'cash' ? 'cash' : 'bank',
      created: created, received: nowIso, notice: notice, emergency: emergency, reason: emergency ? finText(d.reason, 60) : '', why: emergency ? finText(d.why, 200) : '',
      by: u.id, byName: u.name, status: 'Waiting', decidedBy: '', decidedAt: '', note: '', week: '', paidBy: '', paidAt: '',
      receipt: false, receiptBy: '', receiptAt: '', quoteFile: saveFile(d.photo, 'quotation-' + d.id), receiptFile: '', deadline: d.deadline ? String(d.deadline) : '' };
    db.requests.push(r);
    touched(r, 'New request', what + ' K' + r.amount + (emergency ? ' EMERGENCY' : ''));
    if (r.deadline) {
      x = finFind(db.deadlines, r.deadline);
      if (x && !x.deleted) { if (x.repeat === 'monthly') x.date = finAddMonth(x.date); else x.asked = r.id; bump(x); }
    }
    return { ok: true };
  }

  if (t === 'dl_save') {
    if (!finCanDeadline(u, d.section)) return fail('section');
    var w2 = finText(d.what, 160), am2 = Number(d.amount);
    if (!d.id || !w2 || !(am2 > 0) || !finIsDate(d.date)) return fail('fields');
    x = finFind(db.deadlines, d.id);
    if (x && !finCanDeadline(u, x.section)) return fail('section');
    if (!x) { x = { id: String(d.id), asked: '' }; db.deadlines.push(x); }
    x.section = String(d.section); x.what = w2; x.amount = am2; x.line = String(d.line || ''); x.lineName = finText(d.lineName, 120);
    x.date = d.date; x.repeat = d.repeat === 'monthly' ? 'monthly' : ''; x.pay = d.pay === 'cash' ? 'cash' : 'bank'; x.deleted = false;
    if (x.asked && d.reopen) x.asked = '';
    bump(x); audit('Deadline saved', w2 + ' ' + d.date);
    return { ok: true };
  }
  if (t === 'dl_del') {
    x = finFind(db.deadlines, d.id);
    if (!x) return fail('id');
    if (!finCanDeadline(u, x.section)) return fail('section');
    x.deleted = true; bump(x); audit('Deadline removed', x.what);
    return { ok: true };
  }

  if (t === 'set') {
    if (u.role !== 'director' && !u.admin) return fail('role');
    if (d.noticeDays != null) { var nd = Math.round(Number(d.noticeDays)); if (!(nd >= 0 && nd <= 30)) return fail('fields'); s.noticeDays = nd; }
    if (d.approvalDay != null) { var ad = Math.round(Number(d.approvalDay)); if (!(ad >= 1 && ad <= 5)) return fail('fields'); s.approvalDay = ad; }
    if (d.countFrom != null) { if (!finIsDate(d.countFrom)) return fail('fields'); s.countFrom = d.countFrom; }
    bump(s); audit('Rules changed', JSON.stringify({ noticeDays: s.noticeDays, approvalDay: s.approvalDay, countFrom: s.countFrom }));
    return { ok: true };
  }
  if (t === 'week_money') {
    if (u.role !== 'accountant' && u.role !== 'director' && !u.admin) return fail('role');
    var wm = Number(d.amount);
    if (!finIsDate(d.week) || !(wm >= 0)) return fail('fields');
    s.weeks[finWeekKey(d.week)] = wm; bump(s); audit('Money for the week', finWeekKey(d.week) + ' K' + wm);
    return { ok: true };
  }

  if (t === 'user_save') {
    if (!u.admin) return fail('role');
    var nm = finText(d.name, 60);
    if (!d.id || !nm || FIN_ROLES.indexOf(d.role) < 0) return fail('fields');
    x = finFind(db.users, d.id);
    if (!x) { if (!d.salt || !d.cred) return fail('pin'); x = { id: String(d.id), fails: 0, lockUntil: '' }; db.users.push(x); }
    var wasAdmin = !!x.admin && x.active !== false, willAdmin = !!d.admin && d.active !== false;
    if (wasAdmin && !willAdmin) {
      var others = 0; for (var i = 0; i < db.users.length; i++) if (db.users[i] !== x && db.users[i].admin && db.users[i].active !== false) others++;
      if (!others) return fail('last_admin');
    }
    x.name = nm; x.role = d.role; x.sections = (d.sections || []).map(String); x.admin = !!d.admin; x.active = d.active !== false;
    if (d.salt && d.cred) { x.salt = String(d.salt); x.cred = String(d.cred); x.fails = 0; x.lockUntil = ''; }
    bump(x); audit('Person saved', nm + ' (' + x.role + ')');
    return { ok: true };
  }
  if (t === 'pin') {
    if (!d.salt || !d.cred) return fail('fields');
    u.salt = String(d.salt); u.cred = String(d.cred); bump(u); audit('PIN changed', '');
    return { ok: true };
  }

  if (t === 'comment_new') {
    if (!db.comments) db.comments = [];
    if (!d.id || finFind(db.comments, d.id)) return fail('id');
    if (!finText(d.text)) return fail('comment');
    if (db.comments.length >= 3000) return fail('full');
    x = finCommentRec(d, nowIso, u.id, u.name, false);
    db.comments.push(x); bump(x);
    if (info) { info.comments.push(x); }
    audit('Comment on the app', x.page + ': ' + x.text.slice(0, 80));
    return { ok: true };
  }
  if (t === 'comment_done') {
    if (!u.admin) return fail('role');
    x = finFind(db.comments || [], d.id);
    if (!x) return fail('id');
    x.done = d.done !== false; x.doneBy = x.done ? u.name : ''; x.doneAt = x.done ? nowIso : '';
    bump(x); if (info) info.comments.push(x);
    return { ok: true };
  }

  /* everything below changes one request */
  r = finFind(db.requests, d.id);
  if (!r) return fail('id');
  if (t === 'req_cancel') {
    if (r.by !== u.id && !finHasSection(u, r.section)) return fail('role');
    if (r.status !== 'Waiting' && r.status !== 'Next week') return fail('status');
    r.status = 'Cancelled'; touched(r, 'Cancelled', '');
    if (r.deadline) { x = finFind(db.deadlines, r.deadline); if (x && x.asked === r.id) { x.asked = ''; bump(x); } }
    return { ok: true };
  }
  if (t === 'decide') {
    if (u.role !== 'director') return fail('role');
    if (['Approved', 'Next week', 'Not approved', 'Waiting'].indexOf(d.status) < 0) return fail('fields');
    if (r.status === 'Paid' || r.status === 'Cancelled') return fail('status');
    r.status = d.status; r.note = finText(d.note, 200);
    r.decidedBy = d.status === 'Waiting' ? '' : u.name; r.decidedAt = d.status === 'Waiting' ? '' : nowIso;
    r.week = d.status === 'Approved' ? finWeekKey(today) : '';
    touched(r, d.status === 'Waiting' ? 'Decision undone' : d.status, r.note);
    return { ok: true };
  }
  if (t === 'pay') {
    if (u.role !== 'accountant') return fail('role');
    if (r.status !== 'Approved') return fail('status');
    r.status = 'Paid'; r.paidBy = u.name; r.paidAt = nowIso; if (!r.week) r.week = finWeekKey(today);
    touched(r, 'Paid', 'K' + r.amount + ' ' + r.pay);
    return { ok: true };
  }
  if (t === 'unpay') {
    if (u.role !== 'accountant') return fail('role');
    if (r.status !== 'Paid') return fail('status');
    r.status = 'Approved'; r.paidBy = ''; r.paidAt = ''; r.receipt = false; r.receiptBy = ''; r.receiptAt = '';
    touched(r, 'Payment undone', '');
    return { ok: true };
  }
  if (t === 'receipt') {
    if (u.role !== 'accountant' && r.by !== u.id && !finHasSection(u, r.section)) return fail('role');
    if (r.status !== 'Paid') return fail('status');
    r.receipt = true; r.receiptBy = u.name; r.receiptAt = nowIso;
    x = saveFile(d.photo, 'receipt-' + r.id); if (x) r.receiptFile = x;
    touched(r, 'Receipt added', '');
    return { ok: true };
  }
  if (t === 'quote_add') {
    if (u.role !== 'accountant' && r.by !== u.id && !finHasSection(u, r.section)) return fail('role');
    x = saveFile(d.photo, 'quotation-' + r.id); if (!x) return fail('photo');
    r.quoteFile = x; touched(r, 'Quotation added', '');
    return { ok: true };
  }
  return fail('action');
}

/* ---- one call from a phone ---- */
function finHandle(req, store) {
  if (!req || !store.key() || req.key !== store.key()) return { ok: false, error: 'key' };
  var db = store.load() || finNewDb(), now = store.now(), a = req.action, i;
  function pub() { var out = []; for (var k = 0; k < db.users.length; k++) out.push(finPublicUser(db.users[k])); return out; }

  if (a === 'hello') return { ok: true, empty: db.users.length === 0, users: pub(), settings: db.settings, rev: db.rev, now: now };
  if (a === 'first_admin') {
    if (db.users.length) return { ok: false, error: 'not_empty' };
    var nm = finText(req.name, 60);
    if (!req.id || !nm || !req.salt || !req.cred || FIN_ROLES.indexOf(req.role) < 0) return { ok: false, error: 'fields' };
    db.rev++;
    db.users.push({ id: String(req.id), name: nm, role: req.role, sections: [], admin: true, active: true, salt: String(req.salt), cred: String(req.cred), fails: 0, lockUntil: '', rev: db.rev });
    store.save(db, { requests: [], audit: [{ time: now, user: nm, action: 'First administrator', no: '', detail: '' }] });
    return { ok: true, users: pub() };
  }

  if (!db.comments) db.comments = [];
  /* a comment from the demo: the link is enough, the person writes a name */
  if (a === 'comment') {
    var who = finText(req.name, 60);
    if (!req.id || !who || !finText(req.text)) return { ok: false, error: 'fields' };
    if (finFind(db.comments, req.id)) return { ok: true, again: true };
    if (db.comments.length >= 3000) return { ok: false, error: 'full' };
    var cm = finCommentRec(req, now, '', who, true);
    db.rev++; cm.rev = db.rev; db.comments.push(cm);
    store.save(db, { requests: [], comments: [cm], audit: [{ time: now, user: who + ' (demo)', action: 'Comment on the app', no: '', detail: cm.page + ': ' + cm.text.slice(0, 80) }] });
    return { ok: true };
  }

  var u = finFind(db.users, req.user);
  if (!u || u.active === false) return { ok: false, error: 'user' };
  if (u.lockUntil && now < u.lockUntil) return { ok: false, error: 'locked', until: u.lockUntil };
  if (!req.cred || u.cred !== req.cred) {
    u.fails = (u.fails || 0) + 1;
    if (u.fails >= 5) { u.fails = 0; u.lockUntil = new Date(Date.parse(now) + 60000).toISOString(); }
    store.save(db, { requests: [], audit: [] });
    return { ok: false, error: 'pin' };
  }
  var dirty = false;
  if (u.fails || u.lockUntil) { u.fails = 0; u.lockUntil = ''; dirty = true; }

  if (a === 'login') { if (dirty) store.save(db, { requests: [], audit: [] }); return { ok: true, me: finPublicUser(u), now: now }; }
  if (a === 'file_get') {
    var owner = null;
    for (i = 0; i < db.requests.length; i++) if (db.requests[i].quoteFile === req.id || db.requests[i].receiptFile === req.id) owner = db.requests[i];
    if (!owner || !finSeesRequest(u, owner)) return { ok: false, error: 'id' };
    var f = store.getFile(req.id);
    return f ? { ok: true, mime: f.mime, b64: f.b64 } : { ok: false, error: 'id' };
  }
  if (a !== 'sync') return { ok: false, error: 'action' };

  var results = [], info = { requests: [], audit: [], comments: [] }, ops = req.ops || [];
  for (i = 0; i < ops.length; i++) {
    var op = ops[i];
    if (!op || !op.id) { results.push({ id: '', ok: false, error: 'op' }); continue; }
    if (db.opIds.indexOf(op.id) >= 0) { results.push({ id: op.id, ok: true, again: true }); continue; }
    var res;
    try { res = finApply(db, u, op, now, store, info); } catch (err) { res = { ok: false, error: 'server', detail: String(err) }; }
    res.id = op.id; results.push(res);
    db.opIds.push(op.id); if (db.opIds.length > 3000) db.opIds.splice(0, db.opIds.length - 3000);
    dirty = true;
    if (u.active === false) break;
  }
  if (dirty) store.save(db, info);

  var since = Number(req.since) || 0, full = since === 0 || (u.rev || 0) > since, out = { ok: true, results: results, rev: db.rev, full: full, now: now, me: finPublicUser(u) };
  if (full) since = 0;
  out.users = []; out.requests = []; out.deadlines = []; out.comments = [];
  for (i = 0; i < db.users.length; i++) if ((db.users[i].rev || 0) > since) out.users.push(finPublicUser(db.users[i]));
  for (i = 0; i < db.requests.length; i++) if (db.requests[i].rev > since && finSeesRequest(u, db.requests[i])) out.requests.push(db.requests[i]);
  for (i = 0; i < db.deadlines.length; i++) if (db.deadlines[i].rev > since && (finSeesAll(u) || finHasSection(u, db.deadlines[i].section))) out.deadlines.push(db.deadlines[i]);
  /* the administrator reads all the comments; the others get back their own */
  for (i = 0; i < db.comments.length; i++) if (db.comments[i].rev > since && (u.admin || db.comments[i].by === u.id)) out.comments.push(db.comments[i]);
  if ((db.settings.rev || 0) > since || full) out.settings = db.settings;
  return out;
}

if (typeof module !== 'undefined') module.exports = { finHandle: finHandle, finApply: finApply, finNewDb: finNewDb, finWorkDays: finWorkDays, finAskBy: finAskBy, finWeekKey: finWeekKey, finToday: finToday, finAddDays: finAddDays, finAddMonth: finAddMonth };
