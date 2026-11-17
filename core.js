/* ===== CYP FIN: the rules of the shared database =====
   The same text runs in three places: inside the Google script (Code.gs), inside the app
   (to show a change at once and to work on one phone without a database), and in the tests.
   It never talks to Google directly: everything it needs comes through "store". */
var FIN_STATUSES = ['Waiting', 'To revise', 'Approved', 'Next week', 'Not approved', 'Paid', 'Cancelled'];
var FIN_ROLES = ['head', 'director', 'accountant', 'viewer'];
var FIN_TZ_MINUTES = 120; /* Zambia, UTC+2 */

function finNewDb() {
  return { v: 1, rev: 0, seq: 0, users: [], requests: [], deadlines: [], comments: [],
    settings: { rev: 0, noticeDays: 5, approvalDay: 4, countFrom: '2026-12-01', weeks: {}, weeksExp: {}, weeksDate: {}, plan: {}, monthly: ['SCH', 'FAM'] }, opIds: [] };
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
/* the lines of a monthly request: budget line, name, amount */
function finItems(list) {
  if (!list || !list.length || list.length > 80) return null;
  var out = [], sum = 0;
  for (var i = 0; i < list.length; i++) {
    var a = Number(list[i].amount);
    if (!list[i].line || !(a > 0) || a > 100000000) return null;
    a = Math.round(a * 100) / 100; sum += a;
    out.push({ line: String(list[i].line), lineName: finText(list[i].lineName, 120), amount: a });
  }
  return { items: out, sum: Math.round(sum * 100) / 100 };
}
/* a food request: for how many people, how much, at which price, and what is still in the store */
function finFood(x) {
  if (!x) return null;
  var p = Math.round(Number(x.people)), q = Number(x.qty), pr = Number(x.price), st = x.stock === '' || x.stock == null ? -1 : Number(x.stock);
  if (!(p >= 1 && p <= 100000) || !(q > 0 && q <= 1000000) || !(pr > 0 && pr <= 100000000) || !(st >= 0 && st <= 1000000)) return false;
  return { people: p, qty: Math.round(q * 100) / 100, unit: finText(x.unit, 12) || 'kg', price: Math.round(pr * 100) / 100, stock: Math.round(st * 100) / 100 };
}
function finMonthlySecs(s) { return s.monthly || ['SCH', 'FAM']; }
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
    var what = finText(d.what, 160), amount = Number(d.amount), bundle = null, month = '';
    if (d.items) {
      /* one request for the whole month of a section */
      month = String(d.month || '');
      if (!/^\d{4}-\d{2}$/.test(month) || finMonthlySecs(s).indexOf(String(d.section)) < 0) return fail('section');
      for (var mi = 0; mi < db.requests.length; mi++) if (db.requests[mi].month === month && db.requests[mi].section === String(d.section) && db.requests[mi].status !== 'Cancelled' && db.requests[mi].status !== 'Not approved') return fail('again');
      bundle = finItems(d.items); if (!bundle) return fail('amount');
      amount = bundle.sum; d.line = 'monthly'; d.lineName = bundle.items.length + (bundle.items.length === 1 ? ' budget line' : ' budget lines');
    }
    var food = bundle ? null : finFood(d.food);
    if (food === false) return fail('food');
    if (food) amount = Math.round(food.qty * food.price * 100) / 100;
    if (!what) return fail('what');
    if (!(amount > 0) || amount > 100000000) return fail('amount');
    if (!d.line) return fail('line');
    if (['P1', 'P2', 'P3'].indexOf(d.prio) < 0) return fail('prio');
    if (!finIsDate(d.needed)) return fail('date');
    var created = finIsDate(d.created) && d.created <= today && finDayNum(today) - finDayNum(d.created) <= 30 ? d.created : today;
    var notice = finWorkDays(created, d.needed), emergency = notice < s.noticeDays;
    /* a planned expense sent by the management is known from the plan: it is not an Emergency */
    var planKey = finText(d.plan, 60);
    if (planKey && (u.role === 'accountant' || u.role === 'director')) emergency = false;
    if (emergency && (!finText(d.reason) || !finText(d.why))) return fail('reason');
    db.seq++;
    r = { id: String(d.id), no: 'R' + ('000' + db.seq).slice(-4), section: String(d.section), what: what, amount: Math.round(amount * 100) / 100,
      line: String(d.line), lineName: finText(d.lineName, 120), prio: d.prio, needed: d.needed, pay: d.pay === 'cash' ? 'cash' : 'bank',
      created: created, received: nowIso, notice: notice, emergency: emergency, reason: emergency ? finText(d.reason, 60) : '', why: emergency ? finText(d.why, 200) : '',
      by: u.id, byName: u.name, status: 'Waiting', decidedBy: '', decidedAt: '', note: '', week: '', paidBy: '', paidAt: '',
      receipt: false, receiptBy: '', receiptAt: '', quoteFile: saveFile(d.photo, 'quotation-' + d.id), receiptFile: '', deadline: d.deadline ? String(d.deadline) : '', plan: planKey, month: month, items: bundle ? bundle.items : null, food: food || null };
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
  /* the spending plan comes from the budget; here the management changes the rule of one line, or says which sections send a monthly request */
  if (t === 'plan_set') {
    if (u.role !== 'accountant' && u.role !== 'director' && !u.admin) return fail('role');
    if (!s.plan) s.plan = {};
    if (d.monthly) {
      if (!d.monthly.length && d.monthly.length !== 0 || d.monthly.length > 40) return fail('fields');
      s.monthly = d.monthly.map(String); bump(s); audit('Monthly request', s.monthly.join(', ') || 'no section');
      return { ok: true };
    }
    var ln = finText(d.line, 20); if (!ln) return fail('fields');
    if (d.rule === null) { delete s.plan[ln]; bump(s); audit('Spending plan', ln + ' back to the budget rule'); return { ok: true }; }
    var q = d.rule || {}, ms = [], k;
    for (k = 0; k < (q.months || []).length; k++) { var mo = Math.round(Number(q.months[k])); if (!(mo >= 1 && mo <= 12)) return fail('fields'); if (ms.indexOf(mo) < 0) ms.push(mo); }
    var tm = Math.round(Number(q.times)), am = Number(q.amount);
    if (['w1', 'w2', 'w3', 'w4', 'spread'].indexOf(q.when) < 0 || !(tm >= 1 && tm <= 8) || !(am >= 0) || am > 100000000 || ['P1', 'P2', 'P3'].indexOf(q.prio) < 0) return fail('fields');
    s.plan[ln] = { months: ms.sort(function (a, b) { return a - b; }), when: q.when, times: tm, amount: Math.round(am * 100) / 100, prio: q.prio };
    /* fixed: paid by the management, the section does not ask for it */
    if (q.fixed != null) s.plan[ln].fixed = !!q.fixed;
    /* food: the request says people, quantity, price and what is left in the store */
    if (q.food != null) s.plan[ln].food = !!q.food;
    bump(s); audit('Spending plan', ln + ': ' + ms.length + ' months, ' + q.when + ', ' + tm + ' x K' + s.plan[ln].amount);
    return { ok: true };
  }
  if (t === 'week_money') {
    if (u.role !== 'accountant' && u.role !== 'director' && !u.admin) return fail('role');
    /* two numbers for each week: the money expected, and the money received with its date */
    /* the money comes in the first, the second and the last week of the month: an indicative amount for each */
    if (d.kind === 'indicative') {
      if (['w1', 'w2', 'last'].indexOf(d.slot) < 0) return fail('fields');
      if (!s.tranche) s.tranche = {};
      if (d.amount === null || d.amount === '') delete s.tranche[d.slot];
      else { var ia = Number(d.amount); if (!(ia >= 0) || ia > 1000000000) return fail('fields'); s.tranche[d.slot] = ia; }
      bump(s); audit('Indicative money', d.slot + ' ' + (s.tranche[d.slot] != null ? 'K' + s.tranche[d.slot] : 'removed'));
      return { ok: true };
    }
    if (!finIsDate(d.week)) return fail('fields');
    var wk = finWeekKey(d.week), kind = d.kind === 'expected' ? 'expected' : 'received';
    if (!s.weeksExp) s.weeksExp = {};
    if (!s.weeksDate) s.weeksDate = {};
    if (d.amount === null || d.amount === '') {
      if (kind === 'expected') delete s.weeksExp[wk]; else { delete s.weeks[wk]; delete s.weeksDate[wk]; }
      bump(s); audit('Money for the week', wk + ' ' + kind + ' removed');
      return { ok: true };
    }
    var wm = Number(d.amount);
    if (!(wm >= 0)) return fail('fields');
    if (kind === 'expected') { s.weeksExp[wk] = wm; audit('Money for the week', wk + ' expected K' + wm); }
    else {
      var got = finIsDate(d.date) && d.date <= finAddDays(today, 1) ? d.date : today;
      s.weeks[wk] = wm; s.weeksDate[wk] = got; audit('Money for the week', wk + ' received K' + wm + ' on ' + got);
    }
    bump(s);
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
    if (r.status !== 'Waiting' && r.status !== 'Next week' && r.status !== 'To revise') return fail('status');
    r.status = 'Cancelled'; touched(r, 'Cancelled', '');
    if (r.deadline) { x = finFind(db.deadlines, r.deadline); if (x && x.asked === r.id) { x.asked = ''; bump(x); } }
    return { ok: true };
  }
  if (t === 'decide') {
    if (u.role !== 'director') return fail('role');
    if (['Approved', 'Next week', 'Not approved', 'Waiting', 'To revise'].indexOf(d.status) < 0) return fail('fields');
    if (r.status === 'Paid' || r.status === 'Cancelled') return fail('status');
    if (d.status === 'To revise' && !finText(d.note)) return fail('note');
    r.status = d.status; r.note = finText(d.note, 200);
    if (d.status !== 'Approved') r.payOn = '';
    r.decidedBy = d.status === 'Waiting' ? '' : u.name; r.decidedAt = d.status === 'Waiting' ? '' : nowIso;
    r.week = d.status === 'Approved' ? finWeekKey(today) : '';
    touched(r, d.status === 'Waiting' ? 'Decision undone' : d.status, r.note);
    return { ok: true };
  }
  /* the section changes a request the Director sent back, and it goes to the Director again */
  if (t === 'req_edit') {
    if (r.by !== u.id && !finCanAskFor(u, r.section)) return fail('role');
    if (r.status !== 'To revise') return fail('status');
    var what2 = finText(d.what, 160), amount2 = Number(d.amount), bundle2 = null;
    if (r.items) { bundle2 = finItems(d.items); if (!bundle2) return fail('amount'); amount2 = bundle2.sum; d.line = 'monthly'; d.lineName = bundle2.items.length + (bundle2.items.length === 1 ? ' budget line' : ' budget lines'); }
    var food2 = r.items ? null : finFood(d.food);
    if (food2 === false) return fail('food');
    if (food2) amount2 = Math.round(food2.qty * food2.price * 100) / 100;
    if (!what2) return fail('what');
    if (!(amount2 > 0) || amount2 > 100000000) return fail('amount');
    if (!d.line) return fail('line');
    if (['P1', 'P2', 'P3'].indexOf(d.prio) < 0) return fail('prio');
    if (!finIsDate(d.needed)) return fail('date');
    var notice2 = finWorkDays(r.created, d.needed), em2 = notice2 < s.noticeDays;
    var reason2 = finText(d.reason, 60) || r.reason, why2 = finText(d.why, 200) || r.why;
    if (em2 && (!reason2 || !why2)) return fail('reason');
    if (bundle2) r.items = bundle2.items;
    r.food = food2 || null;
    r.what = what2; r.amount = Math.round(amount2 * 100) / 100; r.line = String(d.line); r.lineName = finText(d.lineName, 120); r.prio = d.prio; r.needed = d.needed;
    r.pay = d.pay === 'cash' ? 'cash' : 'bank'; r.notice = notice2; r.emergency = em2; r.reason = em2 ? reason2 : ''; r.why = em2 ? why2 : '';
    var q2 = saveFile(d.photo, 'quotation-' + r.id + '-' + ((r.revised || 0) + 1)); if (q2) r.quoteFile = q2;
    r.status = 'Waiting'; r.revised = (r.revised || 0) + 1; r.revisedAt = nowIso; r.askedNote = r.note; r.decidedBy = ''; r.decidedAt = ''; r.week = '';
    touched(r, 'Sent again after revision', what2 + ' K' + r.amount);
    return { ok: true };
  }
  /* the Accountant says on which day an approved request will be paid */
  if (t === 'pay_date') {
    if (u.role !== 'accountant') return fail('role');
    if (r.status !== 'Approved') return fail('status');
    if (d.date && !finIsDate(d.date)) return fail('date');
    r.payOn = d.date ? String(d.date) : '';
    touched(r, 'Pay date', r.payOn || 'removed');
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
    r.status = 'Approved'; r.paidBy = ''; r.paidAt = ''; r.receipt = false; r.receiptBy = ''; r.receiptAt = ''; r.spent = null;
    touched(r, 'Payment undone', '');
    return { ok: true };
  }
  if (t === 'receipt') {
    if (u.role !== 'accountant' && r.by !== u.id && !finHasSection(u, r.section)) return fail('role');
    if (r.status !== 'Paid') return fail('status');
    /* how much of the money was really spent: what is not spent comes back */
    var sp = d.spent === '' || d.spent == null ? null : Number(d.spent);
    if (sp !== null && (!(sp >= 0) || sp > 100000000)) return fail('amount');
    r.receipt = true; r.receiptBy = u.name; r.receiptAt = nowIso; r.spent = sp === null ? null : Math.round(sp * 100) / 100;
    x = saveFile(d.photo, 'receipt-' + r.id); if (x) r.receiptFile = x;
    touched(r, 'Receipt added', r.spent != null ? 'spent K' + r.spent : '');
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
