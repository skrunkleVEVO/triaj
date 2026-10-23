// Triaj: the planner page. Data lives in platform storage (IndexedDB, mirrored to your account) and is
// shared with the engine, which syncs Canvas/calendars and runs the focus timer.
import {
  normalize, iso, mn, hm, need as needRaw, newId, cleanHost, originOf, mergeItems, parseICS, icsToItems,
  statsText, PAL, PRESETS, guessTask, matchClass, THEMES, MODES, applyThemeVars, onColor, inClassSlot, classSlotsOn, sweepInClass, blockState, isBlocked, sweepBlocks, dependsOn, makeBackup, parseBackup
} from './lib/shared.js';
import { playSound, SOUNDS, AMBIENT } from './lib/sounds.js';
import { makeApi, listCourseFiles, listItemFiles, downloadAll, cleanName, blobUrl, dataUrl, instructionsPage } from './lib/canvasfiles.js';
import { ext } from './lib/platform.js';
import * as bridge from './lib/bridge.js';
import { session, companionHelp, isPhone } from './lib/account.js';
import { installable, install } from './lib/install.js';

/* ================= state ================= */
const ME = 'page:' + Math.random().toString(36).slice(2);
let st = normalize(null), timer = { status: 'idle', phase: 'work' }, ready = false, pendingRender = false;
let todayS = iso(new Date()), tab = 'now', filter = 'all', cal = new Date(), sel = todayS, pd = todayS, bm = new Date(), sv = 'week', wo = 0;
let editId = 0, justId = 0, lastTab = '', showAlt = false, recOverride = 0, stuck = null, focusTid = 0, presetEdit = false;
let aiLog = [], aiProps = [], aiBusy = false, syncBusy = '', welcome = false, syncState = { running: false }, reportAll = false;
const sylRun = {};
let dlog = {}; // fileId -> {u: updated_at when downloaded, p: path, at}
const fx = { cid: '', loading: false, prog: '', data: null, err: '', sel: new Set(), filter: 'all', q: '', closed: {}, byModule: true, busy: false, dprog: '', result: null };
let proj = null;
const bk = { loaded: false, perm: false, state: null, snaps: [] };
let blk = null; // draft while editing a task's "can't do now" settings // per-course syllabus reading state for this session
const imp = { items: [], text: '', busy: false, msg: '', defCls: 0, hidePast: true, stats: null };
const CATS = ['Food', 'Rent', 'Transport', 'School', 'Fun', 'Other'];
const PR = { h: 'High', m: 'Medium', l: 'Low' };
const DN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SUB = ['budget', 'classes', 'settings', 'sync', 'import', 'backup', 'export'];
const LABEL = { work: 'Focus', short: 'Short break', long: 'Long break' };

const $ = (id) => document.getElementById(id);
function esc(s) { return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function tf(x) { let h = Math.floor(x / 60), m = x % 60; const ap = h >= 12 && h < 24 ? 'PM' : 'AM'; h = h % 12 || 12; return h + ':' + String(m).padStart(2, '0') + ' ' + ap; }
function dur(x) { x = Math.round(x); return x >= 60 ? Math.floor(x / 60) + 'h' + (x % 60 ? ' ' + x % 60 + 'm' : '') : x + 'm'; }
function cls(id) { return st.classes.find((c) => c.id === id); }
function need(t) { return needRaw(t, st.cfg.pace); }
function remaining(t) { return t.inClass ? 0 : Math.max(0, need(t) - (t.spent || 0)); }
// Things you can sit down and work on now (not done, not done-in-class, not blocked).
function workable(t) { return !t.done && !t.inClass && !isBlocked(st, t); }
function fmtT(sec) { sec = Math.max(0, Math.round(sec)); return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); }
function ago(isoS) {
  if (!isoS) return 'never';
  const m = Math.round((Date.now() - new Date(isoS)) / 60000);
  if (isNaN(m)) return '';
  if (m < 2) return 'just now'; if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60); if (h < 48) return h + ' hour' + (h === 1 ? '' : 's') + ' ago';
  return Math.round(h / 24) + ' days ago';
}
// Event-handler attributes (no inline JS, so everything is delegated).
function on(evt, name, ...args) { return ' data-' + evt + '="' + name + '"' + (args.length ? ' data-args="' + esc(JSON.stringify(args)) + '"' : ''); }
const C = (n, ...a) => on('click', n, ...a);
const CH = (n, ...a) => on('change', n, ...a);
const EN = (n, ...a) => on('enter', n, ...a);
const send = (m) => ext.runtime.sendMessage(m).catch(() => null);
const T = () => st.cfg.timer;
const preset = (id) => T().presets.find((p) => p.id === (id || T().presetId)) || T().presets[0];

/* ================= storage ================= */
function save() {
  st.rev = (st.rev || 0) + 1; st.by = ME;
  ext.storage.local.set({ plan: st });
}
function adopt(o) { st = normalize(o); applyTheme(); }
ext.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local') return;
  let r = false;
  if (ch.plan && ch.plan.newValue && ch.plan.newValue.by !== ME) { adopt(ch.plan.newValue); r = true; }
  if (ch.timer) { timer = ch.timer.newValue || { status: 'idle', phase: 'work' }; r = true; }
  if (ch.syncState) { syncState = ch.syncState.newValue || { running: false }; r = true; }
  if (ch.bkState || ch.snaps) { loadBk(); }
  if (r) softRender();
});
function typing() { const a = document.activeElement; return a && $('view').contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName) && a.type !== 'checkbox' && a.type !== 'range'; }
function softRender() { if (typing()) { pendingRender = true; renderMini(); return; } render(); }
document.addEventListener('focusout', () => setTimeout(() => { if (pendingRender && !typing()) { pendingRender = false; render(); } }, 50));

/* ================= actions ================= */
const ACT = {};
let EL = null; // element that triggered the current action
ACT.go = (t) => { tab = t; editId = 0; render(); window.scrollTo(0, 0); history.replaceState(null, '', '#' + t); };
ACT.addTask = (date) => {
  const t = $('nt').value.trim(); if (!t) return;
  st.tasks.push({ id: newId(), t, d: date ? date : ($('nd') ? $('nd').value : ''), p: $('np').value, cls: +$('nc').value || 0, est: +$('ne').value, fixed: Math.max(0, +$('nf').value || 0), done: false, spent: 0, inClass: !!($('nic') && $('nic').checked) });
  const nt = st.tasks[st.tasks.length - 1], sl = nt.inClass ? inClassSlot(st, nt) : null;
  save(); render(); toast(nt.inClass ? (sl ? 'Added on ' + (sl.cls ? sl.cls.n + ' ' : '') + tf(sl.s) + ' ✓' : 'Added. Open it to pick the class time') : 'Added ✓'); setTimeout(() => $('nt') && $('nt').focus(), 30);
};
ACT.toggle = (id) => {
  let d = false;
  st.tasks.forEach((x) => { if (x.id === id) { x.done = !x.done; x.doneAt = x.done ? todayS : ''; if (!x.done && x.autoDone) x.userUndone = true; d = x.done; } });
  if (d) { justId = id; setTimeout(() => { justId = 0; }, 700); }
  const ready = sweepBlocks(st);
  save(); render();
  if (d) { burst(); toast('Nice work! ✓'); }
  readyToast(ready);
};
function readyToast(ready) {
  if (!ready || !ready.length) return;
  setTimeout(() => toast('🔓 Ready to start now: ' + ready.map((t) => t.t).slice(0, 2).join(', ') + (ready.length > 2 ? ' +' + (ready.length - 2) : '')), 1200);
}
ACT.delTask = (id) => {
  const t = st.tasks.find((x) => x.id === id);
  if (t && t.uid) st.dismissed.push(t.uid);
  st.tasks = st.tasks.filter((x) => x.id !== id);
  const ready = sweepBlocks(st); save(); render();
  toast(t && t.uid ? 'Deleted. It will not come back on the next sync.' : 'Deleted');
  readyToast(ready);
};
ACT.editTask = (id, dateFirst) => { editId = id; render(); setTimeout(() => { const e = $(dateFirst ? 'ed' : 'et'); if (e) e.focus(); }, 30); };
ACT.cancelEdit = () => { editId = 0; blk = null; render(); };
ACT.setEd = (n) => { const e = $('ed'); if (!e) return; if (n < 0) { e.value = ''; return; } const d = new Date(); d.setDate(d.getDate() + n); e.value = iso(d); };
// Copy what is typed in the open editor into the task (so re-renders never lose unsaved edits).
function keepEdit() {
  if (!editId || !$('et')) return;
  st.tasks.forEach((t) => {
    if (t.id !== editId) return;
    t.t = $('et').value.trim() || t.t; t.d = $('ed').value; t.cls = +$('ec').value || 0; t.est = +$('ee').value || 60; t.p = $('ep').value; t.fixed = Math.max(0, +$('ef').value || 0);
    if ($('eic')) t.inClass = $('eic').checked;
    if ($('eicat')) t.icAt = $('eicat').value;
    if ($('eics')) { t.icS = $('eics').value; t.icE = $('eice').value; }
  });
}
ACT.saveEdit = () => { keepEdit(); editId = 0; blk = null; save(); render(); toast('Saved ✓'); };

/* --- in-class --- */
ACT.icToggle = () => { keepEdit(); render(); };
ACT.icRefresh = () => { if ($('eic') && $('eic').checked) { keepEdit(); render(); } };
function icEditor(x) {
  let info = '';
  if (x.inClass) {
    const c = cls(x.cls), sl = inClassSlot(st, x), day = x.d ? new Date(x.d + 'T00:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) : '';
    if (!x.d) info = '<div class="s">Set the due date to the day it happens in class.</div>';
    else if (!c) info = '<div class="s">Pick its class above so it goes on that class time, or set a time:</div>' + icTimes(x);
    else if (sl && sl.matched) {
      const slots = classSlotsOn(st, x.cls, x.d);
      info = '<div class="s" style="color:var(--ok);font-weight:600">✓ On ' + esc(c.n) + ', ' + day + ', ' + tf(sl.s) + '–' + tf(sl.e) + (sl.loc ? ' · ' + esc(sl.loc) : '') + '</div>' +
        (slots.length > 1 ? '<span class="lbl">' + esc(c.n) + ' meets ' + slots.length + ' times that day. Which one?</span><select id="eicat"' + CH('icRefresh') + '>' + slots.map((o) => '<option value="' + hm(o.s) + '"' + (o.s === sl.s ? ' selected' : '') + '>' + tf(o.s) + '–' + tf(o.e) + (o.loc ? ' · ' + esc(o.loc) : '') + '</option>').join('') + '</select>' : '');
    } else info = '<div class="s" style="color:var(--warn);font-weight:600">' + esc(c.n) + (c.slots.length ? ' doesn\'t meet on ' + day + '. Fix the date, or set the time:' : ' has no class times yet (More → Classes). Or set the time:') + '</div>' + icTimes(x);
  }
  return '<div class="icbox' + (x.inClass ? ' on' : '') + '"><div class="check" style="margin:0"><input type="checkbox" id="eic"' + (x.inClass ? ' checked' : '') + CH('icToggle') + '><label for="eic"><b>📝 Happens in class</b> <span class="s">(test, quiz, in-class assignment): no study time is planned for it; it\'s placed on the class meeting and checks itself off once class is over</span></label></div>' + info + '</div>';
}
function icTimes(x) { return '<div class="row"><input type="time" id="eics" value="' + esc(x.icS || '') + '"' + CH('icRefresh') + '><input type="time" id="eice" value="' + esc(x.icE || '') + '"' + CH('icRefresh') + '></div>'; }

/* --- can't do now --- */
ACT.blkStart = (id, kind) => {
  keepEdit();
  const t = st.tasks.find((x) => x.id === id), b = (t && t.block) || {};
  const prev = blk && blk.id === id ? blk : null;
  blk = { id, kind, deps: prev ? prev.deps : b.kind === 'task' ? (b.deps || []).slice() : [], note: prev ? prev.note : b.note || '', until: prev ? prev.until : b.until || '' };
  readBlk();
  render();
};
function readBlk() { if (!blk) return; if ($('bnote')) blk.note = $('bnote').value.trim(); if ($('buntil')) blk.until = $('buntil').value; }
ACT.blkDep = () => { keepEdit(); const v = +($('bdep') || {}).value; if (v && blk && blk.deps.indexOf(v) < 0) blk.deps.push(v); render(); };
ACT.blkUndep = (v) => { keepEdit(); blk.deps = blk.deps.filter((x) => x !== v); render(); };
ACT.blkCancel = () => { keepEdit(); blk = null; render(); };
ACT.blkSave = () => {
  keepEdit(); readBlk();
  const t = st.tasks.find((x) => x.id === blk.id);
  if (!t) return;
  if (blk.kind === 'task' && !blk.deps.length) {
    const v = +($('bdep') || {}).value; // picked in the list but "Add" not pressed
    if (v) blk.deps.push(v); else return toast('Pick the task that has to happen first');
  }
  if (blk.kind === 'cond' && !blk.note) return toast('Write what needs to happen first');
  t.block = { kind: blk.kind, deps: blk.kind === 'task' ? blk.deps : [], note: blk.note, until: blk.until, since: todayS };
  const msg = blk.kind === 'task' ? 'It comes back onto your plan as soon as ' + (blk.deps.length > 1 ? 'those are' : 'that is') + ' done'
    : blk.kind === 'cond' ? (blk.until ? 'Off your plan until ' + niceDay(blk.until) + '; I\'ll ask then if it happened' : 'Off your plan until you say it happened')
    : (blk.until ? 'Parked until ' + niceDay(blk.until) : 'Parked until you unpark it');
  blk = null; save(); render(); toast('🚧 ' + msg);
};
ACT.blkClear = (id) => { keepEdit(); const t = st.tasks.find((x) => x.id === id); if (t) delete t.block; blk = null; save(); render(); toast('Back on your plan ✓'); };
ACT.blkNotYet = (id) => {
  const t = st.tasks.find((x) => x.id === id); if (!t || !t.block) return;
  const d = new Date(); d.setDate(d.getDate() + 2); t.block.until = iso(d);
  save(); render(); toast('OK, I\'ll check again ' + niceDay(t.block.until));
};
ACT.cantNow = (id) => {
  tab = 'tasks'; filter = 'all'; editId = id; blk = null; render();
  setTimeout(() => { const e = document.querySelector('.blkbox'); if (e) e.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 30);
};
function blockText(t, s) {
  const b = t.block;
  if (b.kind === 'task') return 'after ' + s.waiting.map((w) => '“' + w.t + '”').join(' and ');
  if (b.kind === 'cond') return 'waiting for: ' + b.note + (s.check ? ' (did it happen?)' : b.until ? ' · expected ' + niceDay(b.until) : '');
  return 'not now' + (b.note ? ' (' + b.note + ')' : '') + (b.until ? ' · back ' + niceDay(b.until) : '');
}
function blockChip(t) {
  const s = blockState(st, t);
  if (!s || !s.blocked) return '';
  const ic = t.block.kind === 'task' ? '🚧 ' : t.block.kind === 'cond' ? '⏳ ' : '⏸ ';
  const soon = t.d && dueDays(t) <= 2;
  return '<span class="chip blkc' + (soon ? ' warn' : '') + '" title="Can\'t start yet">' + ic + esc(blockText(t, s)) + '</span>';
}
function blockEditor(x) {
  if (x.done) return '';
  const b = x.block, s = blockState(st, x);
  if (!blk || blk.id !== x.id) {
    if (b && s && s.blocked) return '<div class="blkbox on"><b>🚧 Can\'t start yet:</b> ' + esc(blockText(x, s)) +
      '<div class="btnrow" style="margin-top:8px"><button class="btn sm sec"' + C('blkStart', x.id, b.kind) + '>Change</button><button class="btn sm"' + C('blkClear', x.id) + '>✓ I can do it now</button></div></div>';
    return '<div class="blkbox"><b>🚧 Can\'t do this yet?</b><div class="s" style="margin:2px 0 8px">It comes off your plan until it\'s possible, then comes back on its own.</div><div class="conf-row">' +
      '<button class="pill"' + C('blkStart', x.id, 'task') + '>Another task comes first</button><button class="pill"' + C('blkStart', x.id, 'cond') + '>Something else has to happen</button><button class="pill"' + C('blkStart', x.id, 'later') + '>Just not now</button></div></div>';
  }
  const kinds = '<div class="seg" style="margin:0 0 10px">' + [['task', 'Task first'], ['cond', 'Something happens'], ['later', 'Not now']].map((k) => '<button class="' + (blk.kind === k[0] ? 'on' : '') + '"' + C('blkStart', x.id, k[0]) + '>' + k[1] + '</button>').join('') + '</div>';
  let form;
  if (blk.kind === 'task') {
    const cands = sorted(st.tasks.filter((t) => !t.done && t.id !== x.id && blk.deps.indexOf(t.id) < 0 && !dependsOn(st, t.id, x.id)));
    form = '<span class="lbl">Has to be done first</span>' +
      (blk.deps.length ? '<div class="conf-row" style="margin-bottom:8px">' + blk.deps.map((id) => { const t = st.tasks.find((y) => y.id === id); return t ? '<span class="pill on">' + esc(t.t) + ' <span' + C('blkUndep', id) + ' style="cursor:pointer">×</span></span>' : ''; }).join('') + '</div>' : '') +
      '<div class="row"><select id="bdep" style="margin:0"><option value="">Choose a task…</option>' + cands.map((t) => '<option value="' + t.id + '">' + esc(t.t) + (t.d ? ' · due ' + niceDay(t.d) : '') + '</option>').join('') + '</select><button class="btn sm sec" style="flex:none"' + C('blkDep') + '>Add</button></div>' +
      '<div class="s" style="margin-top:6px">Your plan schedules those first. This one goes back on as soon as they\'re checked off (including when Canvas sees you submitted them).</div>';
  } else if (blk.kind === 'cond') {
    form = '<span class="lbl">What has to happen first?</span><input id="bnote" value="' + esc(blk.note) + '" placeholder="e.g. Lab partner sends data, lecture covers chapter 5, TA replies">' +
      '<span class="lbl">When do you expect it? (optional)</span><input type="date" id="buntil" value="' + esc(blk.until) + '">' +
      '<div class="s">Until then it stays off your plan. On that date it\'s planned again and I ask if it happened.</div>';
  } else {
    form = '<span class="lbl">Back on my list on (optional)</span><input type="date" id="buntil" value="' + esc(blk.until) + '"><span class="lbl">Why? (optional)</span><input id="bnote" value="' + esc(blk.note) + '" placeholder="e.g. after the midterm">' +
      '<div class="s">Without a date, it stays parked until you unpark it.</div>';
  }
  return '<div class="blkbox on">' + kinds + form + '<div class="btnrow" style="margin-top:10px"><button class="btn sm"' + C('blkSave') + '>Save</button><button class="btn sm mute"' + C('blkCancel') + '>Cancel</button>' +
    (b ? '<button class="btn sm sec"' + C('blkClear', x.id) + '>Remove block</button>' : '') + '</div></div>';
}
function blockedCard() {
  const list = sorted(st.tasks.filter((t) => isBlocked(st, t)));
  if (!list.length) return '';
  const rows = list.slice(0, 8).map((t) => {
    const s = blockState(st, t), b = t.block, soon = t.d && dueDays(t) <= 3;
    let act;
    if (b.kind === 'task' && s.waiting[0]) act = '<button class="btn sm sec"' + C('fStart', s.waiting[0].id) + ' title="Start a focus round on what it is waiting for">▶ Do “' + esc(s.waiting[0].t.slice(0, 22)) + (s.waiting[0].t.length > 22 ? '…' : '') + '”</button>';
    else if (b.kind === 'cond' && s.check) act = '<button class="btn sm"' + C('blkClear', t.id) + '>Yes, it happened</button><button class="btn sm sec"' + C('blkNotYet', t.id) + '>Not yet</button>';
    else act = '<button class="btn sm sec"' + C('blkClear', t.id) + '>I can do it now</button>';
    return '<div class="item" style="flex-wrap:wrap"><div class="t" style="cursor:pointer"' + C('cantNow', t.id) + '>' + esc(t.t) + '<div class="s">' + tag(t) + (t.d ? '<span class="chip' + (soon ? ' warn' : '') + '">' + (soon ? '⚠ due ' : 'due ') + niceDay(t.d) + '</span>' : '') + esc(blockText(t, s)) + '</div></div><div class="btnrow" style="flex:none">' + act + '</div></div>';
  }).join('');
  const checks = list.filter((t) => blockState(st, t).check).length;
  return '<div class="card' + (checks ? ' warn' : '') + '"><h3>🚧 Can\'t start yet (' + list.length + ')</h3><div class="s" style="margin-bottom:6px">Off your plan until they\'re possible. ' + (checks ? '<b>' + checks + ' need' + (checks === 1 ? 's' : '') + ' a quick check.</b>' : '') + '</div>' + rows + (list.length > 8 ? '<div class="s">+' + (list.length - 8) + ' more under Tasks → Can\'t start yet</div>' : '') + '</div>';
}

ACT.filter = (f) => { filter = f; render(); };
ACT.quickAdd = () => { const v = $('qa').value.trim(); if (!v) return; st.tasks.push({ id: newId(), t: v, d: '', p: 'm', cls: 0, est: 60, fixed: 0, done: false, spent: 0 }); save(); render(); toast('Added ✓'); };
ACT.doneChunk = (id, m) => { st.tasks.forEach((x) => { if (x.id === id) x.spent = (x.spent || 0) + m; }); save(); render(); burst(); toast(dur(m) + ' logged ✓'); };
ACT.calMove = (n) => { cal = new Date(cal.getFullYear(), cal.getMonth() + n, 1); render(); };
ACT.selDay = (s) => { sel = s; render(); };
ACT.openDay = (s) => { pd = s; sv = 'day'; tab = 'sched'; render(); };
ACT.sv = (v) => { sv = v; st.cfg.sv = v; save(); render(); };
ACT.wo = (n) => { wo = n === 0 ? 0 : wo + n; render(); };
ACT.shiftPd = (n) => { const d = new Date(pd + 'T00:00:00'); d.setDate(d.getDate() + n); pd = iso(d); render(); };
ACT.addBlock = () => { const t = $('bt').value.trim(), s = $('bs').value, e = $('be').value; if (!t || !s || !e || mn(e) <= mn(s)) return toast('Add a name and valid times'); st.blocks.push({ id: newId(), d: pd, t, s, e }); save(); render(); };
ACT.delBlock = (id) => { st.blocks = st.blocks.filter((b) => b.id !== id); save(); render(); };
ACT.bmMove = (n) => { bm = new Date(bm.getFullYear(), bm.getMonth() + n, 1); render(); };
ACT.txType = () => { const el = EL; $('tc').style.display = el.value === 'in' ? 'none' : ''; };
ACT.addTx = () => {
  const a = parseFloat($('ta').value); if (!a || a <= 0) return toast('Enter an amount');
  const type = $('tt').value;
  st.tx.push({ id: newId(), n: $('tn').value.trim() || (type === 'in' ? 'Income' : 'Expense'), a, type, c: type === 'in' ? 'Income' : $('tc').value, d: $('td').value || todayS });
  save(); render();
};
ACT.delTx = (id) => { st.tx = st.tx.filter((x) => x.id !== id); save(); render(); };
ACT.addClass = () => {
  const n = $('cn').value.trim(), s = $('c1').value, e = $('c2').value;
  const days = [...document.querySelectorAll('.dchk:checked')].map((x) => +x.value);
  if (!n || !s || !e || !days.length || mn(e) <= mn(s)) { $('cmsg').textContent = 'Add a name, pick days, and set valid start/end times.'; return; }
  let c = st.classes.find((x) => x.n.toLowerCase() === n.toLowerCase());
  if (!c) { c = { id: newId(), n, color: $('cc1').value, slots: [] }; st.classes.push(c); }
  days.forEach((d) => c.slots.push({ day: d, s, e, loc: $('cl').value.trim() }));
  save(); render();
};
ACT.delSlot = (cid, i) => { cls(cid).slots.splice(i, 1); save(); render(); };
ACT.delClass = (id) => { if (!confirm('Delete this class? Its tasks stay, under General.')) return; st.classes = st.classes.filter((c) => c.id !== id); st.tasks.forEach((t) => { if (t.cls === id) t.cls = 0; }); save(); render(); };
ACT.renameClass = (id) => { const el = EL; const c = cls(id); if (c && el.value.trim()) { c.n = el.value.trim(); save(); } };
ACT.recolor = (id) => { const el = EL; const c = cls(id); if (c) { c.color = el.value; save(); render(); } };
ACT.setCfg = () => {
  const c = st.cfg;
  c.ds = $('cfs').value || '08:00'; c.de = $('cfe').value || '22:00';
  c.pace = +$('cfp').value; c.cap = Math.max(1, Math.min(12, +$('cfc').value || 5)); c.goal = Math.max(10, Math.min(600, +$('cfg2').value || 90));
  c.prep = Math.max(0, Math.min(240, +$('cfp2').value || 0)); c.buf = Math.max(0, Math.min(60, +$('cfb').value || 0));
  if ($('cfa')) c.ahead = +$('cfa').value;
  save(); render();
};
ACT.setTheme = (k) => { st.cfg.theme = k; st.cfg.themePicked = true; save(); applyTheme(); render(); };
ACT.setMode = (m) => { st.cfg.mode = m; save(); applyTheme(); render(); };
ACT.setFlag = (k) => { const el = EL; st.cfg[k] = el.checked; save(); if (k === 'digest') send({ cmd: 'reschedule' }); if (k === 'sound') send({ cmd: 'timer', op: 'ambient' }); };
ACT.digestTime = () => { const el = EL; st.cfg.digestTime = el.value || '08:00'; save(); send({ cmd: 'reschedule' }); };
ACT.setDayCfg = (wd) => {
  const c = st.cfg; c.days = c.days || {};
  const o = {}, a = $('ds' + wd).value, b = $('de' + wd).value, h = parseFloat($('dc' + wd).value);
  if (a && a !== c.ds) o.ds = a; if (b && b !== c.de) o.de = b;
  if (!isNaN(h) && h !== c.cap) o.cap = Math.max(0, Math.min(14, h));
  if (Object.keys(o).length) c.days[wd] = o; else delete c.days[wd];
  save(); render();
};
ACT.resetDay = (wd) => { if (st.cfg.days) delete st.cfg.days[wd]; save(); render(); };
ACT.saveDateCfg = () => {
  const c = st.cfg; c.dates = c.dates || {}; const h = parseFloat($('xc').value);
  c.dates[pd] = { ds: $('xs').value || c.ds, de: $('xe').value || c.de, cap: isNaN(h) ? c.cap : Math.max(0, Math.min(14, h)) };
  save(); render(); toast('Saved for this day ✓');
};
ACT.clearDateCfg = () => { if (st.cfg.dates) delete st.cfg.dates[pd]; save(); render(); };
ACT.addRoutine = () => {
  const n = $('rn').value.trim(), a = $('rs').value, b = $('re').value;
  const days = [...document.querySelectorAll('.rchk:checked')].map((x) => +x.value);
  if (!n || !a || !b || !days.length || mn(b) <= mn(a)) { $('rmsg').textContent = 'Add a name, a start and end time, and at least one day.'; return; }
  st.routines.push({ id: newId(), name: n, s: a, e: b, days }); save(); render(); toast('Added ✓');
};
ACT.addTypical = () => {
  [['Breakfast', '08:00', '08:30'], ['Lunch', '12:00', '12:45'], ['Dinner', '18:00', '19:00'], ['Chores', '19:15', '19:45'], ['Wind down', '21:30', '22:00']]
    .forEach((r, i) => st.routines.push({ id: newId() + i, name: r[0], s: r[1], e: r[2], days: [0, 1, 2, 3, 4, 5, 6] }));
  save(); render(); toast('Added. Remove any that do not fit.');
};
ACT.delRoutine = (id) => { st.routines = st.routines.filter((r) => r.id !== id); save(); render(); };
ACT.toggleAlt = () => { showAlt = !showAlt; render(); };
ACT.useTask = (id) => { recOverride = id; showAlt = false; render(); toast('Switched ✓'); };
ACT.backToRec = () => { recOverride = 0; showAlt = false; render(); };
ACT.addUse = () => { const v = $('alt').value.trim(); if (!v) return; const id = newId(); st.tasks.push({ id, t: v, d: '', p: 'm', cls: 0, est: 30, fixed: 0, done: false, spent: 0 }); save(); ACT.useTask(id); };
ACT.breakDown = (tid) => breakDown(tid);
ACT.complete = (id) => { st.tasks.forEach((t) => { if (t.id === id) { t.done = true; t.doneAt = todayS; } }); const ready = sweepBlocks(st); save(); send({ cmd: 'timer', op: 'stop' }); burst(); toast('Task complete! 🎉'); readyToast(ready); };

/* --- focus timer --- */
ACT.fStart = (tid, minutes, phase) => send({ cmd: 'timer', op: 'start', tid: tid == null ? focusTid : tid, minutes: minutes || 0, phase: phase || 'work' });
ACT.fStartSel = () => { const v = +$('fcustom').value; send({ cmd: 'timer', op: 'start', tid: +$('ftask').value || 0, minutes: v > 0 ? v : 0, phase: 'work' }); };
ACT.fOp = (op, extra) => send(Object.assign({ cmd: 'timer', op }, extra || {}));
ACT.fTask = () => { const el = EL; focusTid = +el.value || 0; if (timer.status !== 'idle') send({ cmd: 'timer', op: 'task', tid: focusTid }); };
ACT.fPreset = (id) => { T().presetId = id; save(); if (timer.status === 'idle' || timer.status === 'ready') send({ cmd: 'timer', op: 'stop', resetRound: true }); render(); };
ACT.tSet = (k) => { const el = EL;
  const v = el.type === 'checkbox' ? el.checked : el.type === 'range' || el.type === 'number' ? +el.value : el.value;
  T()[k] = v; save();
  if (k === 'ambient' || k === 'ambientVol') send({ cmd: 'timer', op: 'ambient' });
  if (k === 'badge') send({ cmd: 'reschedule' });
  if (el.type !== 'range') render();
};
ACT.preview = (key) => { const s = T()[key]; playSound(s, T().volume); };
ACT.previewAmb = () => { send({ cmd: 'timer', op: 'ambient' }); if (timer.status !== 'running' || timer.phase !== 'work') toast('Background noise plays during focus rounds'); };
ACT.presetEdit = () => { presetEdit = !presetEdit; render(); };
ACT.pSet = (i, k) => { const el = EL; const p = T().presets[i]; if (!p) return; p[k] = k === 'name' ? (el.value.trim() || p.name) : Math.max(1, Math.min(240, +el.value || 1)); save(); };
ACT.pAdd = () => { const id = 'c' + Date.now(); T().presets.push({ id, name: 'My timer', work: 30, short: 5, long: 20, rounds: 4 }); T().presetId = id; save(); render(); };
ACT.pDel = (i) => { if (T().presets.length < 2) return toast('Keep at least one timer'); const p = T().presets.splice(i, 1)[0]; if (T().presetId === p.id) T().presetId = T().presets[0].id; save(); render(); };
ACT.pReset = () => { if (!confirm('Restore the built-in timers? Custom ones are removed.')) return; T().presets = PRESETS.map((p) => Object.assign({}, p)); T().presetId = 'pomo'; save(); render(); };

/* --- sync --- */
ACT.connectCanvas = () => {
  const host = cleanHost($('cvh').value);
  if (!host || host.indexOf('.') < 0) return toast('Enter your Canvas address, like canvas.ubc.ca');
  const token = $('cvt').value.trim();
  ext.permissions.request({ origins: ['https://' + host + '/*'] }).then((ok) => {
    if (!ok) { toast('Permission was not granted'); return; }
    st.canvas.host = host; st.canvas.token = token; save();
    send({ cmd: 'reschedule' });
    ACT.syncNow('canvas');
  });
};
ACT.saveToken = () => { st.canvas.token = $('cvt').value.trim(); save(); toast('Token saved'); ACT.syncNow('canvas'); };
ACT.disconnectCanvas = () => {
  if (!confirm('Stop syncing with Canvas? Your tasks stay.')) return;
  const h = st.canvas.host;
  st.canvas.host = ''; st.canvas.token = ''; st.canvas.lastStatus = null; save(); send({ cmd: 'reschedule' });
  if (h) ext.permissions.remove({ origins: ['https://' + h + '/*'] }).catch(() => {});
  render();
};
ACT.syncNow = async (what, id) => {
  syncBusy = what + (id || ''); render();
  const r = await send({ cmd: 'sync', what: what || 'all', id });
  syncBusy = ''; render();
  const res = what === 'all' ? (r && r.canvas) : r;
  if (res) toast(res.kind === 'err' ? 'Sync problem: see details' : 'Synced: ' + res.text);
};
ACT.cvSet = (k) => { const el = EL;
  st.canvas[k] = el.type === 'checkbox' ? el.checked : el.tagName === 'SELECT' ? +el.value : el.value;
  save(); if (k === 'auto' || k === 'interval') send({ cmd: 'reschedule' }); render();
};
ACT.cvCourse = (id) => { const el = EL;
  const ex = (st.canvas.excluded || []).filter((x) => x !== id);
  if (!el.checked) ex.push(id);
  st.canvas.excluded = ex; save(); render();
};
ACT.addFeed = () => {
  const url = $('fu').value.trim().replace(/^webcal:/i, 'https:');
  const origin = originOf(url);
  if (!origin || !/^https:/.test(origin)) return toast('Paste a https:// or webcal:// calendar link');
  ext.permissions.request({ origins: [origin + '/*'] }).then(async (ok) => {
    if (!ok) return toast('Permission was not granted');
    const f = { id: 'f' + Date.now(), name: $('fn').value.trim() || new URL(url).hostname, url, type: $('ft').value, cls: +$('fc').value || 0, color: PAL[(st.feeds.length + 3) % PAL.length] };
    st.feeds.push(f); save(); send({ cmd: 'reschedule' });
    ACT.syncNow('feed', f.id);
  });
};
ACT.reconnectFeed = (id) => {
  const f = st.feeds.find((x) => x.id === id); if (!f) return;
  ext.permissions.request({ origins: [originOf(f.url) + '/*'] }).then((ok) => { if (ok) ACT.syncNow('feed', id); });
};
ACT.delFeed = (id) => {
  if (!confirm('Remove this calendar? Tasks it already added stay; its events disappear.')) return;
  st.feeds = st.feeds.filter((f) => f.id !== id); st.events = st.events.filter((e) => e.feed !== id); save(); send({ cmd: 'reschedule' }); render();
};
ACT.resolve = (uid, useTheirs) => {
  const c = st.conflicts.find((x) => x.uid === uid);
  if (c && useTheirs) st.tasks.forEach((t) => { if (t.uid === uid) t.d = c.theirs; });
  st.conflicts = st.conflicts.filter((x) => x.uid !== uid); save(); render();
};
ACT.clearDismissed = () => { st.dismissed = []; save(); toast('Deleted Canvas items can come back on the next sync'); render(); };

/* --- manual import --- */
ACT.pickIcs = () => $('icsf').click();
ACT.loadICS = () => { const el = EL;
  const f = el.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    const list = icsToItems(parseICS(String(r.result)), 'file');
    if (!list.length) { imp.items = []; imp.msg = 'That file has no events.'; render(); return; }
    preview(list);
  };
  r.readAsText(f);
};
ACT.impText = () => { const el = EL; imp.text = el.value; };
ACT.impItem = (k) => { const el = EL; imp.items[k].sel = el.checked; render(); };
ACT.impDef = () => { const el = EL; imp.defCls = +el.value; };
ACT.impPast = () => { const el = EL; imp.hidePast = el.checked; };
ACT.aiExtract = () => aiExtract();
ACT.doImport = () => {
  const chosen = imp.items.filter((i) => i.sel);
  const S = mergeItems(st, chosen.map((i) => ({ title: i.title, due: i.due, uid: i.uid, cls: i.cls, est: i.est, p: i.p, kind: 'import' })), { source: 'import', skipPast: false });
  imp.items = []; imp.msg = 'Imported ' + S.added + ' task' + (S.added === 1 ? '' : 's') + (S.same ? ' (' + S.same + ' already there)' : '') + '. Find them in Tasks.';
  save(); render(); toast('Imported ' + S.added);
};

/* --- AI + backup --- */
ACT.askAI = (q) => askAI(q);
ACT.askQuick = (q) => askAI(q);
ACT.applyAI = () => applyAI();
ACT.dismissAI = () => { aiProps = []; render(); };
/* --- backups --- */
async function loadBk() {
  try { bk.perm = await ext.permissions.contains({ permissions: ['downloads'] }); } catch (e) { bk.perm = false; }
  const d = await ext.storage.local.get(['bkState', 'snaps']);
  bk.state = d.bkState || null;
  bk.snaps = (d.snaps || []).map((x) => ({ at: x.at, reason: x.reason, version: x.version, tasks: x.tasks, classes: x.classes }));
  bk.loaded = true;
  if (tab === 'backup' || tab === 'now') softRender();
}
ACT.bkEnable = () => {
  needDownloads().then(async (ok) => {
    if (!ok) return toast('Saving backup files needs the Triaj companion\'s permission');
    st.cfg.autoBackup = true; save();
    await loadBk(); ACT.bkNow();
  });
};
ACT.bkNow = async () => {
  if (!bk.perm) { // no permission: plain one-off download from this page
    const b = await makeBackup(st.cfg.backupSecrets !== false);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(b, null, 1)], { type: 'application/json' }));
    a.download = 'planner-backup-' + todayS + '.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return;
  }
  bk.busy = true; render();
  const r = await send({ cmd: 'backupNow', reason: 'manual' });
  bk.busy = false; await loadBk();
  toast(r && r.kind === 'ok' ? 'Backup saved ✓' : (r && r.text) || 'Backup failed');
};
ACT.bkShow = () => { try { ext.downloads.show(bk.state.latestId); } catch (e) { toast('Open your Downloads folder → Triaj Backups'); } };
ACT.bkFlag = (k) => { st.cfg[k] = EL.checked; save(); render(); };
ACT.bkBannerOff = () => { st.cfg.bkBannerOff = true; save(); render(); };
async function applyRestore(p, label) {
  await send({ cmd: 'snapshot', reason: 'Before restoring ' + label });
  const keep = { canvas: st.canvas, feeds: st.feeds, aiKey: st.cfg.aiKey, geminiKey: st.cfg.geminiKey, geminiModel: st.cfg.geminiModel, aiProvider: st.cfg.aiProvider };
  adopt(p.plan);
  if (!st.canvas.host) st.canvas = keep.canvas;
  else if (!st.canvas.token && keep.canvas.token && keep.canvas.host === st.canvas.host) st.canvas.token = keep.canvas.token;
  if (!st.feeds.length) st.feeds = keep.feeds;
  if (!st.cfg.aiKey) st.cfg.aiKey = keep.aiKey;
  if (!st.cfg.geminiKey && keep.geminiKey) { st.cfg.geminiKey = keep.geminiKey; st.cfg.geminiModel = keep.geminiModel; st.cfg.aiProvider = st.cfg.aiProvider || keep.aiProvider; }
  if (p.dlog) { dlog = p.dlog; await ext.storage.local.set({ dlog }); }
  st.cfg.welcomed = true;
  save(); send({ cmd: 'reschedule' }); render();
  toast('Restored ✓ ' + st.tasks.length + ' tasks, ' + st.classes.length + ' classes');
  if (st.canvas.host) ext.permissions.contains({ origins: ['https://' + st.canvas.host + '/*'] }).then((ok) => {
    if (!ok) setTimeout(() => toast('One more step: More → Sync → Connect, so Canvas sync has permission again'), 2500);
  });
}
ACT.pickRestore = () => $('rf').click();
ACT.restore = () => { const el = EL;
  const f = el.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    let p = null;
    try { p = parseBackup(JSON.parse(r.result)); } catch (e) {}
    el.value = '';
    if (!p) return toast('That is not a planner backup file');
    const sm = p.summary || {};
    const when = p.at ? new Date(p.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'an older version';
    if (!confirm('Restore the backup from ' + when + '?\n\n' + (sm.tasks || 0) + ' tasks, ' + (sm.classes || 0) + ' classes' + (sm.routines ? ', ' + sm.routines + ' routines' : '') +
      '\n\nThis replaces what is in the planner now (' + st.tasks.length + ' tasks). A copy of the current data is kept under Backups → Earlier copies, so you can undo.')) return;
    applyRestore(p, 'backup file from ' + when);
  };
  r.readAsText(f);
};
ACT.snapRestore = async (i) => {
  const d = await ext.storage.local.get('snaps'), sn = (d.snaps || [])[i];
  if (!sn) return;
  const when = new Date(sn.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  if (!confirm('Go back to the copy from ' + when + ' (' + sn.tasks + ' tasks)?\n\nThe current data is saved as a copy first, so you can undo this.')) return;
  applyRestore({ plan: sn.plan, dlog: sn.dlog }, 'an earlier copy from ' + when);
};
function restoreCard(big) {
  return '<div class="card' + (big ? ' hero' : '') + '"><h3>' + (big ? '🛟 Had data before? Bring it back' : '♻️ Restore from a backup file') + '</h3>' +
    '<div class="s" style="margin-bottom:10px' + (big ? ';color:#fff' : '') + '">Pick <b>Downloads → Triaj Backups → triaj-backup-latest.json</b> (or a dated one). Backups from the My Planner extension (<b>My Planner Backups → planner-backup-latest.json</b>) and from the old Claude artifact work too.</div>' +
    '<button class="btn"' + (big ? ' style="background:#fff;color:#1c1c22"' : '') + C('pickRestore') + '>Choose backup file</button><input type="file" id="rf" accept=".json,application/json" style="display:none"' + CH('restore') + '></div>';
}
function backupBanner() {
  if (session.user || !bk.loaded || bk.perm || st.cfg.bkBannerOff || st.cfg.autoBackup === false || !(st.tasks.length || st.classes.length)) return '';
  return '<div class="card warn"><div class="hrow"><h3>🛟 Protect your planner</h3><button class="x"' + C('bkBannerOff') + '>×</button></div><div class="s" style="margin-bottom:8px">Right now your planner only lives in this browser. Sign in to keep it in your account and on all your devices, or save a backup file to Downloads every day.</div><div class="btnrow"><button class="btn sm"' + C('signIn') + '>Sign in</button><button class="btn sm sec"' + C('bkEnable') + '>Turn on daily backups</button></div></div>';
}
function viewBackup() {
  if (!bk.loaded) { loadBk(); return '<div class="empty">Loading…</div>'; }
  const bs = bk.state || {}, c = st.cfg;
  let status;
  if (!bk.perm && session.user) status = '<div class="stbox ok"><b>☁ Saved to your account</b><div class="s" style="margin:4px 0 8px">Everything is kept in your Triaj account (' + esc(session.user.email || '') + ') and syncs to every browser you sign in on. Backup files are an optional extra copy in your Downloads folder (they need the Triaj companion extension).</div><button class="btn sm sec"' + C('bkEnable') + '>Also save daily backup files</button></div>';
  else if (!bk.perm) status = '<div class="stbox warn"><b>⚠ Only in this browser</b><div class="s" style="margin:4px 0 8px">Your data only lives in this browser right now. Sign in to keep it in your account, or turn on daily backup files in your Downloads folder (needs the Triaj companion extension).</div><div class="btnrow"><button class="btn sm"' + C('signIn') + '>Sign in</button><button class="btn sm sec"' + C('bkEnable') + '>Turn on daily backups</button></div></div>';
  else if (bs.lastErr && !bs.lastAt) status = '<div class="stbox err"><b>❌ ' + esc(bs.lastErr) + '</b></div>';
  else if (bs.lastAt) status = '<div class="stbox ' + (bs.lastErr ? 'warn' : 'ok') + '"><b>' + (bs.lastErr ? '⚠ ' + esc(bs.lastErr) : '✅ Last backup ' + ago(bs.lastAt)) + '</b><div class="s" style="margin-top:4px">' + (bs.lastTasks !== undefined ? bs.lastTasks + ' tasks · ' : '') + 'Downloads/Triaj Backups/triaj-backup-latest.json, plus one dated file per day for the last 14 days</div></div>';
  else status = '<div class="stbox info"><b>No backup file yet</b><div class="s">Press Back up now to make the first one.</div></div>';
  const chk = (k, l, def) => '<div class="check"><input type="checkbox" id="bk_' + k + '"' + ((def ? c[k] !== false : !!c[k]) ? ' checked' : '') + CH('bkFlag', k) + '><label for="bk_' + k + '">' + l + '</label></div>';
  const main = '<div class="card"><h3>🛟 Backups</h3>' + status +
    '<div class="btnrow" style="margin-top:10px"><button class="btn"' + C('bkNow') + (bk.busy ? ' disabled' : '') + '>' + (bk.busy ? 'Saving…' : '💾 Back up now') + '</button>' + (bk.perm && bs.latestId ? '<button class="btn sec"' + C('bkShow') + '>Show in folder</button>' : '') + '</div>' +
    '<div style="margin-top:10px">' + chk('autoBackup', 'Back up automatically once a day', true) +
    chk('backupSecrets', 'Include my Canvas token and AI keys (a restore then needs no setup; keep the file private)', true) + '</div>' +
    '<div class="s" style="margin-top:6px">Everything is included: tasks, classes and times, routines, hours per day, budget, focus history, timer settings and sounds, calendar feeds, Canvas settings and download history.</div></div>';
  const snaps = '<div class="card"><h3>🕘 Earlier copies</h3><div class="s" style="margin-bottom:6px">Kept in this browser: one a day, one before every Triaj update, and one before every restore. Use these to undo a mistake or a bad update.</div>' +
    (bk.snaps.length ? bk.snaps.map((x, i) => '<div class="item"><div class="t">' + new Date(x.at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + '<div class="s">' + esc(x.reason) + ' · ' + x.tasks + ' tasks, ' + (x.classes || 0) + ' classes · v' + esc(x.version) + '</div></div><button class="btn sm sec"' + C('snapRestore', i) + '>Restore</button></div>').join('') : '<div class="empty" style="padding:8px">The first copy is made within the hour.</div>') + '</div>';
  const how = '<div class="card"><h3>🔁 Updates</h3><ol class="s" style="margin:4px 0 0 18px;padding:0;line-height:1.7">' +
    '<li>Triaj updates itself: a new version loads the next time you open it. A copy of your data is kept here first.</li>' +
    '<li>' + (session.user ? 'Your planner is in your account, so clearing this browser or switching computers loses nothing. Just sign in again.' : 'Sign in to keep your planner in your account, so clearing this browser or switching computers loses nothing.') + '</li>' +
    '<li>The companion extension rarely changes. To update it, copy the new files over the old folder and press reload on your browser\'s extensions page.</li>' +
    '<li>Moving over from the My Planner extension? There: More → Backups → Back up now. Here: Restore and pick that file.</li></ol></div>';
  return '<div class="cols"><div>' + main + restoreCard(false) + '</div><div>' + how + snaps + '</div></div>';
}
ACT.install = () => install();
ACT.signIn = () => window.dispatchEvent(new CustomEvent('triaj:signin'));
ACT.dismissWelcome = () => { welcome = false; st.cfg.welcomed = true; save(); render(); };

['click', 'change', 'input', 'keydown'].forEach((type) => document.addEventListener(type, (e) => {
  if (type === 'keydown' && (e.key !== 'Enter' || e.shiftKey || e.target.tagName === 'TEXTAREA')) return;
  const key = type === 'keydown' ? 'enter' : type;
  const el = e.target.closest && e.target.closest('[data-' + key + ']');
  if (!el) return;
  const fn = ACT[el.dataset[key]];
  if (!fn) return;
  if (type === 'click' && el.tagName === 'A') e.preventDefault();
  let args = [];
  try { args = el.dataset.args ? JSON.parse(el.dataset.args) : []; } catch (er) {}
  EL = el;
  fn(...args);
}));

/* ================= scheduling ================= */
function dayCfg(ds) {
  const c = st.cfg, wd = new Date(ds + 'T00:00:00').getDay();
  const o = Object.assign({}, (c.days || {})[wd], (c.dates || {})[ds]);
  return { ds: o.ds || c.ds, de: o.de || c.de, cap: (o.cap !== undefined && o.cap !== '') ? +o.cap : c.cap };
}
function sorted(list) {
  const o = { h: 0, m: 1, l: 2 };
  return list.slice().sort((a, b) => {
    if (!!a.done !== !!b.done) return a.done ? 1 : -1;
    const da = a.d || '9999', db = b.d || '9999';
    if (da !== db) return da < db ? -1 : 1;
    const ta = a.time || '99', tb = b.time || '99';
    return ta < tb ? -1 : ta > tb ? 1 : o[a.p] - o[b.p];
  });
}
function dayBusy(ds) {
  const wd = new Date(ds + 'T00:00:00').getDay(), b = [];
  const ic = st.tasks.filter((t) => t.inClass && t.d === ds).map((t) => ({ t, sl: inClassSlot(st, t) })).filter((x) => x.sl);
  const icName = (list) => list.map((x) => (x.t.done ? '✓ ' : '') + x.t.t).join(', ');
  st.classes.forEach((c) => c.slots.forEach((s) => {
    if (s.day !== wd) return;
    const tests = ic.filter((x) => x.sl.matched && x.sl.cls.id === c.id && x.sl.s === mn(s.s));
    b.push({ s: mn(s.s), e: mn(s.e), kind: 'class', title: tests.length ? '📝 ' + icName(tests) + ' · ' + c.n : c.n, color: c.color, loc: s.loc, tests: tests.map((x) => x.t) });
  }));
  ic.filter((x) => !x.sl.matched).forEach((x) => { const col = (cls(x.t.cls) || { color: '#475569' }).color; b.push({ s: x.sl.s, e: x.sl.e, kind: 'test', title: '📝 ' + icName([x]) + (x.sl.cls ? ' · ' + x.sl.cls.n : ''), color: col, tests: [x.t] }); });
  st.blocks.forEach((x) => { if (x.d === ds) b.push({ s: mn(x.s), e: mn(x.e), kind: 'block', title: x.t, color: '#888', id: x.id }); });
  st.routines.forEach((r) => { if ((r.days || []).indexOf(wd) > -1) b.push({ s: mn(r.s), e: mn(r.e), kind: 'routine', title: r.name, color: '#8d99ae' }); });
  st.events.forEach((e) => { if (e.d === ds && !e.allDay) b.push({ s: e.s, e: Math.max(e.e, e.s + 15), kind: 'event', title: e.title, color: e.color || '#64748b' }); });
  return b.sort((a, c) => a.s - c.s);
}
function allDay(ds) { return st.events.filter((e) => e.d === ds && e.allDay); }
function freeSlots(ds, from) {
  const dc = dayCfg(ds), pr = st.cfg.prep === undefined ? 30 : st.cfg.prep, bf = st.cfg.buf === undefined ? 10 : st.cfg.buf;
  const hi = mn(dc.de), free = [];
  let cur = Math.max(mn(dc.ds) + pr, from);
  dayBusy(ds).forEach((b) => {
    const pad = b.kind === 'class' ? bf : 0;
    if (b.s - pad > cur) free.push([cur, Math.min(b.s - pad, hi)]);
    cur = Math.max(cur, b.e + pad);
  });
  if (cur < hi) free.push([cur, hi]);
  return free.filter((f) => f[1] - f[0] >= 20);
}
// Could this task be worked on that day? (Canvas lock dates, snoozes, conditions, and prerequisites
// that the simulated plan has already finished by then.)
// "due today" / "due Mon 19" after a study block's name, so work-ahead blocks are not mistaken for that day's items.
function dueTag(t, ds) {
  if (!t.d) return '';
  if (t.d === ds) return ' · due today';
  if (t.d < ds) return ' · overdue';
  return ' · due ' + niceDay(t.d);
}
function canStart(x, ds, rem) {
  if (x.opens && x.opens > ds) return false;
  // Don't plan work further ahead than the user's limit (More → Settings).
  const ahead = st.cfg.ahead === undefined ? 7 : +st.cfg.ahead;
  if (ahead > 0 && x.d && x.d > ds && Math.round((new Date(x.d + 'T00:00:00') - new Date(ds + 'T00:00:00')) / 864e5) > ahead) return false;
  const b = x.block;
  if (!b) return true;
  if (b.kind === 'later' || b.kind === 'cond') return !!(b.until && b.until <= ds);
  return (b.deps || []).every((id) => { const d = st.tasks.find((y) => y.id === id); return !d || d.done || !(rem[id] > 0); });
}
function autoPlan(upto) {
  const open = sorted(st.tasks.filter((t) => !t.done)), rem = {}, last = {}, out = {};
  open.forEach((t) => { rem[t.id] = remaining(t); });
  const d = new Date(); d.setHours(0, 0, 0, 0);
  const endD = new Date(upto + 'T00:00:00'), now = new Date();
  const nm = Math.ceil((now.getHours() * 60 + now.getMinutes()) / 15) * 15;
  while (d <= endD) {
    const ds = iso(d), items = [], cap = dayCfg(ds).cap * 60;
    let used = 0;
    freeSlots(ds, ds === todayS ? nm : 0).forEach((sl) => {
      let cur = sl[0];
      while (sl[1] - cur >= 20 && used < cap) {
        const t = open.find((x) => rem[x.id] > 0 && canStart(x, ds, rem));
        if (!t) break;
        const ch = Math.min(rem[t.id], 90, sl[1] - cur, cap - used);
        if (ch < 15 && ch < rem[t.id]) break;
        items.push({ s: cur, e: cur + ch, kind: 'work', t, title: '📚 ' + t.t + dueTag(t, ds), color: (cls(t.cls) || { color: '#6d28d9' }).color });
        rem[t.id] -= ch; used += ch; last[t.id] = ds; cur += ch + 10;
      }
    });
    out[ds] = items; d.setDate(d.getDate() + 1);
  }
  return { out, rem, last, open };
}
function dueDays(t) { return t.d ? Math.round((new Date(t.d + 'T00:00:00') - new Date(todayS + 'T00:00:00')) / 864e5) : 999; }
function score(t) {
  const d = dueDays(t), r = remaining(t) || need(t);
  let sc = 0;
  if (d < 0) sc = 100 + Math.min(20, -d * 2); else if (d < 999) sc = Math.max(0, 60 - d * 6);
  sc += ({ h: 20, m: 10, l: 0 })[t.p] || 0;
  if (r >= 180 && d <= 7) sc += 10;
  if (r <= 20) sc += 5;
  return sc;
}
function reason(t) {
  const d = dueDays(t), r = remaining(t) || need(t), a = [];
  if (d < 0) a.push('Overdue by ' + (-d) + ' day' + (d === -1 ? '' : 's'));
  else if (d === 0) a.push('Due today'); else if (d === 1) a.push('Due tomorrow');
  else if (d <= 7) a.push('Due in ' + d + ' days'); else if (d < 999) a.push('Due ' + t.d);
  else if (t.p === 'h') a.push('High priority'); else a.push('No due date');
  if (r >= 180 && d <= 7) a.push('big, start early');
  if (r <= 20) a.push('quick win');
  return a.join(' · ');
}

/* ================= shared pieces ================= */
const KIND = { quiz: 'Quiz', exam: 'Exam', discussion: 'Discussion', page: 'Page', note: 'Canvas to-do', 'peer review': 'Peer review', 'module-page': 'Reading', 'module-file': 'File', 'module-externaltool': 'Activity' };
function niceDay(d) { if (!d) return ''; const x = new Date(d + 'T00:00:00'), diff = dueDays({ d }); return diff >= 0 && diff < 7 ? DN[x.getDay()] + ' ' + x.getDate() : x.toLocaleDateString([], { month: 'short', day: 'numeric' }); }
function tmStr(x, always) {
  const sl = x.inClass ? inClassSlot(st, x) : null;
  if (sl) return ' ' + tf(sl.s);
  return x.time && (always || x.time !== '23:59') ? ' ' + tf(mn(x.time)) : '';
}
function icChip(x) {
  if (!x.inClass) return '';
  if (x.done) return '<span class="chip ic">📝 ' + (x.icDone ? 'done in class' : 'in class') + '</span>';
  const sl = inClassSlot(st, x);
  if (!x.d) return '<span class="chip ic warn">📝 In class · needs a date</span>';
  if (!sl) return '<span class="chip ic warn" title="Its class does not meet that day">📝 In class · pick a time</span>';
  return '<span class="chip ic">📝 In class ' + tf(sl.s) + '–' + tf(sl.e) + (sl.loc ? ' · ' + esc(sl.loc) : '') + '</span>';
}
function tag(t) { const c = cls(t.cls); return c ? '<span class="tag" style="background:' + c.color + ';color:' + onColor(c.color) + '">' + esc(c.n) + '</span>' : ''; }
function hourH(n) { const h = (window.innerHeight || 700) - ((window.innerWidth || 0) >= 900 ? 220 : 310); return Math.max(42, Math.min(96, Math.floor(h / Math.max(1, n)))); }
function ring(pct, size, sw) {
  const r = (size - sw) / 2, c = 2 * Math.PI * r;
  return '<div class="ringw" style="width:' + size + 'px;height:' + size + 'px"><svg width="' + size + '" height="' + size + '"><circle cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" fill="none" stroke="var(--soft)" stroke-width="' + sw + '"/><circle cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" fill="none" stroke="var(--pri)" stroke-width="' + sw + '" stroke-linecap="round" stroke-dasharray="' + c + '" stroke-dashoffset="' + (c * (1 - pct / 100)) + '" style="transition:stroke-dashoffset .6s"/></svg><b style="font-size:' + Math.round(size / 4.4) + 'px">' + pct + '%</b></div>';
}
function statusBox(s) {
  if (!s) return '';
  const ic = { ok: '✅', info: 'ℹ️', warn: '⚠️', err: '❌' }[s.kind] || '';
  return '<div class="stbox ' + s.kind + '"><b>' + ic + ' ' + esc(s.text) + '</b>' + (s.warnings && s.warnings.length ? '<div class="s" style="margin-top:4px">Could not read: ' + esc(s.warnings.join('; ')) + '</div>' : '') + (s.at ? '<div style="font-size:11px;color:var(--mute);margin-top:4px">' + ago(s.at) + (s.via ? ' · via ' + esc(s.via) : '') + '</div>' : '') + '</div>';
}
function classOpts(selId) { return '<option value="0">General</option>' + st.classes.map((c) => '<option value="' + c.id + '"' + (selId === c.id ? ' selected' : '') + '>' + esc(c.n) + '</option>').join(''); }

function taskRow(x) {
  if (editId === x.id) return editRow(x);
  const dd = dueDays(x);
  let chip;
  if (!x.d) chip = '<button class="chip nodate"' + C('editTask', x.id, 1) + '>＋ add date</button>';
  else if (dd < 0 && !x.done) chip = '<span class="chip bad">Overdue · ' + x.d + '</span>';
  else if (dd === 0) chip = '<span class="chip warn">Due today' + tmStr(x, true) + '</span>';
  else if (dd === 1) chip = '<span class="chip warn">Tomorrow' + tmStr(x, true) + '</span>';
  else chip = '<span class="chip">' + niceDay(x.d) + tmStr(x, false) + '</span>';
  if (!x.done && x.opens && x.opens > todayS) chip += '<span class="chip lock" title="Locked in Canvas until then">🔒 opens ' + niceDay(x.opens) + (x.opensTime ? ' ' + tf(mn(x.opensTime)) : '') + '</span>';
  else if (!x.done && x.locked) chip += '<span class="chip lock" title="Canvas shows this as locked for you">🔒 locked in Canvas</span>';
  if (KIND[x.kind]) chip += '<span class="chip">' + KIND[x.kind] + '</span>';
  chip += icChip(x);
  const bc = blockChip(x);
  chip += bc;
  const prog = x.spent ? ' · ' + dur(x.spent) + ' done' : '';
  const src = x.src === 'canvas' ? ' <span class="chip" title="Synced from Canvas">Canvas</span>' : x.src === 'syllabus' ? ' <span class="chip" title="Found in the syllabus">Syllabus</span>' : x.src === 'feed' ? ' <span class="chip">Calendar</span>' : '';
  const link = x.url ? ' <a class="lnk" href="' + esc(x.url) + '" target="_blank" rel="noopener">Open ↗</a>' : '';
  return '<div class="item' + (x.done ? ' done' : '') + (bc ? ' blocked' : '') + (justId === x.id ? ' just' : '') + '"><button class="chk"' + C('toggle', x.id) + '>' + (x.done ? '✓' : '') + '</button><div class="t"' + C('editTask', x.id) + ' style="cursor:pointer">' + esc(x.t) + '<div class="s">' + tag(x) + chip + (x.inClass ? '' : '<span>' + (x.fixed ? '📌 ' : '~') + dur(need(x)) + prog + '</span>') + src + link + '</div></div><span class="dot ' + x.p + '" title="' + PR[x.p] + '"></span>' +
    (canvasRef(x) ? '<button class="x" title="Get the files for this"' + C('getFiles', x.id) + '>📎</button>' : '') + (!x.done ? '<button class="x"' + C('fStart', x.id) + ' title="Focus on this">▶</button>' : '') + '<button class="x"' + C('delTask', x.id) + ' title="Delete">×</button></div>';
}
function editRow(x) {
  const vals = [15, 30, 45, 60, 90, 120, 180, 240, 360], cur = x.est || 60;
  if (vals.indexOf(cur) < 0) vals.push(cur);
  vals.sort((a, b) => a - b);
  return '<div class="editbox"><input id="et" value="' + esc(x.t) + '"' + EN('saveEdit', x.id) + '>' +
    '<span class="lbl">Due date</span><input type="date" id="ed" value="' + (x.d || '') + '"' + CH('icRefresh') + '>' +
    '<div class="qd"><button class="pill"' + C('setEd', 0) + '>Today</button><button class="pill"' + C('setEd', 1) + '>Tomorrow</button><button class="pill"' + C('setEd', 7) + '>In a week</button><button class="pill"' + C('setEd', -1) + '>No date</button></div>' +
    '<div class="row"><select id="ec"' + CH('icRefresh') + '>' + classOpts(x.cls) + '</select><select id="ee">' + vals.map((v) => '<option value="' + v + '"' + (v === cur ? ' selected' : '') + '>' + dur(v) + ' estimate</option>').join('') + '</select></div>' +
    '<input type="number" id="ef" min="1" max="1440" placeholder="Exact minutes (optional, overrides estimate and pace)" value="' + (x.fixed || '') + '">' +
    '<select id="ep">' + ['h', 'm', 'l'].map((p) => '<option value="' + p + '"' + (x.p === p ? ' selected' : '') + '>' + PR[p] + ' priority</option>').join('') + '</select>' +
    icEditor(x) +
    (x.url ? '<div class="s" style="margin-bottom:8px"><a class="lnk" href="' + esc(x.url) + '" target="_blank" rel="noopener">Open in Canvas ↗</a></div>' : '') +
    blockEditor(x) +
    '<div class="row"><button class="btn"' + C('saveEdit', x.id) + '>Save</button><button class="btn mute"' + C('cancelEdit') + '>Cancel</button></div></div>';
}
function taskForm(dt) {
  const ests = [[15, '15 min'], [30, '30 min'], [60, '1 hour'], [90, '1.5 hours'], [120, '2 hours'], [180, '3 hours'], [240, '4 hours']].map((e) => '<option value="' + e[0] + '"' + (e[0] === 60 ? ' selected' : '') + '>' + e[1] + '</option>').join('');
  const arg = dt ? sel : '';
  return '<div class="card"><div class="row"><input id="nt" placeholder="Add a task..." style="margin:0"' + EN('addTask', arg) + '><button class="btn" style="flex:none;width:auto;padding:10px 18px"' + C('addTask', arg) + '>Add</button></div>' +
    '<details style="margin-top:8px"><summary class="s">More options: class, time needed, due date, priority</summary><div style="margin-top:8px"><div class="row"><select id="nc">' + classOpts(0) + '</select><select id="ne">' + ests + '</select></div><input type="number" id="nf" min="1" max="1440" placeholder="Exact minutes (optional, overrides estimate and pace)">' +
    '<div class="check"><input type="checkbox" id="nic"><label for="nic">📝 Happens in class (test, quiz): no study time, shown on the class</label></div>' +
    '<div class="row">' + (dt ? '' : '<input type="date" id="nd">') + '<select id="np"><option value="m">Medium</option><option value="h">High</option><option value="l">Low</option></select></div></div></details></div>';
}

/* ================= views ================= */
function viewPlan() {
  const hz = new Date(); hz.setDate(hz.getDate() + 21);
  const hs = iso(hz), upto = pd > hs ? pd : hs, P = autoPlan(upto);
  const items = dayBusy(pd).concat(pd >= todayS ? (P.out[pd] || []) : []).sort((a, b) => a.s - b.s);
  let cm = 0, wm = 0;
  items.forEach((i) => { if (i.kind === 'class') cm += i.e - i.s; if (i.kind === 'work') wm += i.e - i.s; });
  const SUBL = { class: 'Class', work: 'Study block', routine: 'Routine', block: 'Your block', event: 'Calendar' };
  const rows = items.map((i) => {
    const sub = i.kind === 'class' ? 'Class' + (i.loc ? ' · ' + esc(i.loc) : '') : i.kind === 'work' ? 'Study time · ' + dur(i.e - i.s) : SUBL[i.kind];
    const b = i.kind === 'work' ? '<button class="x" title="Start focus"' + C('fStart', i.t.id, Math.min(i.e - i.s, 90)) + '>▶</button><button class="x" title="Mark this block done"' + C('doneChunk', i.t.id, i.e - i.s) + '>✓</button>' : i.kind === 'block' ? '<button class="x"' + C('delBlock', i.id) + '>×</button>' : '';
    return '<div class="blk" style="border-left:5px solid ' + i.color + '"><div class="tm">' + tf(i.s) + '<br>' + tf(i.e) + '</div><div class="t">' + esc(i.title) + '<div class="s">' + sub + '</div></div>' + b + '</div>';
  }).join('');
  const risk = P.open.filter((t) => t.d && t.d <= hs && (P.rem[t.id] > 0 || (P.last[t.id] && P.last[t.id] > t.d)));
  const ad = allDay(pd);
  return '<div class="nav"><button' + C('shiftPd', -1) + '>‹</button><span>' + new Date(pd + 'T00:00:00').toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }) + (pd === todayS ? '<div class="s">Today</div>' : '') + '</span><button' + C('shiftPd', 1) + '>›</button></div>' +
    (ad.length ? '<div class="s" style="margin-bottom:8px">All day: ' + ad.map((e) => esc(e.title)).join(' · ') + '</div>' : '') +
    '<div class="sum"><div>Class<b>' + dur(cm) + '</b></div><div>Study planned<b>' + dur(wm) + '</b></div><div>Max study<b>' + dayCfg(pd).cap + 'h</b></div></div>' +
    (risk.length ? '<div class="card warn"><b>⚠ May not finish by due date:</b><br>' + risk.map((t) => { const bs = blockState(st, t); return esc(t.t) + ' (due ' + t.d + ')' + (bs && bs.blocked ? ' · 🚧 ' + esc(blockText(t, bs)) : ''); }).join('<br>') + '<div class="s" style="margin-top:4px">Try a higher daily cap, a later end time, or a smaller estimate.</div></div>' : '') +
    '<div class="cols mcols"><div>' + dayTimeline(items) + '</div><div>' + (rows ? '<h3 style="margin:0 0 8px">Blocks</h3>' + rows : '<div class="empty">Nothing scheduled. Add classes and tasks with time estimates.</div>') +
    '<div class="card" style="margin-top:12px"><h3>Add your own block</h3><input id="bt" placeholder="e.g. Gym, Lunch, Meeting"><div class="row"><input type="time" id="bs"><input type="time" id="be"></div><button class="btn"' + C('addBlock') + '>Add block</button></div>' + dateCfgHtml() + '</div></div>';
}
function dateCfgHtml() {
  const dc = dayCfg(pd), mod = !!((st.cfg.dates || {})[pd]);
  return '<details class="card"><summary>Change hours for just this day' + (mod ? ' (customized)' : '') + '</summary><div class="row"><div>Start<input type="time" id="xs" value="' + dc.ds + '"></div><div>End<input type="time" id="xe" value="' + dc.de + '"></div><div>Max study (h)<input type="number" id="xc" min="0" max="14" step="0.5" value="' + dc.cap + '"></div></div><div class="row"><button class="btn"' + C('saveDateCfg') + '>Save for this day</button>' + (mod ? '<button class="btn mute"' + C('clearDateCfg') + '>Back to normal</button>' : '') + '</div></details>';
}
function dayTimeline(items) {
  const dcf = dayCfg(pd);
  let lo = Math.floor(mn(dcf.ds) / 60), hi = Math.ceil(mn(dcf.de) / 60);
  items.forEach((i) => { lo = Math.min(lo, Math.floor(i.s / 60)); hi = Math.max(hi, Math.ceil(i.e / 60)); });
  const H = hourH(hi - lo) + 6;
  let labels = '';
  for (let h = lo; h < hi; h++) labels += '<div style="height:' + H + 'px;font-size:11px;color:var(--mute)">' + (h % 12 || 12) + (h >= 12 ? ' PM' : ' AM') + '</div>';
  const bl = items.map((i) => {
    const top = (i.s / 60 - lo) * H, ht = Math.max(18, (i.e - i.s) / 60 * H - 1);
    const sty = i.kind === 'work' ? 'border:2px dashed ' + i.color + ';background:' + i.color + '22;color:var(--ink)' : 'background:' + i.color + ';color:' + onColor(i.color) + (i.tests && i.tests.length ? ';box-shadow:inset 0 0 0 2px ' + onColor(i.color) + ';font-weight:700' : '');
    return '<div class="wb" style="top:' + top + 'px;height:' + ht + 'px;font-size:12px;padding:3px 6px;' + sty + '"><b>' + esc(i.title) + '</b><br>' + tf(i.s) + ' – ' + tf(i.e) + '</div>';
  }).join('');
  const nm = new Date().getHours() * 60 + new Date().getMinutes();
  const ln = (pd === todayS && nm >= lo * 60 && nm < hi * 60) ? '<div class="nowl" style="top:' + ((nm / 60 - lo) * H) + 'px"></div>' : '';
  return '<div style="display:grid;grid-template-columns:44px 1fr;gap:4px"><div>' + labels + '</div><div class="wc" style="height:' + ((hi - lo) * H) + 'px;background-size:100% ' + H + 'px">' + bl + ln + '</div></div>';
}
function viewWeek() {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + wo * 7);
  const days = []; for (let i = 0; i < 7; i++) { const x = new Date(d); x.setDate(d.getDate() + i); days.push(x); }
  const lastS = iso(days[6]), P = autoPlan(lastS > todayS ? lastS : todayS);
  let lo = Math.floor(mn(st.cfg.ds) / 60), hi = Math.ceil(mn(st.cfg.de) / 60);
  const cols = days.map((x) => { const ds = iso(x); return { x, ds, it: dayBusy(ds).concat(ds >= todayS ? (P.out[ds] || []) : []) }; });
  cols.forEach((c) => c.it.forEach((i) => { lo = Math.min(lo, Math.floor(i.s / 60)); hi = Math.max(hi, Math.ceil(i.e / 60)); }));
  const H = hourH(hi - lo), total = (hi - lo) * H;
  let labels = '';
  for (let h = lo; h < hi; h++) labels += '<div style="height:' + H + 'px;font-size:10px;color:var(--mute)">' + (h % 12 || 12) + (h >= 12 ? 'p' : 'a') + '</div>';
  const nowM = new Date().getHours() * 60 + new Date().getMinutes();
  const heads = cols.map((c) => '<button class="wh' + (c.ds === todayS ? ' today' : '') + '"' + C('openDay', c.ds) + '>' + DN[c.x.getDay()] + '<br>' + c.x.getDate() + '</button>').join('');
  const body = cols.map((c) => {
    const bl = c.it.map((i) => {
      const top = (i.s / 60 - lo) * H, ht = Math.max(14, (i.e - i.s) / 60 * H - 1);
      const sty = i.kind === 'work' ? 'border:2px dashed ' + i.color + ';background:' + i.color + '22;color:var(--ink)' : 'background:' + i.color + ';color:' + onColor(i.color) + (i.tests && i.tests.length ? ';box-shadow:inset 0 0 0 2px ' + onColor(i.color) + ';font-weight:700' : '');
      return '<div class="wb" title="' + esc(i.title) + ' ' + tf(i.s) + '–' + tf(i.e) + '" style="top:' + top + 'px;height:' + ht + 'px;' + sty + '">' + esc(i.title) + '</div>';
    }).join('');
    const ln = (c.ds === todayS && nowM >= lo * 60 && nowM < hi * 60) ? '<div class="nowl" style="top:' + ((nowM / 60 - lo) * H) + 'px"></div>' : '';
    return '<div class="wc" style="height:' + total + 'px;background-size:100% ' + H + 'px">' + bl + ln + '</div>';
  }).join('');
  const lab = days[0].toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' – ' + days[6].toLocaleDateString([], { month: 'short', day: 'numeric' });
  return '<div class="nav"><button' + C('wo', -1) + '>‹</button><span>' + lab + (wo ? ' <button class="pill"' + C('wo', 0) + '>This week</button>' : '') + '</span><button' + C('wo', 1) + '>›</button></div>' +
    '<div class="wg"><div></div>' + heads + '</div>' +
    (cols.some((c) => st.tasks.some((t) => t.d === c.ds) || allDay(c.ds).length) ? '<div class="wg wdue"><div class="s" style="font-size:10px;align-self:center">Due</div>' + cols.map((c) => '<div>' + calChips(c.ds, 3) + '</div>').join('') + '</div>' : '') +
    '<div class="wg"><div>' + labels + '</div>' + body + '</div>' +
    '<div class="s" style="margin-top:10px">Solid = classes, routines, calendar events and your blocks. Dashed 📚 = suggested study time, labelled with when that task is due (it can be days later). Tap a day for its plan.' + (st.classes.some((c) => c.slots.length) ? '' : ' Add class times under More → Classes.') + '</div>';
}
function calColor(t) { const c = cls(t.cls); return c ? c.color : '#6d28d9'; }
function calChips(ds, max) {
  const evs = st.events.filter((e) => e.d === ds).sort((a, b) => (a.allDay ? -1 : b.allDay ? 1 : a.s - b.s));
  const ts = sorted(st.tasks.filter((t) => t.d === ds));
  const out = [];
  evs.forEach((e) => out.push('<div class="mchip ev" style="background:' + (e.color || '#475569') + ';color:' + onColor(e.color || '#475569') + '" title="' + esc(e.title) + (e.allDay ? '' : ' · ' + tf(e.s)) + '">' + (e.allDay ? '' : '<i>' + tf(e.s).replace(':00', '').replace(' ', '').toLowerCase() + '</i> ') + esc(e.title) + '</div>'));
  ts.forEach((t) => {
    const b = isBlocked(st, t), late = !t.done && ds < todayS;
    out.push('<div class="mchip' + (t.done ? ' done' : '') + (b ? ' blk' : '') + (late ? ' late' : '') + '" style="border-left-color:' + calColor(t) + '"' + C('calTask', t.id, ds) +
      ' title="' + esc(t.t) + (t.inClass ? ' · in class' + tmStr(t) : t.time ? ' · due ' + tf(mn(t.time)) : '') + (b ? ' · can\'t start yet' : '') + '">' + (t.done ? '✓ ' : b ? '🚧 ' : '') + (t.inClass ? '📝 ' : '') + esc(t.t) + '</div>');
  });
  if (out.length > max) return out.slice(0, max - 1).join('') + '<div class="mmore">+' + (out.length - max + 1) + ' more</div>';
  return out.join('');
}
function viewCal() {
  const mode = st.cfg.calMode || 'full', full = mode === 'full';
  const y = cal.getFullYear(), m = cal.getMonth();
  const start = new Date(y, m, 1); start.setDate(1 - start.getDay());
  const last = new Date(y, m + 1, 0); const end = new Date(last); end.setDate(last.getDate() + (6 - last.getDay()));
  let g = DN.map((d) => '<div class="dn">' + (full ? d : d[0]) + '</div>').join('');
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const s = iso(d), other = d.getMonth() !== m;
    const cls0 = (s === todayS ? ' today' : '') + (s === sel ? ' sel' : '') + (other ? ' other' : '');
    if (full) {
      g += '<div class="mcell' + cls0 + '"' + C('selDay', s) + '><div class="mnum">' + d.getDate() + '</div>' + calChips(s, 4) + '</div>';
    } else {
      const open = st.tasks.filter((t) => t.d === s && !t.done), ev = st.events.filter((e) => e.d === s).length;
      const cols = [...new Set(open.map(calColor))].slice(0, 3);
      const late = s < todayS && open.length;
      g += '<button class="day' + cls0 + '"' + C('selDay', s) + '>' + d.getDate() +
        (open.length || ev ? '<span class="dots">' + cols.map((c) => '<i style="background:' + c + '"></i>').join('') + (ev ? '<i class="evd"></i>' : '') + '</span>' : '') +
        (open.length > 1 ? '<b class="cnt' + (late ? ' late' : '') + '">' + open.length + '</b>' : '') + '</button>';
    }
  }
  const dayTasks = sorted(st.tasks.filter((x) => x.d === sel));
  const cl = dayBusy(sel).filter((b) => b.kind === 'class' || b.kind === 'event').map((b) => '<div class="item"><span class="dot" style="background:' + b.color + '"></span><div class="t">' + esc(b.title) + '<div class="s">' + tf(b.s) + ' – ' + tf(b.e) + (b.loc ? ' · ' + esc(b.loc) : '') + '</div></div></div>').join('') +
    allDay(sel).map((e) => '<div class="item"><span class="dot" style="background:' + (e.color || '#475569') + '"></span><div class="t">' + esc(e.title) + '<div class="s">All day</div></div></div>').join('');
  const nav = '<div class="nav"><button' + C('calMove', -1) + '>‹</button><span>' + cal.toLocaleString([], { month: 'long', year: 'numeric' }) +
    ' <span class="seg mini">' + [['dots', '● Compact'], ['full', '☰ Detailed']].map((x) => '<button class="' + (mode === x[0] ? 'on' : '') + '"' + C('calMode', x[0]) + ' title="' + (x[0] === 'dots' ? 'Just show which days have something' : 'Show what is on each day') + '">' + x[1] + '</button>').join('') + '</span></span><button' + C('calMove', 1) + '>›</button></div>';
  const day = '<div class="card" id="calday"><h3>' + new Date(sel + 'T00:00:00').toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }) + '</h3>' + cl + (dayTasks.length ? dayTasks.map(taskRow).join('') : (cl ? '' : '<div class="empty">Nothing this day.</div>')) + '</div>' +
    '<button class="btn"' + C('openDay', sel) + '>Open plan for this day</button>';
  if (full) return nav + '<div class="mgrid">' + g + '</div><div class="cols" style="margin-top:12px"><div>' + day + '</div><div>' + taskForm(true) + '</div></div>';
  return nav + '<div class="cols mcols"><div><div class="grid">' + g + '</div><div class="s" style="margin-top:8px">Dots are class colors; the number is how many tasks are due; grey ring = calendar event.</div></div><div>' + day + taskForm(true) + '</div></div>';
}
ACT.calMode = (m) => { st.cfg.calMode = m; save(); render(); };
ACT.calTask = (id, ds) => {
  sel = ds; editId = id; tab = 'sched'; sv = 'month';
  const d = new Date(ds + 'T00:00:00'); cal = new Date(d.getFullYear(), d.getMonth(), 1);
  render();
  setTimeout(() => { const e = document.querySelector('.editbox'); if (e) e.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 30);
};
function viewSched() {
  const seg = '<div class="seg">' + [['day', 'Day'], ['week', 'Week'], ['month', 'Month']].map((x) => '<button class="' + (sv === x[0] ? 'on' : '') + '"' + C('sv', x[0]) + '>' + x[1] + '</button>').join('') + '</div>';
  return seg + (sv === 'day' ? viewPlan() : sv === 'week' ? viewWeek() : viewCal());
}

function conflictsCard() {
  if (!st.conflicts.length) return '';
  return '<div class="card warn"><h3>📅 Due date changed in Canvas (' + st.conflicts.length + ')</h3><div class="s" style="margin-bottom:6px">You had changed these dates yourself, so I did not overwrite them.</div>' +
    st.conflicts.map((c) => '<div class="item" style="flex-wrap:wrap"><div class="t">' + esc(c.title) + '<div class="s">Yours: ' + (c.yours || 'no date') + ' · Canvas: ' + (c.theirs || 'no date') + '</div></div><div class="conf-row"><button class="pill"' + C('resolve', c.uid, false) + '>Keep mine</button><button class="pill on"' + C('resolve', c.uid, true) + '>Use Canvas date</button></div></div>').join('') + '</div>';
}
function heldCard() {
  if (!st.held.length) return '';
  return '<div class="card"><h3>🔒 Waiting to unlock (' + st.held.length + ')</h3><div class="s" style="margin-bottom:6px">These join your to-do list on the day they unlock.</div>' +
    st.held.slice().sort((a, b) => (a.hold < b.hold ? -1 : 1)).map((h) => '<div class="item"><div class="t">' + esc(h.t) + '<div class="s">' + tag(h) + 'Unlocks ' + h.hold + (h.d ? ' · due ' + h.d : '') + '</div></div></div>').join('') + '</div>';
}
function viewTasks() {
  const l = sorted(st.tasks.filter((x) => filter === 'all' || (filter === 'blocked' ? isBlocked(st, x) : filter === 'active' ? !x.done : filter === 'done' ? x.done : filter === 'canvas' ? (x.src === 'canvas' || x.src === 'syllabus') && !x.done : (!x.done && !x.d))));
  const n = st.tasks.filter((x) => !x.done).length, undated = st.tasks.filter((x) => !x.done && !x.d).length;
  const nb = st.tasks.filter((x) => isBlocked(st, x)).length;
  const L = { all: 'All', active: 'Active', canvas: 'From Canvas', nodate: 'No date' + (undated ? ' (' + undated + ')' : ''), blocked: 'Can\'t start yet' + (nb ? ' (' + nb + ')' : ''), done: 'Done' };
  const pills = '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">' + Object.keys(L).filter((f) => (f !== 'canvas' || st.canvas.host) && (f !== 'blocked' || nb || filter === 'blocked')).map((f) => '<button class="pill' + (filter === f ? ' on' : '') + '"' + C('filter', f) + '>' + L[f] + '</button>').join('') + '</div>';
  const shown = filter === 'done' ? l.slice(0, 60) : l;
  const list = '<div class="card"><h3>' + (filter === 'nodate' ? 'Tasks without a date' : filter === 'blocked' ? 'Can\'t start yet' : n + ' to do') + '</h3>' + (shown.length ? shown.map(taskRow).join('') : '<div class="empty">🎉<br>Nothing here.</div>') + (l.length > shown.length ? '<div class="s">Showing the latest 60.</div>' : '') + '</div>';
  return '<div class="tgrid"><div style="grid-area:a">' + conflictsCard() + taskForm(false) + '</div><div style="grid-area:b">' + suggestCard() + blockedCard() + syncMini() + '</div><div style="grid-area:c">' + pills + list + heldCard() + '</div></div>';
}
/* --- Canvas site permission (the browser can take it away; this gives it back in one click) --- */
let canvasPerm = null;
async function checkCanvasPerm() {
  const h = st.canvas.host;
  let v = true;
  if (h && !bridge.available()) v = 'noext';
  else if (h) { try { v = await ext.permissions.contains({ origins: ['https://' + h + '/*'] }); } catch (e) { v = false; } }
  if (v !== canvasPerm) { canvasPerm = v; softRender(); }
}
try { ext.permissions.onAdded.addListener(checkCanvasPerm); ext.permissions.onRemoved.addListener(checkCanvasPerm); } catch (e) {}
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkCanvasPerm(); });
ACT.allowCanvas = () => {
  const h = st.canvas.host;
  // The companion opens a small window where you allow it.
  ext.permissions.request({ origins: ['https://' + h + '/*'] }).then((ok) => {
    if (!ok) return toast('Not allowed. You can also open Canvas, click the Triaj companion icon and press "Sync from this tab".');
    canvasPerm = true; toast('Access restored ✓ Syncing…'); ACT.syncNow('canvas');
  }).catch(() => toast('The browser could not show the prompt. Try again from this page.'));
};
function permCard() {
  if (canvasPerm === 'noext' && st.canvas.host) return isPhone() ? '' : companionHelp(true);
  if (!st.canvas.host || canvasPerm !== false) return '';
  return '<div class="card warn"><h3>🔑 Canvas access is switched off</h3><div class="s" style="margin-bottom:8px">You\'re signed in to Canvas, but your browser isn\'t letting the Triaj companion read <b>' + esc(st.canvas.host) +
    '</b> right now. That\'s a browser permission, not your login. It usually goes away after the extension is reloaded from a new folder or its site access is changed in the extensions menu.</div>' +
    '<button class="btn"' + C('allowCanvas') + '>Allow access to ' + esc(st.canvas.host) + '</button>' +
    '<div class="s" style="margin-top:8px">No prompt? Open Canvas, click the <b>Triaj</b> companion icon in your browser\'s toolbar, and press <b>Sync from this tab</b>. That works without this permission.</div></div>';
}
function syncMini() {
  if (st.canvas.host && canvasPerm === false) return permCard();
  if (!st.canvas.host) return '<div class="card"><h3>🔄 Canvas sync is off</h3><div class="s" style="margin-bottom:8px">Connect once and new assignments show up here on their own.</div><button class="btn sec"' + C('go', 'sync') + '>Set up Canvas sync</button></div>';
  const s = st.canvas.lastStatus;
  return '<div class="card"><div class="hrow"><h3>🔄 Canvas</h3><button class="btn sm sec"' + C('syncNow', 'all') + (syncBusy || syncState.running ? ' disabled' : '') + '>' + (syncBusy || syncState.running ? 'Syncing…' : 'Sync now') + '</button></div>' + liveStatus(s) + (st.canvas.report ? '<a class="lnk" href="#"' + C('go', 'sync') + '>See what Canvas has vs. your planner →</a>' : '') + '</div>';
}
function suggestCard() {
  const open = st.tasks.filter((t) => !t.done);
  if (!open.length) return '';
  const top = open.filter(workable).map((t) => ({ t, s: score(t) })).sort((a, b) => b.s - a.s).slice(0, 3);
  const nm = new Date().getHours() * 60 + new Date().getMinutes(), d = new Date(); d.setHours(0, 0, 0, 0);
  let cap = 0;
  for (let i = 0; i < 7; i++) {
    const ds = iso(d), f = freeSlots(ds, ds === todayS ? nm : 0).reduce((a, x) => a + x[1] - x[0], 0);
    cap += Math.min(f, dayCfg(ds).cap * 60); d.setDate(d.getDate() + 1);
  }
  const lim = new Date(); lim.setDate(lim.getDate() + 7); const ls = iso(lim);
  const due = open.filter((t) => t.d && t.d <= ls).sort((a, b) => (a.d < b.d ? -1 : 1)); // in-class items count 0 study time
  const needM = due.reduce((a, t) => a + remaining(t), 0);
  const pct = cap ? Math.min(100, Math.round(needM / cap * 100)) : (needM ? 100 : 0);
  const msg = !needM ? 'Nothing due in the next 7 days.' : needM > cap ? 'Overloaded: about ' + dur(needM) + ' of work due, but only about ' + dur(cap) + ' of study time. Start the top picks today, or ask the AI tab to help trim.' : needM > cap * 0.75 ? 'Tight but doable: ' + dur(needM) + ' of work due. Try not to skip study blocks.' : 'On track: ' + dur(needM) + ' of work due in the next 7 days.';
  const col = needM > cap ? 'var(--bad)' : needM > cap * 0.75 ? '#e6a100' : 'var(--ok)';
  return '<div class="card"><h3>🎯 Top picks' + (open.length > 6 ? ' (just do these first)' : '') + '</h3>' + top.map((x, i) =>
    '<div class="item"><div style="font-weight:700;color:var(--pri);width:18px">' + (i + 1) + '</div><div class="t">' + esc(x.t.t) + '<div class="s">' + tag(x.t) + reason(x.t) + ' · ~' + dur(remaining(x.t) || need(x.t)) + '</div></div><button class="x" title="Focus on this"' + C('fStart', x.t.id) + '>▶</button></div>').join('') +
    (open.length > 3 ? '<div class="s" style="margin-top:6px">Ignore the other ' + (open.length - 3) + ' for now.</div>' : '') + '</div>' +
    '<div class="card"><h3>📡 Next 7 days</h3><div class="bar"><span style="width:' + pct + '%;background:' + col + '"></span></div><div class="s">' + msg + '</div>' +
    (due.length ? '<div style="margin-top:8px">' + due.slice(0, 5).map((t) => { const dd = new Date(t.d + 'T00:00:00'); return '<div class="s">' + (t.d < todayS ? 'Overdue' : DN[dd.getDay()] + ' ' + dd.getDate()) + ' · ' + esc(t.t) + '</div>'; }).join('') + '</div>' : '') + '</div>';
}

/* ---------- focus ---------- */
function tLeft() { return timer.status === 'running' ? Math.max(0, Math.round((timer.endAt - Date.now()) / 1000)) : (timer.left || 0); }
function taskName(id) { const t = st.tasks.find((x) => x.id === id); return t ? t.t : ''; }
function focusTotals() {
  const by = {};
  st.focus.forEach((e) => { if (!by[e.d]) by[e.d] = { m: 0, x: 0, n: 0 }; by[e.d].m += e.m || 0; by[e.d].x += e.x || 0; if (e.m) by[e.d].n++; });
  return by;
}
function streak(by) {
  let sk = 0; const d = new Date();
  const f = (ds) => (by[ds] ? by[ds].m : 0);
  if (f(iso(d)) < 25) d.setDate(d.getDate() - 1);
  while (f(iso(d)) >= 25 && sk < 365) { sk++; d.setDate(d.getDate() - 1); }
  return sk;
}
function timerCard(big) {
  const p = preset(timer.presetId), ph = timer.phase || 'work', brk = ph !== 'work', idle = timer.status === 'idle';
  const left = idle ? p.work * 60 : tLeft(), total = idle ? p.work * 60 : (timer.total || 1);
  const size = big ? 240 : 180, r = size / 2 - 12, c = 2 * Math.PI * r;
  const roundsDone = (timer.round || 0) % Math.max(1, p.rounds);
  const dots = '<div class="fdots">' + Array.from({ length: p.rounds }, (_, i) => '<i class="' + (i < roundsDone || (roundsDone === 0 && timer.round > 0 && ph === 'long') ? 'on' : '') + '"></i>').join('') + '</div>';
  const tid = timer.status === 'idle' ? focusTid : timer.tid;
  const head = idle ? 'Ready to focus' : timer.status === 'ready' ? 'Up next: ' + LABEL[ph] : timer.status === 'paused' ? 'Paused · ' + LABEL[ph] : LABEL[ph];
  const sub = brk ? 'Stand up, stretch, drink water, look away from screens.' : (taskName(tid) || 'No task picked: just focus');
  let btns;
  if (idle) btns = '<button class="btn"' + C('fStart', tid) + '>▶ Start ' + p.work + ' min focus</button>';
  else if (timer.status === 'ready') btns = '<div class="btnrow"><button class="btn"' + C('fOp', 'start') + '>▶ Start ' + LABEL[ph].toLowerCase() + '</button><button class="btn mute"' + C('fOp', 'stop') + '>Done for now</button></div>' + (brk ? '' : '') ;
  else btns = '<div class="btnrow">' + (timer.status === 'running' ? '<button class="btn"' + C('fOp', 'pause') + '>❚❚ Pause</button>' : '<button class="btn"' + C('fOp', 'resume') + '>▶ Resume</button>') +
    '<button class="btn sec"' + C('fOp', 'skip') + '>' + (brk ? 'Skip break' : 'Finish round') + '</button></div><div class="btnrow" style="margin-top:8px"><button class="btn sec"' + C('fOp', 'add', { minutes: 5 }) + '>+5 min</button>' +
    (brk ? '' : '<button class="btn sec"' + C('fOp', 'distracted') + '>I got distracted</button>') + '<button class="btn mute"' + C('fOp', 'stop') + '>Stop</button></div>';
  const dmsg = !brk && timer.distractions ? '<div class="s" style="margin:6px 0">Distractions noticed this round: ' + timer.distractions + '. Noticing is the skill. Back to it.</div>' : '';
  const task = st.tasks.find((x) => x.id === tid);
  return '<div class="card fwrap"><span class="fphase' + (brk ? ' brk' : '') + '">' + esc(head) + '</span><div style="font-weight:700;margin:8px 0 2px">' + esc(sub) + '</div>' +
    '<div class="ringw" style="width:' + size + 'px;height:' + size + 'px;margin:10px auto"><svg width="' + size + '" height="' + size + '"><circle cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" fill="none" stroke="var(--soft)" stroke-width="12"/><circle id="fring" data-c="' + c + '" cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" fill="none" stroke="' + (brk ? '#16a34a' : 'var(--pri)') + '" stroke-width="12" stroke-linecap="round" stroke-dasharray="' + c + '" stroke-dashoffset="' + (c * (1 - left / total)) + '"/></svg><div><div id="ftime" class="ftime' + (brk ? ' brk' : '') + '" style="font-size:' + (big ? 60 : 44) + 'px">' + fmtT(left) + '</div><div class="s">' + esc(p.name) + '</div></div></div>' +
    dots + dmsg + btns +
    (task && !task.done && !brk && !idle ? '<button class="btn ghost" style="margin-top:8px"' + C('complete', task.id) + '>✓ Mark task done</button>' : '') + '</div>';
}
/* --- blocking distracting sites during focus (done by the companion) --- */
const BLOCK_SUGGEST = ['youtube.com', 'instagram.com', 'tiktok.com', 'reddit.com', 'x.com', 'facebook.com', 'netflix.com', 'twitch.tv', 'discord.com'];
function blockCfg() { return Object.assign({ on: false, sites: BLOCK_SUGGEST.slice(0, 5) }, st.cfg.focusBlock || {}); }
function blockCard() {
  const b = blockCfg(), has = bridge.available();
  const chk = '<div class="check"><input type="checkbox" id="fb_on"' + (b.on ? ' checked' : '') + (has ? '' : ' disabled') + CH('fbOn') + '><label for="fb_on">Block these sites while a focus round runs</label></div>';
  const list = '<textarea id="fb_sites" rows="4" spellcheck="false" placeholder="youtube.com"' + CH('fbSites') + '>' + esc(b.sites.join('\n')) + '</textarea>';
  const add = BLOCK_SUGGEST.filter((x) => b.sites.indexOf(x) < 0).map((x) => '<button class="pill"' + C('fbAdd', x) + '>+ ' + esc(x) + '</button>').join('');
  return '<div class="card"><h3>Block distractions</h3>' +
    (has ? '<div class="s" style="margin-bottom:8px">During focus, these open a short "back to focus" page instead. Breaks are free. One site per line.</div>'
      : '<div class="stbox warn" style="margin:0 0 10px"><b>Needs the Triaj companion</b><div class="s">Blocking is done by the browser extension on your computer. ' + (isPhone() ? 'Phones can\'t run it.' : '<a class="lnk" href="../#companion" target="_blank" rel="noopener">Add the companion</a>, then reload.') + '</div></div>') +
    chk + list + (add ? '<div class="conf-row" style="margin-bottom:10px">' + add + '</div>' : '') +
    (has ? '<button class="btn sm sec"' + C('fbPerm') + '>Show a friendly page instead of an error</button><div class="s" style="margin-top:6px">Optional. Lets the companion swap blocked tabs for a page with your timer.</div>' : '') + '</div>';
}
function fbSave(o) { st.cfg.focusBlock = Object.assign(blockCfg(), o); save(); }
ACT.fbOn = () => { fbSave({ on: EL.checked }); toast(EL.checked ? 'Blocking during focus is on' : 'Blocking is off'); };
ACT.fbSites = () => { fbSave({ sites: EL.value.split(/[\s,]+/).map((x) => x.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').replace(/[/:?#].*$/, '')).filter((x) => x.indexOf('.') > 0) }); };
ACT.fbAdd = (x) => { const b = blockCfg(); if (b.sites.indexOf(x) < 0) b.sites.push(x); fbSave({ sites: b.sites }); render(); };
ACT.fbPerm = async () => { await new Promise((r) => setTimeout(r, 1200)); const r = await send({ cmd: 'blockPerm' }); toast(r && r.ok ? 'Done. Blocked sites now show your timer' : 'Not allowed. Blocked sites will show the browser\'s error page'); };
bridge.on('setBlock', (d) => { if (d) { fbSave({ on: !!d.on }); render(); } });
bridge.on('go', (d) => { if (d && d.hash) ACT.go(d.hash); });

function viewFocus() {
  const t = T(), open = sorted(st.tasks.filter((x) => !x.done && !x.inClass));
  if (!focusTid && open[0]) { const ok = open.filter(workable); focusTid = (ok.length ? ok : open).slice().sort((a, b) => score(b) - score(a))[0].id; }
  const curTid = timer.status === 'idle' ? focusTid : timer.tid;
  const presets = '<div class="presets">' + t.presets.map((p) => '<button class="pill' + (t.presetId === p.id ? ' on' : '') + '"' + C('fPreset', p.id) + '>' + esc(p.name) + ' · ' + p.work + '/' + p.short + '</button>').join('') + '<button class="pill"' + C('presetEdit') + '>' + (presetEdit ? 'Done editing' : '✎ Edit') + '</button></div>';
  const taskSel = '<span class="lbl">Working on</span><select id="ftask"' + CH('fTask') + '><option value="0">Just focus (no task)</option>' + open.map((x) => '<option value="' + x.id + '"' + (x.id === curTid ? ' selected' : '') + '>' + (isBlocked(st, x) ? '🚧 ' : '') + esc(x.t) + (x.d ? ' · due ' + x.d : '') + '</option>').join('') + '</select>';
  const quick = '<div class="row"><input type="number" id="fcustom" min="1" max="240" placeholder="Custom minutes" style="margin:0"' + EN('fStartSel') + '><button class="btn sec" style="flex:none;width:auto;padding:10px 14px;margin:0"' + C('fStartSel') + '>Start custom</button></div>' +
    '<div class="btnrow" style="margin-top:8px"><button class="btn sec"' + C('fStart', undefined, 5) + '>Just 5 min</button><button class="btn sec"' + C('fStart', 0, 0, 'short') + '>Break now</button></div>';
  const editor = presetEdit ? '<div class="card"><h3>Your timers</h3><div class="pgrid ph"><span>Name</span><span>Focus</span><span>Short</span><span>Long</span><span>Rounds</span><span></span></div>' +
    t.presets.map((p, i) => '<div class="pgrid"><input value="' + esc(p.name) + '"' + CH('pSet', i, 'name') + '>' + ['work', 'short', 'long', 'rounds'].map((k) => '<input type="number" min="1" max="240" value="' + p[k] + '"' + CH('pSet', i, k) + '>').join('') + '<button class="x"' + C('pDel', i) + '>×</button></div>').join('') +
    '<div class="s" style="margin:6px 0">Minutes for focus and breaks. A long break comes after every set of rounds.</div><div class="btnrow"><button class="btn sec"' + C('pAdd') + '>＋ New timer</button><button class="btn mute"' + C('pReset') + '>Restore defaults</button></div></div>' : '';
  const sndSel = (key, label) => '<span class="lbl">' + label + '</span><div class="sndrow"><select' + CH('tSet', key) + '>' + Object.keys(SOUNDS).map((k) => '<option value="' + k + '"' + (t[key] === k ? ' selected' : '') + '>' + SOUNDS[k] + '</option>').join('') + '</select><button class="btn sm sec"' + C('preview', key) + '>▶</button></div>';
  const chk = (key, label) => '<div class="check"><input type="checkbox" id="t_' + key + '"' + (t[key] ? ' checked' : '') + CH('tSet', key) + '><label for="t_' + key + '">' + label + '</label></div>';
  const sounds = '<div class="card"><h3>🔔 Sounds & nudges</h3>' + sndSel('endSound', 'When focus ends') + sndSel('breakSound', 'When a break ends') +
    '<span class="lbl">Refocus nudge during focus</span><div class="row"><select' + CH('tSet', 'refocus') + '>' + [[0, 'Off'], [5, 'Every 5 min'], [10, 'Every 10 min'], [15, 'Every 15 min'], [20, 'Every 20 min']].map((o) => '<option value="' + o[0] + '"' + (+t.refocus === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select></div>' +
    sndSel('refocusSound', 'Nudge sound') + chk('refocusNotify', 'Also show a "still with it?" pop-up') +
    '<span class="lbl">Volume</span><input type="range" min="0" max="1" step="0.05" value="' + t.volume + '"' + CH('tSet', 'volume') + '>' +
    '<span class="lbl">Background noise while focusing</span><div class="sndrow"><select' + CH('tSet', 'ambient') + '>' + Object.keys(AMBIENT).map((k) => '<option value="' + k + '"' + (t.ambient === k ? ' selected' : '') + '>' + AMBIENT[k] + '</option>').join('') + '</select><button class="btn sm sec"' + C('previewAmb') + '>▶</button></div>' +
    '<span class="lbl">Noise volume</span><input type="range" min="0.02" max="0.8" step="0.02" value="' + t.ambientVol + '"' + CH('tSet', 'ambientVol') + '>' +
    chk('autoBreak', 'Start breaks automatically') + chk('autoWork', 'Start the next focus round automatically after a break') + chk('notify', 'Desktop notifications') + chk('badge', 'Show minutes left on the toolbar icon') +
    '<div class="s" style="margin-top:6px">The timer keeps running when this tab is closed. Shortcut: <code>Alt+Shift+F</code> starts or pauses it.</div></div>';
  return '<div class="cols"><div>' + timerCard(true) + '<div class="card">' + presets + taskSel + quick + '</div>' + editor + '</div><div>' + statsCard(true) + blockCard() + sounds + '</div></div>';
}
function statsCard(full) {
  const by = focusTotals(), td = by[todayS] || { m: 0, x: 0, n: 0 };
  const goal = st.cfg.goal || 90, pct = Math.min(100, Math.round(td.m / goal * 100));
  const done = st.tasks.filter((t) => t.doneAt === todayS).length, sk = streak(by);
  let week = '';
  if (full) {
    const days = []; const d = new Date(); d.setDate(d.getDate() - 6);
    for (let i = 0; i < 7; i++) { days.push(iso(d)); d.setDate(d.getDate() + 1); }
    const mx = Math.max(goal, ...days.map((ds) => (by[ds] ? by[ds].m : 0)));
    const tot = days.reduce((a, ds) => a + (by[ds] ? by[ds].m : 0), 0);
    week = '<h3 style="margin-top:14px">Last 7 days · ' + dur(tot) + '</h3><div class="wk">' + days.map((ds) => { const m = by[ds] ? by[ds].m : 0; return '<div class="' + (ds === todayS ? 'today' : '') + '"><b>' + (m ? m : '') + '</b><span class="b" style="height:' + Math.round(m / mx * 90) + '%"></span>' + DN[new Date(ds + 'T00:00:00').getDay()] + '</div>'; }).join('') + '</div>';
    const byT = {};
    st.focus.forEach((e) => { if (e.m && e.tid && e.d >= days[0]) byT[e.tid] = (byT[e.tid] || 0) + e.m; });
    const tops = Object.keys(byT).sort((a, b) => byT[b] - byT[a]).slice(0, 4).filter((id) => taskName(+id));
    if (tops.length) week += '<div class="s" style="margin-top:8px">Most focus this week: ' + tops.map((id) => esc(taskName(+id)) + ' (' + dur(byT[id]) + ')').join(', ') + '</div>';
  }
  return '<div class="card"><h3>Today</h3><div style="display:flex;align-items:center;gap:16px;margin-bottom:12px">' + ring(pct, 72, 8) + '<div class="s">Focus goal<br><b style="font-size:18px;color:var(--ink)">' + td.m + ' / ' + goal + ' min' + (pct >= 100 ? ' 🎯' : '') + '</b></div></div>' +
    '<div class="sum" style="margin:0"><div>Sessions<b>' + td.n + '</b></div><div>Tasks done<b>' + done + '</b></div><div>Streak<b>🔥 ' + sk + '</b></div></div>' +
    (td.x ? '<div class="s" style="margin-top:8px">Distractions noticed: ' + td.x + '. Noticing is the skill.</div>' : '') + week + '</div>';
}

/* ---------- now ---------- */
function altPanel(curId) {
  if (!showAlt) return '';
  const alts = st.tasks.filter((t) => workable(t) && t.id !== curId).map((t) => ({ t, s: score(t) })).sort((a, b) => b.s - a.s).slice(0, 6);
  return '<div class="card" style="background:var(--soft);margin:10px 0 0;box-shadow:none"><div class="s" style="margin-bottom:6px">Most urgent first. Tap one to switch to it.</div>' +
    (alts.length ? alts.map((a) => '<div class="item" style="cursor:pointer"' + C('useTask', a.t.id) + '><div class="t">' + esc(a.t.t) + '<div class="s">' + tag(a.t) + reason(a.t) + ' · ~' + dur(remaining(a.t) || need(a.t)) + '</div></div><span class="chip" style="background:var(--pri);color:var(--onpri)">Switch</span></div>').join('') : '<div class="s">No other tasks yet.</div>') +
    '<div class="s" style="margin:10px 0 4px">Or something new:</div><div class="row"><input id="alt" placeholder="e.g. Read chapter 4" style="margin:0"' + EN('addUse') + '><button class="btn" style="flex:none;width:auto;padding:10px 16px"' + C('addUse') + '>Add and use</button></div>' +
    (recOverride ? '<button class="pill" style="margin-top:10px"' + C('backToRec') + '>Back to the suggestion</button>' : '') + '</div>';
}
function welcomeCard() {
  if (!st.tasks.length && !st.classes.length && !st.routines.length) return restoreCard(true);
  if (st.cfg.welcomed || (st.tasks.length && st.canvas.host)) return '';
  return '<div class="card welcome"><div class="hrow"><h3>👋 Welcome to Triaj</h3><button class="x"' + C('dismissWelcome') + '>×</button></div><ol>' +
    '<li><b>Bring your old data:</b> from the My Planner extension, More → Backups → Back up now (from the Claude artifact, AI tab → Download backup). Then here: More → Backups → Restore.</li>' +
    (session.user ? '' : '<li><b>Sign in</b> (top right) to keep your planner in your account and open it on any device.</li>') +
    '<li><b>Connect Canvas</b> once under <a class="lnk" href="#"' + C('go', 'sync') + '>More → Sync</a> (on a computer, with the Triaj companion extension). It then syncs on its own.</li>' +
    '<li><b>On your phone</b>, open Triaj and choose <b>Add to Home Screen</b> so it opens like an app.</li>' +
    '<li><b>Turn on AI</b> (optional, free): <a class="lnk" href="#"' + C('go', 'ai') + '>AI tab → Get started with AI</a>.</li></ol></div>';
}
function viewNow() {
  const n = new Date(), nm = n.getHours() * 60 + n.getMinutes(), h = n.getHours();
  const greet = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const busy = dayBusy(todayS), cur = busy.find((b) => b.s <= nm && nm < b.e), nxt = busy.find((b) => b.s > nm);
  const dayEnd = mn(dayCfg(todayS).de);
  let gap = 0, head, sub, verdict = '';
  if (cur) { head = (cur.kind === 'class' ? 'In class: ' : cur.kind === 'routine' ? 'Now: ' : 'Busy: ') + cur.title; sub = 'Ends at ' + tf(cur.e); }
  else if (nm >= dayEnd) { head = 'Day wrapped up 🌙'; sub = 'Rest up. Tomorrow is planned in the Schedule tab.'; }
  else { gap = (nxt ? nxt.s : dayEnd) - nm; head = 'Free for ' + dur(gap); sub = nxt ? 'Until ' + tf(nxt.s) + ' · ' + nxt.title : 'Nothing else scheduled today'; }
  if (gap) verdict = gap < 25 ? 'Short gap. Good for a snack, a stretch, or a quick win.' : gap <= 60 ? 'Enough time for one focus round.' : 'Plenty of time: a couple of focus rounds with breaks.';
  const focusOn = timer.status !== 'idle';
  const P = autoPlan(todayS), plan = (P.out[todayS] || []).filter((i) => i.e > nm);
  let rec = plan[0] ? plan[0].t : sorted(st.tasks.filter(workable))[0];
  if (recOverride) { const ov = st.tasks.find((t) => t.id === recOverride && !t.done); if (ov) rec = ov; }
  const pw = preset().work, fm = gap ? Math.min(pw, Math.max(5, gap - 5)) : pw;
  let recHtml = '';
  if (focusOn) recHtml = timerCard(false);
  else if (rec) {
    const qw = st.tasks.filter((t) => workable(t) && t.id !== rec.id && remaining(t) > 0 && remaining(t) <= 30).sort((a, b) => remaining(a) - remaining(b))[0];
    recHtml = '<div class="card"><div class="s">' + (cur ? 'Up next after this' : 'Do this next') + '</div><div style="font-size:18px;font-weight:700;margin:4px 0">' + esc(rec.t) + '</div><div class="s">' + tag(rec) + (rec.d ? 'due ' + rec.d + ' · ' : '') + 'about ' + dur(remaining(rec) || need(rec)) + ' left' + (rec.url ? ' · <a class="lnk" href="' + esc(rec.url) + '" target="_blank" rel="noopener">Open in Canvas ↗</a>' : '') + (canvasRef(rec) ? ' · <a class="lnk" href="#"' + C('getFiles', rec.id) + '>📎 Get files</a>' : '') + '</div>' +
      '<button class="btn" style="margin-top:10px"' + C('fStart', rec.id, fm === pw ? 0 : fm) + '>▶ Start ' + fm + ' min focus</button>' +
      '<button class="btn sec" style="margin-top:8px"' + C('fStart', rec.id, 5) + '>Just 5 minutes</button>' +
      '<button class="btn ghost" style="margin-top:8px"' + C('breakDown', rec.id) + '>I\'m stuck / don\'t know where to start</button>' +
      '<button class="btn ghost" style="margin-top:8px"' + C('cantNow', rec.id) + '>🚧 Can\'t do this one yet</button>' +
      '<button class="btn ghost" style="margin-top:8px"' + C('toggleAlt') + '>' + (showAlt ? 'Hide options' : '↻ Want to work on something else?') + '</button>' + altPanel(rec.id) +
      (stuck && stuck.tid === rec.id ? '<div class="card" style="background:var(--soft);margin:8px 0 0">' + esc(stuck.text).replace(/\n/g, '<br>') + '</div>' : '') +
      (qw ? '<div class="s" style="margin-top:8px">Quick win: <b>' + esc(qw.t) + '</b> (~' + dur(remaining(qw)) + ')</div>' : '') + '</div>';
  } else recHtml = '<div class="card empty">Nothing to do right now. Add a task below, or enjoy the free time.</div>';
  const rest = busy.filter((b) => b.e > nm).concat(plan).sort((a, b) => a.s - b.s).slice(0, 6).map((i) =>
    '<div class="blk" style="border-left:5px solid ' + i.color + '"><div class="tm">' + tf(i.s) + '<br>' + tf(i.e) + '</div><div class="t">' + esc(i.title) + '<div class="s">' + ({ class: 'Class', work: 'Suggested study time', routine: 'Routine', event: 'Calendar', block: 'Your block' })[i.kind] + '</div></div></div>').join('');
  return welcomeCard() + permCard() + backupBanner() + conflictsCard() + '<div class="cols"><div><div class="card hero"><div class="s">' + greet + ' · ' + tf(nm) + '</div><div style="font-size:22px;font-weight:700;margin:4px 0">' + esc(head) + '</div><div class="s">' + esc(sub) + '</div>' + (verdict ? '<div style="margin-top:8px">' + verdict + '</div>' : '') + '</div>' +
    recHtml + '</div><div>' + suggestCard() + blockedCard() + statsCard(false) +
    '<h3>Rest of today</h3>' + (rest || '<div class="empty">Nothing else scheduled.</div>') +
    '<button class="pill" style="margin:4px 0 12px"' + C('openWeek') + '>See the full week →</button>' +
    '<div class="card"><div class="row"><input id="qa" placeholder="Quick add a task..." style="margin:0"' + EN('quickAdd') + '><button class="btn" style="flex:none;width:auto;padding:10px 18px"' + C('quickAdd') + '>Add</button></div></div></div></div>';
}
ACT.openWeek = () => { tab = 'sched'; sv = 'week'; render(); };

/* ---------- budget, classes, more ---------- */
function viewBudget() {
  const key = bm.getFullYear() + '-' + String(bm.getMonth() + 1).padStart(2, '0');
  const l = st.tx.filter((x) => x.d.slice(0, 7) === key).sort((a, b) => (a.d < b.d ? 1 : -1));
  let inc = 0, out = 0; const by = {};
  l.forEach((x) => { if (x.type === 'in') inc += x.a; else { out += x.a; by[x.c] = (by[x.c] || 0) + x.a; } });
  const f = (n) => '$' + n.toFixed(2);
  const bars = Object.keys(by).sort((a, b) => by[b] - by[a]).map((c) => { const p = out ? by[c] / out * 100 : 0; return '<div style="display:flex;justify-content:space-between;font-size:13px"><span>' + esc(c) + '</span><span>' + f(by[c]) + '</span></div><div class="bar"><span style="width:' + p.toFixed(0) + '%"></span></div>'; }).join('');
  const rows = l.map((x) => '<div class="item"><div class="t">' + esc(x.n) + '<div class="s">' + x.d + ' · ' + esc(x.c) + '</div></div><b class="' + (x.type === 'in' ? 'in' : 'out') + '">' + (x.type === 'in' ? '+' : '-') + f(x.a) + '</b><button class="x"' + C('delTx', x.id) + '>×</button></div>').join('');
  return '<div class="nav"><button' + C('bmMove', -1) + '>‹</button>' + bm.toLocaleString([], { month: 'long', year: 'numeric' }) + '<button' + C('bmMove', 1) + '>›</button></div>' +
    '<div class="sum"><div>Income<b class="in">' + f(inc) + '</b></div><div>Spent<b class="out">' + f(out) + '</b></div><div>Balance<b>' + f(inc - out) + '</b></div></div>' +
    '<div class="cols"><div><div class="card"><div class="row"><select id="tt"' + CH('txType') + '><option value="out">Expense</option><option value="in">Income</option></select><input id="ta" type="number" step="0.01" min="0" placeholder="Amount"></div>' +
    '<input id="tn" placeholder="Description"' + EN('addTx') + '><div class="row"><select id="tc">' + CATS.map((c) => '<option>' + c + '</option>').join('') + '</select><input type="date" id="td" value="' + todayS + '"></div><button class="btn"' + C('addTx') + '>Add</button></div>' +
    '<div class="card"><h3>Spending by category</h3>' + (bars || '<div class="empty">No expenses this month.</div>') + '</div></div><div><div class="card"><h3>Transactions</h3>' + (rows || '<div class="empty">Nothing yet.</div>') + '</div></div></div>';
}
function viewClasses() {
  const list = st.classes.map((c) => {
    const sl = c.slots.map((s, i) => '<span class="pill" style="margin:2px;display:inline-block">' + DN[s.day] + ' ' + tf(mn(s.s)) + '–' + tf(mn(s.e)) + (s.loc ? ' · ' + esc(s.loc) : '') + ' <span' + C('delSlot', c.id, i) + ' style="cursor:pointer">×</span></span>').join('');
    return '<div class="card" style="border-left:5px solid ' + c.color + '"><div class="hrow"><input value="' + esc(c.n) + '" style="margin:0;font-weight:700;max-width:260px"' + CH('renameClass', c.id) + '><input type="color" value="' + c.color + '" style="width:48px;flex:none;margin:0"' + CH('recolor', c.id) + '><button class="x"' + C('delClass', c.id) + '>Delete</button></div>' + (c.canvasId ? '<div class="s" style="margin:4px 0">Linked to Canvas</div>' : '') + (sl || '<div class="s" style="margin-top:4px">No meeting times yet. Add them below so study time is planned around class.</div>') + '</div>';
  }).join('');
  const dc = DN.map((d, i) => '<label><input type="checkbox" class="dchk" value="' + i + '">' + d[0] + '<br>' + d.slice(1) + '</label>').join('');
  return '<div class="cols"><div>' + (list || '<div class="empty">No classes yet. Add your first one, or connect Canvas and they appear on their own.</div>') + '</div><div>' +
    '<div class="card"><h3>Add a class or more times</h3><input id="cn" placeholder="Class name (e.g. APSC 179)" list="clist"><datalist id="clist">' + st.classes.map((c) => '<option value="' + esc(c.n) + '">').join('') + '</datalist>' +
    '<div class="days">' + dc + '</div><div class="row"><input type="time" id="c1"><input type="time" id="c2"></div>' +
    '<div class="row"><input id="cl" placeholder="Room (optional)"><input type="color" id="cc1" value="' + PAL[st.classes.length % PAL.length] + '"></div>' +
    '<button class="btn"' + C('addClass') + '>Add class</button><div id="cmsg" class="s" style="color:var(--bad);margin-top:6px"></div>' +
    '<div class="s" style="margin-top:6px">Use the same name again to add another time (like a lab on another day).</div></div></div></div>';
}
function viewMore() {
  const cvs = st.canvas.host ? (st.canvas.lastStatus && st.canvas.lastStatus.kind === 'err' ? '⚠ needs attention' : 'synced ' + ago(st.canvas.lastSync)) : 'not connected';
  const items = [['ai', '✨', 'AI setup', aiReady() ? aiName() + ' connected.' : 'Get started with AI: free with a Gemini key, about 3 minutes.'], ['backup', '🛟', 'Backups', bk.perm ? 'Daily backup file ' + (bk.state && bk.state.lastAt ? 'saved ' + ago(bk.state.lastAt) : 'on') + '. Restore or undo.' : 'Off: turn on so updates can never wipe your data.'], ['export', '📋', 'Export for AI', 'Copy all tasks, schedule and classes as short text for any AI.'], ['files', '📚', 'Files', 'Download course files and project resources into folders.'], ['sync', '🔄', 'Sync', 'Canvas (' + cvs + ') and calendar feeds.'], ['import', '📥', 'Import', 'One-off: .ics files, syllabus or outline text.'], ['classes', '🎓', 'Classes', 'Class meeting times and colors.'], ['budget', '💰', 'Budget', 'Income, spending and categories.'], ['settings', '🎨', 'Settings', 'Theme, pace, daily limits, routine, reminders.']];
  const inst = installable() ? '<button class="mrow inst"' + C('install') + '><b>Install Triaj</b><span class="s">Open it from your home screen or dock like an app.</span></button>' : '';
  return '<div class="mlist">' + inst + items.map((i) => '<button class="mrow"' + C('go', i[0]) + '><b>' + i[2] + '</b><span class="s">' + esc(i[3]) + '</span></button>').join('') + '</div>';
}


/* ---------- files: find and download Canvas resources ---------- */
const FT = { pdf: ['📄', 'PDFs'], slides: ['📊', 'Slides'], doc: ['📝', 'Docs'], data: ['🗂', 'Code & data'], image: ['🖼', 'Images'], media: ['🎞', 'Video & audio'], other: ['📎', 'Other'] };
function canvasRef(t) {
  const m = String((t && t.url) || '').match(/\/courses\/(\d+)\/(assignments|quizzes|discussion_topics|pages)\/([^/?#]+)/);
  return m ? { cid: m[1], kind: m[2], id: decodeURIComponent(m[3]) } : null;
}
function api() { return makeApi('https://' + st.canvas.host, st.canvas.token, bridge.fetch); }
function courseCode(cid) { const c = (st.canvas.courses || []).find((x) => x.id === String(cid)); return c ? c.code : 'Course ' + cid; }
function fmtSize(b) { return !b ? '' : b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }
function dlState(f) {
  const d = dlog[f.id];
  if (!d) return '';
  if (f.updated && d.u && f.updated > d.u) return '<span class="chip warn" title="The teacher replaced this file after you downloaded it">updated since you downloaded</span>';
  return '<span class="chip" title="Saved to ' + esc(d.p) + '">✓ downloaded</span>';
}
function fileRow(f, checked, act, extra) {
  const ok = !f.locked && !f.missing;
  return '<label class="item frow' + (ok ? '' : ' dim') + '"><input type="checkbox" style="width:auto;margin:0"' + (checked ? ' checked' : '') + (ok ? '' : ' disabled') + CH(act, f.id) + '>' +
    '<span class="fic">' + (FT[f.type] || FT.other)[0] + '</span><div class="t">' + esc(f.name) + '<div class="s">' + (fmtSize(f.size) ? fmtSize(f.size) + ' · ' : '') + esc(f.from || '') +
    (f.locked ? ' <span class="chip lock">🔒 locked</span>' : '') + (f.missing ? ' <span class="chip bad">not available to you</span>' : '') + ' ' + dlState(f) + (extra || '') + '</div></div>' +
    (f.page ? '<a class="lnk" href="' + esc(f.page) + '" target="_blank" rel="noopener" title="Open in Canvas">↗</a>' : '') + '</label>';
}
function needDownloads() {
  // The companion shows its permission prompt in a small window.
  return ext.permissions.request({ permissions: ['downloads'] }).catch(() => false);
}
async function saveFiles(list, folder, extras) {
  const used = {};
  const items = list.map((f) => {
    const sub = f.sub ? cleanName(f.sub) + '/' : '';
    let name = cleanName(f.name, 120);
    const key = (sub + name).toLowerCase();
    if (used[key]) name = name.replace(/(\.[^.]+)?$/, ' (' + f.id + ')$1');
    used[key] = 1;
    return { url: f.url, path: folder + '/' + sub + name, key: f.id, updated: f.updated };
  }).concat(extras || []);
  const res = await downloadAll(items, (n, tot) => { const msg = 'Downloading ' + n + ' of ' + tot + '…'; if (proj && proj.busy) proj.dprog = msg; else fx.dprog = msg; render(); });
  res.ok.forEach((it) => { if (it.key && !String(it.key).startsWith('x:')) dlog[it.key] = { u: it.updated || '', p: it.path, at: new Date().toISOString() }; });
  await ext.storage.local.set({ dlog });
  return { ok: res.ok.length, failed: res.failed, folder, firstId: res.ok.length ? res.ok[0].id : null };
}
function resultBox(r) {
  if (!r) return '';
  return '<div class="stbox ' + (r.failed.length ? (r.ok ? 'warn' : 'err') : 'ok') + '" style="margin-top:10px"><b>' + (r.failed.length ? (r.ok ? '⚠️ ' : '❌ ') : '✅ ') + 'Saved ' + r.ok + ' file' + (r.ok === 1 ? '' : 's') + ' to Downloads/' + esc(r.folder) + '</b>' +
    (r.failed.length ? '<div class="s" style="margin-top:4px">' + r.failed.length + ' failed: ' + r.failed.slice(0, 6).map((x) => esc(x.path.split('/').pop()) + ' (' + esc(x.err) + ')').join(', ') + '</div>' : '') +
    (r.firstId ? '<div class="btnrow" style="margin-top:8px"><button class="btn sm sec"' + C('showDl', r.firstId) + '>Show in folder</button></div>' : '') + '</div>';
}
ACT.showDl = (id) => { try { ext.downloads.show(id); } catch (e) {} };

/* project bundle */
ACT.getFiles = async (taskId) => {
  const t = st.tasks.find((x) => x.id === taskId), ref = canvasRef(t);
  if (!ref) return toast('This task is not linked to a Canvas item');
  proj = { taskId, cid: ref.cid, kind: ref.kind, id: ref.id, title: t.t, course: courseCode(ref.cid), loading: true, prog: 'Starting…', data: null, err: '', sel: new Set(), saveInstr: true, busy: false, result: null };
  tab = 'files'; render(); window.scrollTo(0, 0);
  try {
    const d = await listItemFiles(api(), ref.cid, ref.kind, ref.id, (p) => { if (proj) { proj.prog = p; render(); } });
    if (!proj || proj.taskId !== taskId) return;
    proj.data = d; proj.loading = false; proj.title = d.title || proj.title;
    // Linked files plus the rest of the project's module are ticked; a huge module (a whole week of lectures) is left unticked.
    const okf = d.files.filter((f) => !f.locked && !f.missing), mod = okf.filter((f) => f.group === 'module');
    okf.filter((f) => f.group === 'linked' || mod.length <= 15).forEach((f) => proj.sel.add(f.id));
  } catch (e) { if (proj) { proj.loading = false; proj.err = e.auth ? 'Not signed in to Canvas. Sign in, then try again.' : 'Could not read this item: ' + e.message; } }
  render();
};
ACT.projPick = (id) => { if (!proj) return; if (EL.checked) proj.sel.add(id); else proj.sel.delete(id); render(); };
ACT.projAll = (on) => { if (!proj || !proj.data) return; proj.data.files.forEach((f) => { if (!f.locked && !f.missing) { if (on) proj.sel.add(f.id); else proj.sel.delete(f.id); } }); render(); };
ACT.projInstr = () => { proj.saveInstr = EL.checked; };
ACT.projClose = () => { proj = null; render(); };
ACT.projDownload = () => {
  needDownloads().then(async (ok) => {
    if (!ok) return toast('Saving files needs the Triaj companion\'s permission');
    const p = proj, list = p.data.files.filter((f) => p.sel.has(f.id));
    const folder = 'Canvas/' + cleanName(p.course) + '/' + cleanName(p.title);
    const extras = p.saveInstr && p.data.html ? [{ url: dataUrl(instructionsPage(p.title, p.course, p.data.html, 'https://' + st.canvas.host)), path: folder + '/_Instructions - ' + cleanName(p.title, 60) + '.html', key: 'x:instr' }] : [];
    if (!list.length && !extras.length) return toast('Nothing selected');
    p.busy = true; p.dprog = 'Starting downloads…'; p.result = null; render();
    p.result = await saveFiles(list, folder, extras);
    p.busy = false; render();
    toast(p.result.failed.length ? 'Done, with ' + p.result.failed.length + ' problem(s)' : 'Saved ' + p.result.ok + ' files');
  });
};
function projCard() {
  if (!proj) return '';
  const p = proj;
  let body;
  if (p.loading) body = '<div class="stbox info"><b>⏳ ' + esc(p.prog) + '</b></div>';
  else if (p.err) body = '<div class="stbox err"><b>❌ ' + esc(p.err) + '</b></div>';
  else {
    const fs = p.data.files, linked = fs.filter((f) => f.group === 'linked'), mod = fs.filter((f) => f.group === 'module');
    const sec = (title, list) => list.length ? '<h3 style="margin:10px 0 2px">' + title + '</h3>' + list.map((f) => fileRow(f, p.sel.has(f.id), 'projPick')).join('') : '';
    const n = fs.filter((f) => p.sel.has(f.id)).length, mb = fs.filter((f) => p.sel.has(f.id)).reduce((a, f) => a + (f.size || 0), 0);
    body = (fs.length ? '' : '<div class="s" style="margin:6px 0">No files are linked in the instructions' + (p.data.moduleName ? ' or in its module' : ' (and it is not in a module)') + '. You can still save the instructions, or browse the whole course below.</div>') +
      sec('Linked in the instructions (' + linked.length + ')', linked) + sec('Also in module "' + esc(p.data.moduleName) + '" (' + mod.length + ')', mod) +
      (p.data.html ? '<div class="check" style="margin-top:10px"><input type="checkbox" id="pins"' + (p.saveInstr ? ' checked' : '') + CH('projInstr') + '><label for="pins">Save the instructions page too (opens offline)</label></div>' : '') +
      (fs.length ? '<div class="conf-row"><button class="pill"' + C('projAll', true) + '>Select all</button><button class="pill"' + C('projAll', false) + '>None</button></div>' : '') +
      '<button class="btn" style="margin-top:10px"' + C('projDownload') + (p.busy ? ' disabled' : '') + '>' + (p.busy ? esc(p.dprog) : '⬇ Download ' + n + ' file' + (n === 1 ? '' : 's') + (mb ? ' (' + fmtSize(mb) + ')' : '') + (p.saveInstr && p.data.html ? ' + instructions' : '')) + '</button>' +
      '<div class="s" style="margin-top:6px">Saves to Downloads/Canvas/' + esc(cleanName(p.course)) + '/' + esc(cleanName(p.title)) + '/</div>' + resultBox(p.result);
  }
  return '<div class="card hcard"><div class="hrow"><h3>📎 ' + esc(p.title) + '</h3><button class="x"' + C('projClose') + '>×</button></div><div class="s">' + esc(p.course) + ' · everything you need for this, in one folder</div>' + body + '</div>';
}

/* course browser */
ACT.fxCourse = (cid) => { if (fx.cid === cid && fx.data) return; Object.assign(fx, { cid, data: null, err: '', sel: new Set(), result: null, q: '', filter: 'all', closed: {} }); loadCourse(); };
ACT.fxReload = () => { fx.data = null; loadCourse(); };
async function loadCourse() {
  const cid = fx.cid;
  fx.loading = true; fx.prog = 'Starting…'; render();
  try {
    const d = await listCourseFiles(api(), cid, (p) => { if (fx.cid === cid) { fx.prog = p; render(); } });
    if (fx.cid !== cid) return;
    fx.data = d;
  } catch (e) { fx.err = e.auth ? 'Not signed in to Canvas. Sign in, then press Retry.' : 'Could not read this course: ' + e.message; }
  fx.loading = false; render();
}
function fxVisible(f) {
  if (fx.filter !== 'all' && f.type !== fx.filter) return false;
  if (fx.q) { const q = fx.q.toLowerCase(); if ((f.name + ' ' + (f.from || '') + ' ' + f.group).toLowerCase().indexOf(q) < 0) return false; }
  return true;
}
const fxOk = (f) => !f.locked && !f.missing && !!f.url;
ACT.fxPick = (id) => { if (EL.checked) fx.sel.add(id); else fx.sel.delete(id); render(); };
ACT.fxGroup = (gi) => {
  const g = fx.data.groups[gi], list = g.files.filter((f) => fxVisible(f) && fxOk(f));
  const all = list.every((f) => fx.sel.has(f.id));
  list.forEach((f) => { if (all) fx.sel.delete(f.id); else fx.sel.add(f.id); });
  render();
};
ACT.fxToggle = (gi) => { fx.closed[gi] = !fx.closed[gi]; render(); };
ACT.fxFilter = (f) => { fx.filter = f; render(); };
ACT.fxQ = () => { fx.q = EL.value; clearTimeout(fx.qt); fx.qt = setTimeout(() => { const pos = EL.selectionStart; render(); const e = $('fxq'); if (e) { e.focus(); try { e.setSelectionRange(pos, pos); } catch (er) {} } }, 250); };
ACT.fxSel = (mode) => {
  const vis = [];
  fx.data.groups.forEach((g) => g.files.forEach((f) => { if (fxVisible(f) && fxOk(f)) vis.push(f); }));
  if (mode === 'none') vis.forEach((f) => fx.sel.delete(f.id));
  else vis.forEach((f) => { if (mode === 'all' || (mode === 'new' && (!dlog[f.id] || (f.updated && dlog[f.id].u && f.updated > dlog[f.id].u)))) fx.sel.add(f.id); });
  render();
};
ACT.fxByModule = () => { fx.byModule = EL.checked; render(); };
ACT.fxDownload = () => {
  needDownloads().then(async (ok) => {
    if (!ok) return toast('Saving files needs the Triaj companion\'s permission');
    const seen = new Set(), list = [];
    fx.data.groups.forEach((g) => g.files.forEach((f) => {
      if (fx.sel.has(f.id) && fxOk(f) && !seen.has(f.id)) { seen.add(f.id); list.push(Object.assign({}, f, { sub: fx.byModule ? g.name.replace(/^Files: /, '') : '' })); }
    }));
    if (!list.length) return toast('Nothing selected');
    fx.busy = true; fx.dprog = 'Starting downloads…'; fx.result = null; render();
    fx.result = await saveFiles(list, 'Canvas/' + cleanName(courseCode(fx.cid)));
    fx.busy = false; render();
    toast(fx.result.failed.length ? 'Done, with ' + fx.result.failed.length + ' problem(s)' : 'Saved ' + fx.result.ok + ' files');
  });
};
function viewFiles() {
  if (!st.canvas.host) return '<div class="card hero"><h3>📚 Canvas files</h3><div class="s" style="margin-bottom:10px">Connect Canvas first, then you can download course files and project resources into folders.</div><button class="btn" style="background:#fff;color:#1c1c22"' + C('go', 'sync') + '>Connect Canvas</button></div>';
  const courses = st.canvas.courses || [];
  const soon = sorted(st.tasks.filter((t) => !t.done && canvasRef(t) && t.d && t.d >= todayS)).slice(0, 6);
  const pills = '<div class="presets" style="justify-content:flex-start">' + courses.map((c) => '<button class="pill' + (fx.cid === c.id ? ' on' : '') + '"' + C('fxCourse', c.id) + '>' + esc(c.code) + '</button>').join('') + '</div>';
  let browser = '';
  if (fx.cid) {
    if (fx.loading) browser = '<div class="stbox info"><b>⏳ ' + esc(fx.prog) + '</b><div class="s">Big courses can take 10–30 seconds the first time.</div></div>';
    else if (fx.err) browser = '<div class="stbox err"><b>❌ ' + esc(fx.err) + '</b><div class="btnrow" style="margin-top:8px"><button class="btn sm"' + C('fxReload') + '>Retry</button></div></div>';
    else if (fx.data) {
      const allF = [];
      fx.data.groups.forEach((g) => g.files.forEach((f) => allF.push(f)));
      const uniq = new Set(allF.map((f) => f.id));
      const counts = {};
      allF.forEach((f) => { counts[f.type] = (counts[f.type] || 0) + 1; });
      const types = '<div class="conf-row" style="margin:8px 0"><button class="pill' + (fx.filter === 'all' ? ' on' : '') + '"' + C('fxFilter', 'all') + '>All (' + uniq.size + ')</button>' +
        Object.keys(FT).filter((k) => counts[k]).map((k) => '<button class="pill' + (fx.filter === k ? ' on' : '') + '"' + C('fxFilter', k) + '>' + FT[k][0] + ' ' + FT[k][1] + ' (' + counts[k] + ')</button>').join('') + '</div>';
      const groups = fx.data.groups.map((g, gi) => {
        const vis = g.files.filter(fxVisible), selectable = vis.filter(fxOk);
        if (!vis.length && !(g.links.length && fx.filter === 'all' && !fx.q)) return '';
        const nsel = selectable.filter((f) => fx.sel.has(f.id)).length;
        const all = selectable.length && nsel === selectable.length;
        return '<div class="fgroup"><div class="fghead"><input type="checkbox" style="width:auto;margin:0"' + (all ? ' checked' : '') + (selectable.length ? '' : ' disabled') + CH('fxGroup', gi) + '>' +
          '<b' + C('fxToggle', gi) + ' style="cursor:pointer;flex:1">' + (fx.closed[gi] ? '▸ ' : '▾ ') + esc(g.name) + '</b><span class="s">' + (nsel ? nsel + ' of ' : '') + vis.length + ' file' + (vis.length === 1 ? '' : 's') + '</span></div>' +
          (fx.closed[gi] ? '' : vis.map((f) => fileRow(f, fx.sel.has(f.id), 'fxPick')).join('') +
            (fx.filter === 'all' && !fx.q ? g.links.map((l) => '<div class="item frow dim"><span class="fic">🔗</span><div class="t">' + esc(l.name) + '<div class="s">Website link, not a file</div></div><a class="lnk" href="' + esc(l.url) + '" target="_blank" rel="noopener">↗</a></div>').join('') : '')) + '</div>';
      }).join('');
      const selFiles = allF.filter((f, i, a) => fx.sel.has(f.id) && a.findIndex((x) => x.id === f.id) === i);
      const mb = selFiles.reduce((a, f) => a + (f.size || 0), 0);
      browser = '<div class="hrow"><input id="fxq" placeholder="Search files, e.g. midterm, week 5, lecture" style="margin:0" value="' + esc(fx.q) + '"' + on('input', 'fxQ') + '><button class="btn sm sec"' + C('fxReload') + '>↻</button></div>' + types +
        '<div class="conf-row" style="margin-bottom:8px"><span class="s" style="align-self:center">Select:</span><button class="pill"' + C('fxSel', 'all') + '>All shown</button><button class="pill"' + C('fxSel', 'new') + '>New or updated</button><button class="pill"' + C('fxSel', 'none') + '>None</button></div>' +
        (groups || '<div class="empty">No files match.</div>') +
        (!fx.data.modulesOk && !fx.data.filesOk ? '<div class="s">This course hides its modules and files from students, so only files linked from the syllabus could be found.</div>' : '') +
        '<div class="dlbar"><div class="t"><b>' + selFiles.length + ' selected</b>' + (mb ? ' · ' + fmtSize(mb) : '') + '<div class="check" style="margin:2px 0 0"><input type="checkbox" id="fxbm"' + (fx.byModule ? ' checked' : '') + CH('fxByModule') + '><label for="fxbm" class="s">A folder per module</label></div></div>' +
        '<button class="btn" style="width:auto;margin:0"' + C('fxDownload') + (selFiles.length && !fx.busy ? '' : ' disabled') + '>' + (fx.busy ? esc(fx.dprog) : '⬇ Download') + '</button></div>' + resultBox(fx.result);
    }
  }
  return '<div class="cols mcols"><div>' + projCard() +
    '<div class="card"><h3>📚 Browse a course</h3><div class="s">Pick a course to see every file in its modules, pages, assignments, syllabus and Files area. Tick what you want and it downloads into Downloads/Canvas/&lt;course&gt;/&lt;module&gt;/.</div>' +
    (courses.length ? pills : '<div class="empty">Sync Canvas once to list your courses.</div>') + browser + '</div></div>' +
    '<div><div class="card"><h3>📎 Project files</h3><div class="s" style="margin-bottom:6px">Grab everything for one assignment: files linked in its instructions plus the rest of its module. Also on any Canvas task via the 📎 button.</div>' +
    (soon.length ? soon.map((t) => '<div class="item"><div class="t">' + esc(t.t) + '<div class="s">' + tag(t) + niceDay(t.d) + '</div></div><button class="btn sm sec"' + C('getFiles', t.id) + '>📎 Get files</button></div>').join('') : '<div class="empty" style="padding:8px">No upcoming Canvas assignments.</div>') +
    '</div><div class="card"><div class="s">Files go to your Downloads folder under <b>Canvas</b>. Downloading again overwrites the old copy, so updated lecture notes replace stale ones. Files marked ✓ were downloaded before; <b>New or updated</b> selects only what changed.</div></div></div></div>';
}

/* ---------- sync ---------- */
function liveStatus(st0) {
  if (st0 && st0.code === 'perm' && canvasPerm !== true && !syncState.running) return '<div class="stbox err"><b>❌ ' + esc(st0.text) + '</b><div class="btnrow" style="margin-top:8px"><button class="btn sm"' + C('allowCanvas') + '>Allow access</button></div></div>';
  if (syncState.running) return '<div class="stbox info"><b>⏳ ' + esc(syncState.text || 'Syncing…') + '</b><div style="font-size:11px;color:var(--mute);margin-top:4px">Syncing with Canvas. You can keep using the planner.</div></div>';
  return statusBox(st0);
}
function reportCard() {
  const r = st.canvas.report;
  if (!r) return '';
  const left = r.left || [];
  const up = left.filter((x) => x.item.due && x.item.due >= todayS && !/submitted|completed|marked done/.test(x.reason));
  const rows = r.courses.map((c) => '<tr><td>' + esc(c.code) + '</td><td>' + c.found + '</td><td>' + c.open + '</td><td>' + c.done + '</td><td>' + (c.waiting ? c.waiting : '') + '</td><td>' + (c.left ? '<b>' + c.left + '</b>' : '0') + '</td></tr>').join('');
  const shown = reportAll ? left : up.slice(0, 30);
  const list = shown.map((x) => {
    const i = x.item, upcoming = i.due && i.due >= todayS;
    return '<div class="item" style="flex-wrap:wrap"><div class="t">' + esc(i.title) + '<div class="s">' + (i.course ? '<span class="chip">' + esc(i.course) + '</span>' : '') +
      (i.due ? '<span class="chip' + (upcoming && dueDays({ d: i.due }) <= 1 ? ' warn' : '') + '">' + niceDay(i.due) + (i.time ? ' ' + tf(mn(i.time)) : '') + '</span>' : '<span class="chip">no date</span>') +
      (KIND[i.kind] ? '<span class="chip">' + KIND[i.kind] + '</span>' : '') + ' Not added: <b>' + esc(x.reason) + '</b>' + (i.from ? ' · from ' + esc(i.from) : '') + '</div></div>' +
      '<div class="conf-row">' + (i.url ? '<a class="pill" href="' + esc(i.url) + '" target="_blank" rel="noopener">Open ↗</a>' : '') + '<button class="pill on"' + C('forceAdd', i.uid) + '>Add anyway</button></div></div>';
  }).join('');
  return '<div class="card"><div class="hrow"><h3>🔍 Canvas vs. your planner</h3><span class="s">checked ' + ago(r.at) + '</span></div>' +
    '<div class="s" style="margin-bottom:8px">Canvas reported ' + r.total + ' items across your courses (To-Do list, assignments, modules). Every one is accounted for here: nothing is dropped silently.</div>' +
    (r.plannerOk === false ? '<div class="stbox warn" style="margin-bottom:8px"><b>⚠ Could not read your Canvas To-Do list</b><div class="s">Ungraded to-dos and locked quizzes may be missing. Try Sync now; if it keeps happening, add an access token.</div></div>' : '') +
    '<div style="overflow-x:auto"><table class="rtab"><thead><tr><th>Course</th><th>In Canvas</th><th>To do</th><th>Done</th><th>Waiting</th><th>Not added</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
    '<h3 style="margin-top:12px">' + (reportAll ? 'Everything not added (' + left.length + ')' : up.length ? 'Upcoming items not added (' + up.length + ')' : 'Every upcoming Canvas item is in your planner ✓') + '</h3>' +
    (shown.length ? list : '') + (left.length ? '<button class="pill" style="margin-top:8px"' + C('reportAll') + '>' + (reportAll ? 'Show only upcoming' : 'Show all ' + left.length + ' (including past and submitted)') + '</button>' : '') + '</div>';
}
ACT.reportAll = () => { reportAll = !reportAll; render(); };
ACT.forceAdd = (uid) => {
  const r = st.canvas.report, x = r && r.left.find((y) => y.item.uid === uid);
  if (!x) return;
  const S = mergeItems(st, [x.item], { source: 'canvas', force: true, autoClasses: st.canvas.autoClasses });
  r.left = r.left.filter((y) => y.item.uid !== uid);
  r.courses.forEach((c) => { if (c.id === x.item.courseId) { c.left = Math.max(0, c.left - 1); c.open++; } });
  save(); render(); toast(S.added ? 'Added: ' + x.item.title : 'Already in your planner');
};

/* --- syllabus date finder --- */
function sylOf(cid) { return (st.canvas.syllabi || []).find((s) => s.courseId === cid); }
function sylSources(s) {
  const a = (s.from || []).slice();
  (s.files || []).forEach((f) => a.push('📎 ' + f.name));
  return a;
}
function sylStatus(cid) {
  const r = sylRun[cid], d = st.canvas.sylDone[cid];
  if (r && r.status === 'reading') return '<div class="stbox info"><b>⏳ ' + esc(r.text) + '</b></div>';
  if (r && r.status === 'err') return '<div class="stbox err"><b>❌ ' + esc(r.text) + '</b>' + (r.fix || '') + '</div>';
  if (r && r.status === 'done') return '<div class="stbox ' + (r.items.length ? 'ok' : 'warn') + '"><b>' + (r.items.length ? '✅ ' : '⚠️ ') + esc(r.text) + '</b>' + (r.notes ? '<div class="s" style="margin-top:4px">' + esc(r.notes) + '</div>' : '') + (r.fix || '') + '</div>';
  if (d) return '<div class="s" style="margin:4px 0">Last read ' + ago(d.at) + ': ' + esc(d.text) + '</div>';
  return '';
}
function sylResults(cid) {
  const r = sylRun[cid];
  if (!r || r.status !== 'done' || !r.items.length) return '';
  const cnt = r.items.filter((i) => i.sel).length;
  return '<div style="margin-top:8px">' + r.items.map((i, k) =>
    '<label class="item" style="cursor:pointer' + (i.past ? ';opacity:.6' : '') + '"><input type="checkbox" style="width:auto;margin:0"' + (i.sel ? ' checked' : '') + CH('sylPick', cid, k) + '><div class="t">' + esc(i.title) + (i.weight ? ' <span class="s">(' + esc(i.weight) + ')</span>' : '') +
    '<div class="s"><span class="chip' + (i.past ? '' : dueDays({ d: i.due }) <= 1 ? ' warn' : '') + '">' + niceDay(i.due) + (i.time ? ' ' + tf(mn(i.time)) : '') + '</span>' + (KIND[i.kind] ? '<span class="chip">' + KIND[i.kind] + '</span>' : i.kind ? '<span class="chip">' + esc(i.kind) + '</span>' : '') +
    (i.past ? 'already past' : i.dup ? 'probably already in your planner as "' + esc(i.dup) + '"' : '') + '</div></div></label>').join('') +
    '<button class="btn" style="margin-top:8px"' + C('sylAdd', cid) + (cnt ? '' : ' disabled') + '>Add ' + cnt + ' to my planner</button></div>';
}
function sylCard() {
  if (!st.canvas.host) return '';
  const list = st.canvas.syllabi || [];
  const key = aiReady(), busy = Object.keys(sylRun).some((k) => sylRun[k].status === 'reading');
  const rows = list.map((s) => {
    const src = sylSources(s), r = sylRun[s.courseId], reading = r && r.status === 'reading';
    return '<div class="sylrow"><div class="hrow"><b>' + esc(s.course) + '</b><div class="btnrow" style="flex:none">' +
      '<button class="btn sm"' + C('sylRun', s.courseId) + (key && src.length && !reading ? '' : ' disabled') + '>Find dates</button>' +
      '<button class="btn sm sec"' + C('sylPick2', s.courseId) + (key && !reading ? '' : ' disabled') + '>Upload PDF</button>' +
      '<button class="btn sm sec"' + C('sylPasteToggle', s.courseId) + (key && !reading ? '' : ' disabled') + '>Paste</button></div></div>' +
      '<input type="file" id="sf_' + esc(s.courseId) + '" accept=".pdf,.txt,application/pdf,text/plain" style="display:none"' + CH('sylUpload', s.courseId) + '>' +
      '<div class="s" style="margin:4px 0">' + (src.length ? 'Found in Canvas: ' + src.map(esc).join(' · ') : 'No syllabus found in Canvas (no syllabus page, and no page or file named syllabus/outline). Upload the outline PDF or paste its text.') + '</div>' +
      (r && r.paste ? '<textarea id="sp_' + esc(s.courseId) + '" placeholder="Paste the course outline text here"></textarea><button class="btn sm"' + C('sylPasteGo', s.courseId) + '>Find dates in this text</button>' : '') +
      sylStatus(s.courseId) + sylResults(s.courseId) + '</div>';
  }).join('');
  return '<div class="card"><div class="hrow"><h3>📄 Syllabi & course outlines</h3><button class="btn sm"' + C('sylAll') + (key && !busy && list.length ? '' : ' disabled') + '>Find dates in all</button></div>' +
    '<div class="s" style="margin-bottom:8px">Exams, labs and project dates that live only in the syllabus. The AI reads the syllabus page, outline pages and outline PDFs, then you pick what to add.</div>' +
    (key ? '' : '<div class="stbox warn" style="margin-bottom:8px"><b>⚠ The date finder needs AI</b><div class="s" style="margin:4px 0 8px">Set it up once (about 3 minutes, free with a Gemini key); then these buttons work.</div><button class="btn sm"' + C('go', 'ai') + '>Get started with AI</button></div>') +
    (list.length ? rows : '<div class="empty" style="padding:8px">Sync once to list your courses here.</div>') + '</div>';
}
function b64(buf) {
  const u = new Uint8Array(buf); let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
const FILE_ORIGINS = ['https://*.instructure.com/*', 'https://*.amazonaws.com/*', 'https://*.inscloudgate.net/*', 'https://*.canvas-user-content.com/*'];
async function fetchFile(f) {
  let r;
  try { r = await bridge.fetch(f.url, { credentials: 'include', as: 'base64' }); }
  catch (e) { const er = new Error('blocked'); er.blocked = true; throw er; }
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const ct = r.headers.get('content-type') || '';
  if (ct.indexOf('html') > -1) throw new Error('Canvas asked to sign in again');
  return { ct, buf: await r.arrayBuffer() };
}
async function runSyl(cid, extra) {
  extra = extra || {};
  const s = sylOf(cid);
  if (!s) return;
  if (!aiReady()) { sylRun[cid] = { status: 'err', text: 'Set up AI first (AI tab → Get started with AI).' }; render(); return; }
  const run = sylRun[cid] = { status: 'reading', text: 'Getting the syllabus…', items: [] };
  render();
  const docs = [], names = [], problems = [];
  let text = extra.text !== undefined ? '' : (s.text || '');
  if (text) names.push(...(s.from || []));
  if (extra.text) { text = 'Pasted course outline:\n' + extra.text; names.push('pasted text'); }
  if (extra.pdf) { docs.push(extra.pdf.data); names.push(extra.pdf.name); }
  if (!extra.text && !extra.pdf) {
    for (const f of (s.files || []).slice(0, 3)) {
      const isPdf = /pdf/i.test(f.type) || /\.pdf$/i.test(f.name), isTxt = /text\/plain/i.test(f.type) || /\.txt$/i.test(f.name);
      if (!isPdf && !isTxt) { problems.push({ f, msg: f.name + ' is a ' + (/\.docx?$/i.test(f.name) ? 'Word' : 'non-PDF') + ' file: open it and use Paste' }); continue; }
      if (f.size > 25e6) { problems.push({ f, msg: f.name + ' is too large to read' }); continue; }
      run.text = 'Downloading ' + f.name + '…'; render();
      try {
        const got = await fetchFile(f);
        if (isTxt) text += '\nFile ' + f.name + ':\n' + new TextDecoder().decode(got.buf).slice(0, 20000);
        else docs.push(b64(got.buf));
        names.push(f.name);
      } catch (e) { problems.push({ f, msg: e.blocked ? 'Could not download ' + f.name + ' (Canvas stores files on a separate site the planner is not allowed to read yet)' : 'Could not download ' + f.name + ': ' + e.message, blocked: !!e.blocked }); }
    }
  }
  const fix = problems.length ? '<div class="s" style="margin-top:6px">' + problems.map((p) => esc(p.msg) + (p.f && p.f.page ? ' · <a class="lnk" href="' + esc(p.f.page) + '" target="_blank" rel="noopener">Open file ↗</a>' : '')).join('<br>') +
    (problems.some((p) => p.blocked) ? '<div class="btnrow" style="margin-top:6px"><button class="btn sm"' + C('allowFiles', cid) + '>Allow reading course files</button></div>' : '') + '</div>' : '';
  if (!text.trim() && !docs.length) {
    sylRun[cid] = { status: 'err', text: 'Nothing readable for ' + s.course + '.', fix: fix || '<div class="s" style="margin-top:6px">Upload the outline PDF or paste its text.</div>', items: [] };
    finishSyl(cid, 'nothing readable'); return;
  }
  run.text = 'AI is reading ' + names.join(' + ') + '… (usually 10–40 seconds)'; render();
  try {
    const r = await aiJSON('Course: ' + s.course + (s.name && s.name !== s.course ? ' (' + s.name + ')' : '') + '. Today is ' + todayS + '.\n' +
      'From the course syllabus/outline material provided (text below' + (docs.length ? ' and the attached PDF' + (docs.length > 1 ? 's' : '') : '') + '), list every DATED thing the student must do, submit, or attend: exams, midterms, finals (if dated), quizzes, assignment/homework/lab due dates, project milestones, presentations, and readings that have a specific date. ' +
      'Skip regular lecture/tutorial meeting times, office hours, holidays, and policies. If deliverables are listed per week with explicit dates, give each date separately. If a date has no year, use the year of the current academic term. Only include items with a specific calendar date.\n' +
      'Reply ONLY with JSON: {"items":[{"title":string,"due":"YYYY-MM-DD","time":"HH:MM (24h) or empty string","type":"exam"|"quiz"|"assignment"|"lab"|"project"|"reading"|"other","estMinutes":number,"weight":"grade weight like 20% or empty string"}],"notes":"one short sentence: what you found, or why nothing was found"}\n\n' +
      (text ? 'TEXT:\n' + text.slice(0, 30000) : '(See attached PDF.)'), docs);
    const today = todayS;
    const items = (r.items || []).filter((i) => i && i.title && /^\d{4}-\d{2}-\d{2}$/.test(i.due || '')).map((i) => {
      const kind = i.type === 'exam' ? 'exam' : i.type === 'quiz' ? 'quiz' : String(i.type || '');
      const g = guessTask(i.title, kind);
      const it = { title: String(i.title), due: i.due, time: /^\d{2}:\d{2}$/.test(i.time || '') ? i.time : '', kind, weight: i.weight || '', est: +i.estMinutes > 0 ? Math.round(+i.estMinutes) : g.est,
        p: /exam|quiz|project/.test(i.type) ? 'h' : g.p, past: i.due < today };
      it.dup = dupOf(it, cid);
      it.sel = !it.past && !it.dup;
      return it;
    }).sort((a, b) => (a.due < b.due ? -1 : 1));
    const fresh = items.filter((i) => i.sel).length;
    sylRun[cid] = { status: 'done', items, fix, notes: r.notes || '',
      text: items.length ? 'Found ' + items.length + ' dated item' + (items.length === 1 ? '' : 's') + ' in ' + names.join(' + ') + ' · ' + fresh + ' new (checked below)' : 'No dated items found in ' + names.join(' + ') };
  } catch (e) { sylRun[cid] = { status: 'err', text: e.message, fix, items: [] }; }
  finishSyl(cid);
}
function finishSyl(cid) {
  const r = sylRun[cid];
  st.canvas.sylDone[cid] = { at: new Date().toISOString(), status: r.status, text: r.text };
  save(); render();
  if (r.status === 'done') toast(sylOf(cid).course + ': ' + (r.items.length ? r.items.length + ' dates found' : 'no dates found'));
  else if (r.status === 'err') toast(sylOf(cid).course + ': could not read the syllabus');
}
// Is this syllabus item probably already a task (e.g. synced from Canvas)?
function dupOf(it, cid) {
  const classId = matchClass(st, '', cid, false);
  const words = (t) => String(t).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !/^(the|and|for|due)$/.test(w));
  const iw = words(it.title);
  const hit = st.tasks.concat(st.held).find((t) => {
    if (classId && t.cls && t.cls !== classId) return false;
    if (t.d !== it.due) return false;
    const tw = words(t.t);
    return t.t.toLowerCase() === it.title.toLowerCase() || iw.some((w) => tw.indexOf(w) > -1);
  });
  return hit ? hit.t : '';
}
ACT.sylRun = (cid) => runSyl(cid);
ACT.sylAll = async () => {
  for (const s of (st.canvas.syllabi || [])) {
    if (sylSources(s).length) await runSyl(s.courseId);
  }
  toast('Finished reading all syllabi');
};
ACT.sylPick = (cid, k) => { const r = sylRun[cid]; if (r && r.items[k]) { r.items[k].sel = EL.checked; render(); } };
ACT.sylPick2 = (cid) => { const e = $('sf_' + cid); if (e) e.click(); };
ACT.sylPasteToggle = (cid) => { sylRun[cid] = Object.assign({ status: '', items: [] }, sylRun[cid], { paste: !(sylRun[cid] && sylRun[cid].paste) }); render(); };
ACT.sylPasteGo = (cid) => { const t = ($('sp_' + cid) || {}).value || ''; if (!t.trim()) return toast('Paste some text first'); runSyl(cid, { text: t.trim() }); };
ACT.sylUpload = (cid) => {
  const f = EL.files && EL.files[0]; if (!f) return;
  const rd = new FileReader();
  if (/\.txt$/i.test(f.name) || f.type === 'text/plain') { rd.onload = () => runSyl(cid, { text: String(rd.result) }); rd.readAsText(f); return; }
  rd.onload = () => runSyl(cid, { pdf: { name: f.name, data: b64(rd.result) } });
  rd.readAsArrayBuffer(f);
};
ACT.allowFiles = (cid) => {
  ext.permissions.request({ origins: FILE_ORIGINS }).then((ok) => { if (ok) runSyl(cid); else toast('Not allowed. Use Open file, then Upload PDF.'); });
};
ACT.sylAdd = (cid) => {
  const r = sylRun[cid], s = sylOf(cid);
  if (!r || !s) return;
  const slug = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  const chosen = r.items.filter((i) => i.sel).map((i) => ({ title: i.title + (i.weight ? ' (' + i.weight + ')' : ''), due: i.due, time: i.time, kind: i.kind, est: i.est, p: i.p,
    course: s.course, courseId: cid, uid: 'syl:' + cid + ':' + slug(i.title) + ':' + i.due }));
  const S = mergeItems(st, chosen, { source: 'syllabus', force: true, autoClasses: true });
  r.items = r.items.filter((i) => !i.sel);
  r.text = 'Added ' + S.added + ' item' + (S.added === 1 ? '' : 's') + ' from the syllabus' + (S.same ? ' (' + S.same + ' were already there)' : '') + (r.items.length ? ' · ' + r.items.length + ' left unchecked' : '');
  if (!r.items.length) r.status = 'done';
  st.canvas.sylDone[cid] = { at: new Date().toISOString(), status: 'done', text: r.text };
  save(); render(); toast('Added ' + S.added + ' from ' + s.course);
};

function viewSync() {
  const cv = st.canvas;
  let canvas;
  if (!cv.host) {
    canvas = '<div class="card hero"><h3>🔄 Connect Canvas</h3><div class="s" style="margin-bottom:10px">One-time setup. After this, new assignments, quizzes and changed due dates arrive on their own, and things you submit get checked off.</div>' +
      '<input id="cvh" placeholder="Your Canvas address, e.g. canvas.ubc.ca"' + EN('connectCanvas') + '>' +
      '<details style="margin-bottom:8px"><summary class="s" style="color:#fff">Optional: access token (keeps sync working when you are signed out)</summary><input id="cvt" type="password" placeholder="Paste a Canvas access token" style="margin-top:8px"><div class="s">In Canvas: Account → Settings → <b>New access token</b>. It is saved to your account so sync works from any of your computers.</div></details>' +
      '<button class="btn" style="background:#fff;color:#1c1c22"' + C('connectCanvas') + '>Connect</button><div class="s" style="margin-top:8px">The Triaj companion extension will ask to let Triaj read that site. Without a token, you just need to be signed in to Canvas in this browser.</div></div>';
  } else {
    const ex = cv.excluded || [];
    const courses = (cv.courses || []).map((c) => '<div class="check"><input type="checkbox" id="cc_' + esc(c.id) + '"' + (ex.indexOf(c.id) < 0 ? ' checked' : '') + CH('cvCourse', c.id) + '><label for="cc_' + esc(c.id) + '">' + esc(c.code) + '<span class="s"> ' + esc(c.name !== c.code ? c.name : '') + '</span></label></div>').join('');
    const chk = (k, l) => '<div class="check"><input type="checkbox" id="cv_' + k + '"' + (cv[k] ? ' checked' : '') + CH('cvSet', k) + '><label for="cv_' + k + '">' + l + '</label></div>';
    canvas = permCard() + '<div class="card"><div class="hrow"><h3>🔄 Canvas · ' + esc(cv.host) + '</h3><button class="btn sm"' + C('syncNow', 'canvas') + (syncBusy || syncState.running ? ' disabled' : '') + '>' + (syncBusy || syncState.running ? 'Syncing…' : 'Sync now') + '</button></div>' + liveStatus(cv.lastStatus) +
      '<details style="margin-top:10px"><summary>Sync settings</summary>' + chk('auto', 'Sync automatically in the background') +
      '<span class="lbl">How often</span><select' + CH('cvSet', 'interval') + '>' + [[15, 'Every 15 minutes'], [30, 'Every 30 minutes'], [60, 'Every hour'], [180, 'Every 3 hours'], [360, 'Every 6 hours']].map((o) => '<option value="' + o[0] + '"' + (+cv.interval === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select>' +
      '<h3 style="margin-top:10px">What to bring in</h3>' + chk('assign', 'Everything on your Canvas To-Do list (assignments, quizzes, ungraded to-dos, peer reviews)') + chk('modReq', 'Required module items without a date (readings, videos)') + chk('modOther', 'Optional module items') +
      chk('skipPast', 'Skip new items that are already past due') + chk('autoComplete', 'Check off tasks I submit in Canvas') + chk('autoClasses', 'Create a class for each course automatically') +
      (courses ? '<h3 style="margin-top:10px">Courses</h3>' + courses : '') +
      '<h3 style="margin-top:10px">Access token' + (cv.token ? ' (saved)' : ' (not set)') + '</h3><input id="cvt" type="password" value="' + esc(cv.token) + '" placeholder="Canvas access token"><div class="s" style="margin-bottom:8px">Without a token, sync uses your Canvas sign-in in this browser. With one, it works even when you are signed out. Canvas: Account → Settings → New access token.</div><button class="btn sm sec"' + C('saveToken') + '>Save token</button>' +
      (st.dismissed.length ? '<div class="s" style="margin-top:10px">' + st.dismissed.length + ' deleted Canvas item' + (st.dismissed.length === 1 ? '' : 's') + ' will not come back. <a class="lnk" href="#"' + C('clearDismissed') + '>Allow again</a></div>' : '') +
      '<button class="btn mute" style="margin-top:12px"' + C('disconnectCanvas') + '>Disconnect Canvas</button></details></div>' + reportCard();
  }
  const feeds = st.feeds.map((f) => '<div class="item" style="flex-wrap:wrap"><span class="dot" style="background:' + (f.color || '#64748b') + '"></span><div class="t"><b>' + esc(f.name) + '</b><div class="s">' + (f.type === 'events' ? 'Busy time (schedule around it)' : 'Tasks') + ' · ' + (f.lastStatus ? (f.lastStatus.kind === 'err' ? '❌ ' : '') + esc(f.lastStatus.text) : 'not synced yet') + (f.lastSync ? ' · ' + ago(f.lastSync) : '') + '</div></div>' +
    (f.lastStatus && f.lastStatus.kind === 'err' ? '<button class="btn sm sec"' + C('reconnectFeed', f.id) + '>Reconnect</button>' : '<button class="btn sm sec"' + C('syncNow', 'feed', f.id) + '>' + (syncBusy === 'feed' + f.id ? '…' : 'Sync') + '</button>') + '<button class="x"' + C('delFeed', f.id) + '>×</button></div>').join('');
  const feedCard = '<div class="card"><h3>📆 Calendar feeds</h3><div class="s" style="margin-bottom:8px">Any calendar with an iCal link: Google Calendar (Settings → your calendar → <b>Secret address in iCal format</b>), Outlook, your work schedule, a club calendar. Choose <b>Busy time</b> so study blocks are planned around those events, or <b>Tasks</b> to turn each event into a to-do. (Canvas calendar events like exams already come in with Canvas sync.)</div>' +
    (feeds || '<div class="empty" style="padding:8px">No feeds yet.</div>') +
    '<input id="fn" placeholder="Name (e.g. Work shifts)"><input id="fu" placeholder="https://… or webcal://… link ending in .ics"><div class="row"><select id="ft"><option value="events">Busy time</option><option value="tasks">Tasks</option></select><select id="fc">' + classOpts(0) + '</select></div><button class="btn"' + C('addFeed') + '>Add calendar</button></div>';
  return '<div class="cols"><div>' + (bridge.available() ? '' : isPhone() ? companionHelp(true) : canvasPerm === 'noext' ? '' : companionHelp(false)) + canvas + '</div><div>' + sylCard() + feedCard + '<div class="card"><div class="s">Canvas and calendars sync while Triaj is open in a browser with the companion extension: right when you open it, then on your schedule. What it finds reaches all your devices through your account' + (session.user ? '' : ' (sign in to turn that on)') + '.</div></div></div></div>';
}

/* ---------- manual import ---------- */
function preview(list) {
  const items = [];
  let same = 0, hid = 0;
  const keys = new Set(st.tasks.concat(st.held).map((t) => t.t.toLowerCase() + '|' + (t.d || '')));
  const uids = new Set(st.tasks.concat(st.held).map((t) => t.uid).filter(Boolean));
  list.forEach((i) => {
    const uid = i.uid || ('x:' + i.title.toLowerCase() + '|' + (i.due || ''));
    if (uids.has(uid) || keys.has(i.title.toLowerCase() + '|' + (i.due || ''))) { same++; return; }
    if (imp.hidePast && i.due && i.due < todayS) { hid++; return; }
    const g = guessTask(i.title);
    items.push({ title: i.title, due: i.due || '', cls: i.cls !== undefined ? i.cls : (matchClass(st, i.course, '', false) || imp.defCls), est: i.est || g.est, p: i.p || g.p, uid, sel: true });
  });
  items.sort((a, b) => ((a.due || '9999') < (b.due || '9999') ? -1 : 1));
  imp.items = items;
  imp.msg = items.length ? (same ? same + ' already in your planner. ' : '') + (hid ? hid + ' past items hidden.' : '') : 'Nothing new' + (same ? ' (' + same + ' already in your planner)' : '') + (hid ? ' (' + hid + ' past items hidden)' : '') + '.';
  render();
}
async function aiExtract() {
  const txt = (imp.text || '').trim();
  if (!txt || imp.busy) return;
  if (txt.charAt(0) === '{') {
    try {
      const j = JSON.parse(txt);
      if (j && j.source === 'canvas-helper') {
        const S = mergeItems(st, (j.items || []).map((i) => Object.assign({}, i, { finished: false })), { source: 'canvas', skipPast: imp.hidePast, autoClasses: st.canvas.autoClasses });
        save(); imp.msg = 'Scanner export: ' + statsText(S) + '. (Tip: connect Canvas under Sync so you never need the scanner again.)'; imp.text = ''; render(); return;
      }
    } catch (e) {}
  }
  imp.busy = true; imp.msg = ''; render();
  try {
    const names = st.classes.map((c) => c.n);
    const r = await aiJSON('Today is ' + todayS + '. Extract every task, deadline, exam, quiz, reading, lab or other date-specific item a student must act on from the text below (a course outline, syllabus, or Canvas page). Include items with no date (set due to ""). If a date has no year, use the next occurrence on or after today. The student\'s classes: ' + JSON.stringify(names) + '. Reply ONLY with JSON: {"items":[{"title":string,"due":"YYYY-MM-DD or empty string","class":"exact class name from the list or empty string","estMinutes":number,"priority":"h"|"m"|"l"}]}. Give exams and big projects higher priority and larger estimates. Skip lectures, holidays and general policies. Text:\n' + txt.slice(0, 20000));
    const list = (r.items || []).filter((i) => i && i.title).map((i) => ({ title: String(i.title), due: /^\d{4}-\d{2}-\d{2}$/.test(i.due || '') ? i.due : '', cls: matchClass(st, i.class, '', false) || imp.defCls, est: +i.estMinutes > 0 ? Math.round(+i.estMinutes) : 0, p: PR[i.priority] ? i.priority : '' }));
    imp.busy = false; preview(list);
  } catch (e) { imp.busy = false; imp.msg = e.message; render(); }
}
function viewImport() {
  let prev = '';
  if (imp.items.length) {
    const cnt = imp.items.filter((i) => i.sel).length;
    prev = '<div class="card"><h3>Found ' + imp.items.length + ' item' + (imp.items.length === 1 ? '' : 's') + '</h3>' + imp.items.map((i, k) =>
      '<label class="item" style="cursor:pointer"><input type="checkbox" style="width:auto;margin:0"' + (i.sel ? ' checked' : '') + CH('impItem', k) + '><div class="t">' + esc(i.title) + '<div class="s">' + tag(i) + (i.due || 'No date') + ' · ~' + dur(i.est) + '</div></div></label>').join('') +
      '<button class="btn" style="margin-top:10px"' + C('doImport') + '>Import ' + cnt + ' selected</button></div>';
  }
  return '<div class="cols"><div><div class="card"><h3>Import settings</h3><span class="lbl">Items that do not match a class go to:</span><select' + CH('impDef') + '>' + classOpts(imp.defCls) + '</select>' +
    '<div class="check"><input type="checkbox" id="hp"' + (imp.hidePast ? ' checked' : '') + CH('impPast') + '><label for="hp">Hide items dated before today</label></div></div>' +
    '<div class="card"><h3>.ics file</h3><div class="s" style="margin-bottom:8px">For a one-off import of a calendar file. To keep a calendar in sync, add it as a feed under Sync instead.</div><button class="btn"' + C('pickIcs') + '>Choose .ics file</button><input type="file" id="icsf" accept=".ics,text/calendar" style="display:none"' + CH('loadICS') + '></div></div>' +
    '<div><div class="card"><h3>Paste a syllabus or outline</h3><div class="s" style="margin-bottom:8px">Paste text from a course outline PDF or a Canvas page and the AI pulls out the dates' + (aiReady() ? '.' : ' (needs AI: AI tab → Get started with AI).') + ' Old Canvas Scanner exports also work here.</div>' +
    '<textarea id="imptxt" placeholder="Paste text here..."' + on('input', 'impText') + '>' + esc(imp.text) + '</textarea>' +
    '<button class="btn"' + C('aiExtract') + (imp.busy ? ' disabled' : '') + '>' + (imp.busy ? 'Reading…' : 'Find tasks and dates') + '</button></div>' +
    (imp.msg ? '<div class="card">' + esc(imp.msg) + '</div>' : '') + prev + '</div></div>';
}

/* ---------- settings ---------- */
function sysDark() { try { return window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) { return false; } }
function applyTheme() { applyThemeVars(document.documentElement, st.cfg.theme, st.cfg.mode, sysDark()); }
try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { applyTheme(); render(); }); } catch (e) {}
function daysLabel(d) {
  const a = d.slice().sort().join();
  if (d.length === 7) return 'Every day'; if (a === '1,2,3,4,5') return 'Weekdays'; if (a === '0,6') return 'Weekends';
  return [1, 2, 3, 4, 5, 6, 0].filter((x) => d.indexOf(x) > -1).map((x) => DN[x]).join(', ');
}
function viewSettings() {
  const c = st.cfg;
  const theme = '<div class="card"><h3>Theme color</h3><div style="display:flex;gap:10px;flex-wrap:wrap">' + Object.keys(THEMES).map((k) => '<button class="sw' + ((c.theme || 'ink') === k ? ' on' : '') + '" style="background:linear-gradient(135deg,' + THEMES[k].light + ' 50%,' + THEMES[k].dark + ' 50%)" title="' + THEMES[k].name + '"' + C('setTheme', k) + '></button>').join('') + '</div>' +
    '<h3 style="margin-top:14px">Mode</h3><div class="seg" style="margin:0">' + Object.keys(MODES).map((k) => [k, MODES[k]]).map((m) => '<button class="' + ((c.mode || 'auto') === m[0] ? 'on' : '') + '"' + C('setMode', m[0]) + '>' + m[1] + '</button>').join('') + '</div></div>';
  const feel = '<div class="card"><h3>Feel & reminders</h3>' +
    '<div class="check"><input type="checkbox" id="fx1"' + (c.fx !== false ? ' checked' : '') + CH('setFlag', 'fx') + '><label for="fx1">Celebrations (confetti)</label></div>' +
    '<div class="check"><input type="checkbox" id="fx2"' + (c.sound !== false ? ' checked' : '') + CH('setFlag', 'sound') + '><label for="fx2">Sounds (master switch)</label></div>' +
    '<div class="check"><input type="checkbox" id="fx3"' + (c.digest !== false ? ' checked' : '') + CH('setFlag', 'digest') + '><label for="fx3">Daily heads-up notification of what is due</label></div>' +
    '<span class="lbl">Heads-up time</span><input type="time" value="' + (c.digestTime || '08:00') + '"' + CH('digestTime') + '></div>';
  const rows = st.routines.slice().sort((a, b) => mn(a.s) - mn(b.s)).map((r) => '<div class="item"><div class="t"><b>' + esc(r.name) + '</b><div class="s">' + tf(mn(r.s)) + ' – ' + tf(mn(r.e)) + ' · ' + daysLabel(r.days) + '</div></div><button class="x"' + C('delRoutine', r.id) + '>×</button></div>').join('');
  const rdc = [1, 2, 3, 4, 5, 6, 0].map((d) => '<label><input type="checkbox" class="rchk" value="' + d + '" checked>' + DN[d][0] + '<br>' + DN[d].slice(1) + '</label>').join('');
  const routine = '<div class="card"><h3>🍽 Daily routine</h3><div class="s" style="margin-bottom:8px">Meals, chores, gym, commute. Study time is planned around these.</div>' + (rows || '<div class="empty" style="padding:8px">Nothing yet.</div>') +
    (st.routines.length ? '' : '<button class="btn sec" style="margin:8px 0"' + C('addTypical') + '>Add a typical day (meals, chores, wind down)</button>') +
    '<h3 style="margin-top:12px">Add one</h3><input id="rn" placeholder="e.g. Lunch, Gym, Commute"><div class="days">' + rdc + '</div><div class="row"><input type="time" id="rs"><input type="time" id="re"></div><button class="btn"' + C('addRoutine') + '>Add to my routine</button><div id="rmsg" class="s" style="color:var(--bad);margin-top:6px"></div></div>';
  const planner = '<details class="card" open><summary>Planner settings</summary>' +
    '<div class="row"><div>Day starts<input type="time" id="cfs" value="' + c.ds + '"' + CH('setCfg') + '></div><div>Day ends<input type="time" id="cfe" value="' + c.de + '"' + CH('setCfg') + '></div></div>' +
    'My pace<select id="cfp"' + CH('setCfg') + '>' + [[1, 'Normal (1x)'], [1.25, 'A bit slower (1.25x)'], [1.5, 'Slower (1.5x)'], [2, 'Much slower (2x)']].map((p) => '<option value="' + p[0] + '"' + (p[0] === c.pace ? ' selected' : '') + '>' + p[1] + '</option>').join('') + '</select>' +
    'Max study hours per day<input type="number" id="cfc" min="1" max="12" value="' + c.cap + '"' + CH('setCfg') + '>' +
    'Daily focus goal (minutes)<input type="number" id="cfg2" min="10" max="600" value="' + (c.goal || 90) + '"' + CH('setCfg') + '>' +
    'Getting ready time after day start (minutes)<input type="number" id="cfp2" min="0" max="240" value="' + (c.prep === undefined ? 30 : c.prep) + '"' + CH('setCfg') + '>' +
    'Buffer around classes (minutes)<input type="number" id="cfb" min="0" max="60" value="' + (c.buf === undefined ? 10 : c.buf) + '"' + CH('setCfg') + '>' +
    'Plan study time at most this far before a due date<select id="cfa"' + CH('setCfg') + '>' + [[3, '3 days before'], [5, '5 days before'], [7, '1 week before'], [14, '2 weeks before'], [0, 'No limit (start as early as possible)']].map((o) => '<option value="' + o[0] + '"' + ((c.ahead === undefined ? 7 : +c.ahead) === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select>' +
    '<div class="s">Task estimates are multiplied by your pace, so a 1 hour task at 1.5x is planned as 1.5 hours.</div></details>';
  const days = '<div class="card"><h3>Hours by day</h3><div class="s" style="margin-bottom:8px">Change a day if it works differently, like a light Friday. Set max to 0 for a rest day.</div><div class="dgrid dh"><span></span><span>Start</span><span>End</span><span>Max h</span><span></span></div>' +
    [1, 2, 3, 4, 5, 6, 0].map((wd) => {
      const o = (c.days || {})[wd] || {}, mod = !!(o.ds || o.de || o.cap !== undefined);
      return '<div class="dgrid"><b' + (mod ? ' style="color:var(--pri)"' : '') + '>' + DN[wd] + '</b><input type="time" id="ds' + wd + '" value="' + (o.ds || c.ds) + '"' + CH('setDayCfg', wd) + '><input type="time" id="de' + wd + '" value="' + (o.de || c.de) + '"' + CH('setDayCfg', wd) + '><input type="number" id="dc' + wd + '" min="0" max="14" step="0.5" value="' + (o.cap !== undefined ? o.cap : c.cap) + '"' + CH('setDayCfg', wd) + '>' + (mod ? '<button class="x" title="Reset"' + C('resetDay', wd) + '>↺</button>' : '<span></span>') + '</div>';
    }).join('') + '</div>';
  return '<div class="cols"><div>' + theme + feel + routine + '</div><div>' + planner + days + '</div></div>';
}

/* ---------- AI ---------- */
/* ================= AI providers: Gemini (free tier) or Claude ================= */
const GEM = 'https://generativelanguage.googleapis.com/v1beta';
const GEM_ORIGIN = 'https://generativelanguage.googleapis.com/*';
let aiCheck = null; // result of the last "Save & test": { ok, text }
function aiProvider() { const c = st.cfg; return c.aiProvider || (c.geminiKey ? 'gemini' : c.aiKey ? 'claude' : 'gemini'); }
function aiReady() { return aiProvider() === 'gemini' ? !!st.cfg.geminiKey : !!st.cfg.aiKey; }
function aiName() { return aiProvider() === 'gemini' ? 'Gemini' : 'Claude'; }
function gemErr(status, j) {
  const msg = (j && j.error && j.error.message) || ('HTTP ' + status);
  if (/API key not valid|API_KEY_INVALID/i.test(msg)) return new Error('Gemini says this API key is not valid. Copy it again from aistudio.google.com/apikey (it starts with "AIza").');
  if (status === 429) return new Error('Gemini\'s free limit is used up for the moment. Wait a minute and try again (limits reset every minute and every day).');
  if (status === 403) return new Error('Gemini refused the request: ' + msg + ' If you are signed in with a school Google account, make the key with a personal one.');
  if (/location is not supported|User location/i.test(msg)) return new Error('Gemini isn\'t available in your region yet. You can use a Claude key instead (AI tab).');
  return new Error('Gemini error: ' + msg);
}
async function geminiModels(key) {
  let r;
  try { r = await fetch(GEM + '/models?pageSize=200', { headers: { 'x-goog-api-key': key } }); }
  catch (e) { throw new Error('Could not reach Gemini. Check your internet connection.'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw gemErr(r.status, j);
  return (j.models || []).filter((m) => (m.supportedGenerationMethods || []).indexOf('generateContent') > -1).map((m) => String(m.name).replace(/^models\//, ''));
}
// Model names change every few months, so pick the newest general-purpose Flash model the key can use.
function pickFlash(names) {
  const ver = (n) => +((n.match(/gemini-(\d+(?:\.\d+)?)/) || [0, 0])[1]);
  const good = names.filter((n) => /^gemini-.*flash/.test(n) && !/lite|image|tts|live|audio|embed|robot|omni|preview|exp/.test(n));
  good.sort((a, b) => ver(b) - ver(a) || a.length - b.length);
  return good[0] || names.find((n) => /flash/.test(n)) || names[0] || '';
}
async function callGemini(prompt, docs, retried) {
  const key = st.cfg.geminiKey, model = st.cfg.geminiModel || 'gemini-flash-latest';
  const body = {
    contents: [{ role: 'user', parts: (docs || []).map((d) => ({ inline_data: { mime_type: 'application/pdf', data: d } })).concat([{ text: prompt }]) }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.4, maxOutputTokens: 8192 }
  };
  let r;
  try {
    r = await fetch(GEM + '/models/' + encodeURIComponent(model) + ':generateContent', { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) });
  } catch (e) { throw new Error('Could not reach Gemini. Check your internet connection.'); }
  const j = await r.json().catch(() => ({}));
  if (r.status === 404 && !retried) { // model retired or renamed: switch to a current one and retry once
    const m = pickFlash(await geminiModels(key));
    if (!m || m === model) throw gemErr(404, j);
    st.cfg.geminiModel = m; save();
    return callGemini(prompt, docs, true);
  }
  if (!r.ok) throw gemErr(r.status, j);
  const c = (j.candidates || [])[0];
  if (!c) throw new Error('Gemini returned no answer' + (j.promptFeedback && j.promptFeedback.blockReason ? ' (blocked: ' + j.promptFeedback.blockReason + ')' : '') + '. Try rephrasing.');
  const text = ((c.content || {}).parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join('');
  if (!text) throw new Error(c.finishReason === 'MAX_TOKENS' ? 'The answer got too long. Try a shorter text.' : 'Gemini gave an empty answer (' + (c.finishReason || 'unknown reason') + '). Try again.');
  return text;
}
async function callClaude(prompt, docs) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': st.cfg.aiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify({ model: st.cfg.aiModel || 'claude-haiku-5-5', max_tokens: 8000, messages: [{ role: 'user', content:
      (docs || []).map((d) => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: d } })).concat([{ type: 'text', text: prompt }]) }] })
  }).catch(() => { throw new Error('Could not reach Claude. Check your internet connection.'); });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Claude error: ' + ((j.error && j.error.message) || r.status));
  return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}
async function aiJSON(prompt, docs) {
  if (!aiReady()) throw new Error('Set up AI first: open the AI tab and follow "Get started with AI" (free with a Gemini key).');
  const text = aiProvider() === 'gemini' ? await callGemini(prompt, docs) : await callClaude(prompt, docs);
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) throw new Error('The AI reply was not in the expected format. Try again.');
  try { return JSON.parse(m[0]); } catch (e) { throw new Error('The AI reply was cut off or malformed. Try again.'); }
}

/* --- setup actions --- */
ACT.aiProv = (p) => { st.cfg.aiProvider = p; aiCheck = null; save(); render(); };
ACT.gemSave = () => {
  const k = ($('gk') || {}).value ? $('gk').value.trim() : '';
  if (!k) return toast('Paste your Gemini API key first');
  ext.permissions.request({ origins: [GEM_ORIGIN] }).then(async (ok) => {
    if (!ok) return toast('Could not get permission to talk to Gemini');
    aiCheck = { busy: true, text: 'Checking your key…' }; render();
    // Check the key with Google before saving it, so a typo never replaces a working key.
    let model;
    try {
      const models = await geminiModels(k);
      model = models.indexOf('gemini-flash-latest') > -1 ? 'gemini-flash-latest' : pickFlash(models);
      if (!model) throw new Error('This key has no text models available. Make a new key in AI Studio.');
    } catch (e) { aiCheck = { ok: false, text: e.message }; render(); setTimeout(() => { if ($('gk')) $('gk').value = k; }, 0); return; }
    st.cfg.geminiKey = k; st.cfg.geminiModel = model; st.cfg.aiProvider = 'gemini'; save();
    try {
      const r = await aiJSON('Reply with exactly this JSON: {"ok": true}');
      aiCheck = r && r.ok ? { ok: true, text: 'Gemini is connected (' + st.cfg.geminiModel + '). AI features are ready.' } : { ok: true, text: 'Key saved. The test answer looked odd, but features should work.' };
    } catch (e) { aiCheck = { ok: false, text: 'Key saved, but a test request failed: ' + e.message }; }
    render();
  });
};
ACT.gemTest = () => { if ($('gk')) $('gk').value = st.cfg.geminiKey; ACT.gemSave(); };
ACT.gemModel = () => { st.cfg.geminiModel = EL.value; save(); toast('Using ' + EL.value); };
ACT.gemForget = () => { if (!confirm('Remove the Gemini key from Triaj?')) return; st.cfg.geminiKey = ''; st.cfg.geminiModel = ''; aiCheck = null; save(); render(); };
ACT.saveKey = () => {
  const k = $('aik').value.trim();
  ext.permissions.request({ origins: ['https://api.anthropic.com/*'] }).then((ok) => {
    if (!ok) return toast('Permission was not granted');
    st.cfg.aiKey = k; st.cfg.aiModel = $('aim').value.trim() || 'claude-haiku-5-5';
    if (k) st.cfg.aiProvider = 'claude';
    save(); render(); toast(k ? 'Claude key saved' : 'Claude key removed');
  });
};

function aiGuideCard() {
  const c = st.cfg, prov = aiProvider(), ready = aiReady();
  const status = aiCheck ? '<div class="stbox ' + (aiCheck.busy ? 'info' : aiCheck.ok ? 'ok' : 'err') + '" style="margin-bottom:10px"><b>' + (aiCheck.busy ? '⏳ ' : aiCheck.ok ? '✅ ' : '❌ ') + esc(aiCheck.text) + '</b></div>' : '';
  const seg = '<div class="seg" style="margin:0 0 10px">' + [['gemini', 'Gemini (free)'], ['claude', 'Claude']].map((x) => '<button class="' + (prov === x[0] ? 'on' : '') + '"' + C('aiProv', x[0]) + '>' + x[1] + '</button>').join('') + '</div>';
  let body;
  if (prov === 'gemini') {
    if (!c.geminiKey) {
      body = '<ol class="steps">' +
        '<li><b>Open Google AI Studio</b>: <a class="lnk" href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey ↗</a> and sign in with a <b>personal</b> Google account (school accounts often have it switched off).</li>' +
        '<li>Accept the terms if asked, then press <b>Create API key</b>. If it asks for a project, let it create one.</li>' +
        '<li><b>Copy the key</b> (it starts with <code>AIza</code>) and paste it here:</li></ol>' +
        '<input id="gk" type="password" placeholder="AIza…" autocomplete="off"' + EN('gemSave') + '><button class="btn"' + C('gemSave') + '>Save & test</button>' +
        '<div class="s" style="margin-top:10px">• Free: no credit card. There are limits per minute and per day; if you hit one, wait a minute.<br>• The key is saved with your planner (in your account, readable only by you) and is sent only to Google.<br>• On the free tier Google may use what you send to improve its products, so don\'t paste anything private (like passwords or ID numbers). Your tasks and syllabi are fine for most people; turn AI off by removing the key.</div>';
    } else {
      const models = [c.geminiModel || 'gemini-flash-latest'];
      body = '<div class="s" style="margin-bottom:6px">Key saved · model <code>' + esc(c.geminiModel || 'gemini-flash-latest') + '</code></div>' +
        '<div class="btnrow"><button class="btn sm"' + C('gemTest') + '>Test again</button><button class="btn sm sec"' + C('gemForget') + '>Remove key</button></div>' +
        '<details style="margin-top:8px"><summary class="s">Change key or model</summary><input id="gk" type="password" placeholder="New key (AIza…)"><button class="btn sm"' + C('gemSave') + '>Save & test</button>' +
        '<span class="lbl" style="margin-top:8px">Model (leave as is unless something breaks)</span><input value="' + esc(c.geminiModel || '') + '" placeholder="gemini-flash-latest"' + CH('gemModel') + '></details>';
      void models;
    }
  } else {
    body = '<div class="s" style="margin-bottom:8px">Uses your own key from <a class="lnk" href="https://console.anthropic.com" target="_blank" rel="noopener">console.anthropic.com ↗</a> (pay-as-you-go; typical use costs pennies a month). Saved with your planner, readable only by you.</div>' +
      '<input id="aik" type="password" placeholder="sk-ant-…" value="' + esc(c.aiKey) + '"><span class="lbl">Model</span><input id="aim" value="' + esc(c.aiModel || 'claude-haiku-5-5') + '"><button class="btn sm"' + C('saveKey') + '>Save</button>';
  }
  return '<div class="card' + (ready ? '' : ' hcard') + '"><h3>' + (ready ? '✨ AI: ' + aiName() + ' connected' : '✨ Get started with AI') + '</h3>' +
    (ready ? '' : '<div class="s" style="margin-bottom:10px">About 3 minutes, free with Google Gemini. Then the planner can plan your week, find exam dates in syllabi, turn course outlines into tasks and help when you\'re stuck.</div>') +
    seg + status + body + '</div>';
}
function aiUsesCard() {
  const on = aiReady();
  const row = (ic, title, how, btn) => '<div class="item"><div style="font-size:20px;width:26px">' + ic + '</div><div class="t"><b>' + title + '</b><div class="s">' + how + '</div></div>' + (btn || '') + '</div>';
  return '<div class="card"><h3>What AI can do here</h3>' +
    row('💬', 'Plan and prioritize', 'Ask "Plan my week" or "What should I do tonight?" below. It suggests changes; nothing changes until you press Apply.', on ? '<button class="btn sm sec"' + C('askQuick', 'Plan my week for me') + '>Try</button>' : '') +
    row('✍️', 'Add tasks by typing a sentence', 'e.g. "Midterm Friday, lab report due Monday" in the box below.') +
    row('📄', 'Find exam and deadline dates in syllabi', 'Reads the syllabus page and outline PDFs from Canvas, then you pick what to add.', '<button class="btn sm sec"' + C('go', 'sync') + '>Open</button>') +
    row('📥', 'Turn a pasted course outline into tasks', 'More → Import → paste the text.', '<button class="btn sm sec"' + C('go', 'import') + '>Open</button>') +
    row('🧩', 'Get unstuck', 'On the Now page, press "I\'m stuck" for a tiny first step.', '<button class="btn sm sec"' + C('go', 'now') + '>Open</button>') +
    '</div>';
}

async function breakDown(tid) {
  const t = st.tasks.find((x) => x.id === tid); if (!t) return;
  stuck = { tid, text: 'Thinking…' }; render();
  try {
    const c = cls(t.cls);
    const r = await aiJSON('A student who gets distracted easily is stuck starting this task: "' + t.t + '"' + (c ? ' for the class ' + c.n : '') + '. Give ONE tiny first step that takes under 5 minutes and needs no thinking (like opening the file, writing the title, or copying problem 1), then up to 3 more small steps. Reply ONLY with JSON: {"first": string, "steps": [string]}');
    stuck = { tid, text: 'Start here: ' + r.first + ((r.steps && r.steps.length) ? '\nThen: ' + r.steps.join(' → ') : '') };
  } catch (e) { stuck = { tid, text: 'Try this: open your materials and write down just the first question or heading. That counts as starting. Then hit "Just 5 minutes".' + (aiReady() ? '' : '\n(Set up AI in the AI tab for step-by-step help. It\'s free with Gemini.)') }; }
  render();
}
function descAct(a) {
  if (a.type === 'add_task') return 'Add task: ' + a.title + (a.due ? ' (due ' + a.due + ')' : '') + (a.class ? ' · ' + a.class : '') + ' · ~' + dur(a.estMinutes || 60) + ' · ' + (PR[a.priority] || 'Medium');
  const t = st.tasks.find((x) => x.id === a.id), n = t ? t.t : 'task';
  return a.type === 'set_priority' ? 'Set priority of "' + n + '" to ' + (PR[a.priority] || '?') : 'Set estimate of "' + n + '" to ' + dur(a.estMinutes || 60);
}
function validAct(a) {
  if (!a || typeof a !== 'object') return false;
  if (a.type === 'add_task') return !!a.title;
  const has = st.tasks.some((x) => x.id === a.id);
  if (a.type === 'set_priority') return has && !!PR[a.priority];
  if (a.type === 'set_estimate') return has && a.estMinutes > 0;
  return false;
}
async function askAI(q) {
  q = (q || ($('aiq') ? $('aiq').value : '')).trim();
  if (!q || aiBusy) return;
  aiLog.push({ r: 'u', t: q }); aiBusy = true; aiProps = []; render();
  try {
    const by = {}; let inc = 0;
    st.tx.filter((x) => x.d.slice(0, 7) === todayS.slice(0, 7)).forEach((x) => { if (x.type === 'in') inc += x.a; else by[x.c] = (by[x.c] || 0) + x.a; });
    const fb = focusTotals();
    const ctx = {
      today: todayS, weekday: DN[new Date().getDay()], paceMultiplier: st.cfg.pace, maxStudyHoursPerDay: st.cfg.cap, focusMinutesToday: (fb[todayS] || {}).m || 0,
      classes: st.classes.map((c) => ({ name: c.n, times: c.slots.map((x) => DN[x.day] + ' ' + x.s + '-' + x.e) })),
      openTasks: st.tasks.filter((t) => !t.done).map((t) => ({ id: t.id, title: t.t, due: t.d || null, inClass: !!t.inClass, cantStartYet: isBlocked(st, t) ? blockText(t, blockState(st, t)) : null, priority: PR[t.p], class: (cls(t.cls) || {}).n || null, estMinutes: t.fixed || t.est || 60, spentMinutes: t.spent || 0 })),
      thisMonthIncome: inc, thisMonthSpendingByCategory: by
    };
    const hist = aiLog.slice(-7, -1).map((m) => (m.r === 'u' ? 'User: ' : 'Assistant: ') + m.t).join('\n');
    const r = await aiJSON('You are the assistant inside an engineering student\'s planner app. The student works slowly and needs extra time. Be concise and practical (under 150 words, plain text, no markdown).\nData: ' + JSON.stringify(ctx) + '\nConversation so far:\n' + hist + '\nUser: ' + q +
      '\nReply ONLY with JSON: {"reply": string, "actions": array}. Allowed actions: {"type":"add_task","title":string,"due":"YYYY-MM-DD or empty string","priority":"h"|"m"|"l","class":"exact class name or empty string","estMinutes":number}, {"type":"set_priority","id":number,"priority":"h"|"m"|"l"}, {"type":"set_estimate","id":number,"estMinutes":number}. Only include actions when the user asks to add or change tasks, or asks to prioritize. Resolve relative dates like "Friday" using today. Use [] when no changes are needed.');
    aiLog.push({ r: 'a', t: r.reply || 'Done.' });
    aiProps = (r.actions || []).filter(validAct);
  } catch (e) { aiLog.push({ r: 'a', t: e.message }); }
  aiBusy = false; render();
}
function applyAI() {
  aiProps.forEach((a) => {
    if (a.type === 'add_task') {
      const c = st.classes.find((x) => x.n.toLowerCase() === String(a.class || '').toLowerCase());
      st.tasks.push({ id: newId(), t: String(a.title), d: a.due || '', p: PR[a.priority] ? a.priority : 'm', cls: c ? c.id : 0, est: +a.estMinutes || 60, fixed: 0, done: false, spent: 0 });
    } else st.tasks.forEach((t) => { if (t.id === a.id) { if (a.type === 'set_priority') t.p = a.priority; else t.est = +a.estMinutes; } });
  });
  aiLog.push({ r: 'a', t: 'Applied ' + aiProps.length + ' change(s).' });
  aiProps = []; save(); render();
}
function viewAI() {
  const quick = ['Auto-prioritize my tasks', 'Plan my week for me', 'What should I do tonight?', 'Is my week too packed?', 'Where did my money go this month?'];
  const log = aiLog.map((m) => '<div class="card" style="' + (m.r === 'u' ? 'background:var(--soft)' : '') + '">' + esc(m.t).replace(/\n/g, '<br>') + '</div>').join('');
  const props = aiProps.length ? '<div class="card"><h3>Proposed changes</h3>' + aiProps.map((a) => '<div class="item"><div class="t">' + esc(descAct(a)) + '</div></div>').join('') + '<div class="row" style="margin-top:8px"><button class="btn"' + C('applyAI') + '>Apply all</button><button class="btn mute"' + C('dismissAI') + '>Dismiss</button></div></div>' : '';
  const chat = '<div class="card"><div class="s" style="margin-bottom:8px">Ask about your tasks, week, or budget, or tell me to add tasks. I always ask before changing anything.</div>' +
    '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">' + quick.map((q) => '<button class="pill"' + C('askQuick', q) + '>' + q + '</button>').join('') + '</div>' +
    '<input id="aiq" placeholder="e.g. Midterm Friday, lab report due Monday"' + EN('askAI', '') + '><button class="btn"' + C('askAI', '') + (aiBusy ? ' disabled' : '') + '>' + (aiBusy ? 'Thinking…' : 'Send') + '</button></div>';
  const backup = '<div class="card"><h3>📋 Use another AI</h3><div class="s" style="margin-bottom:8px">Copy everything (tasks, schedule, classes) as short text for ChatGPT, Claude, Gemini or an AI agent.</div><div class="btnrow"><button class="btn"' + C('axCopy') + '>📋 Copy for AI</button><button class="btn sec"' + C('go', 'export') + '>Options</button></div></div>' +
    '<div class="card"><h3>🛟 Backup & restore</h3><div class="s" style="margin-bottom:8px">Daily backups, restoring, and undoing changes now live in More → Backups.</div><button class="btn sec"' + C('go', 'backup') + '>Open Backups</button></div>';
  const setup = aiGuideCard();
  if (!aiReady()) return '<div class="cols"><div>' + setup + '</div><div>' + aiUsesCard() + backup + '</div></div>';
  return '<div class="cols"><div>' + chat + props + log + '</div><div>' + setup + aiUsesCard() + backup + '</div></div>';
}

/* ================= export for AI ================= */
// One compact plain-text snapshot of everything (tasks, schedule, classes, routines, focus, budget) that any
// AI chat or agent can read. Short ids (#1, #2…) replace the long internal ids so dependencies stay readable.
const AX_DEF = { days: 14, plan: true, done: true, focus: true, budget: false, links: false, settings: true };
function axOpts() { return Object.assign({}, AX_DEF, st.cfg.ax || {}); }
function aiExport(o) {
  o = o || axOpts();
  const now = new Date(), L = [];
  const wd = (ds) => DN[new Date(ds + 'T00:00:00').getDay()];
  const dt = (ds, tm) => (ds ? ds + ' ' + wd(ds) + (tm ? ' ' + tm : '') : '-');
  const clean = (s) => String(s === undefined || s === null ? '' : s).replace(/[|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  const cn = (id) => { const c = cls(id); return c ? clean(c.n) : '-'; };
  const end = new Date(now); end.setDate(end.getDate() + (+o.days || 14));
  const endS = iso(end);
  // Short ids: open tasks by due date first, then recently done ones.
  const open = sorted(st.tasks.filter((t) => !t.done));
  const doneCut = new Date(now); doneCut.setDate(doneCut.getDate() - 14);
  const done = o.done ? st.tasks.filter((t) => t.done && (t.doneAt || t.d || '') >= iso(doneCut)).sort((a, b) => ((b.doneAt || b.d || '') < (a.doneAt || a.d || '') ? -1 : 1)) : [];
  const sid = new Map();
  open.concat(done).forEach((t, i) => sid.set(t.id, '#' + (i + 1)));
  const ref = (id) => sid.get(id) || '?';

  L.push('MY PLANNER EXPORT ' + todayS + ' ' + DN[now.getDay()] + ' ' + hm(now.getHours() * 60 + now.getMinutes()) + ' (' + (Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time') + ')');
  L.push('KEY: dates YYYY-MM-DD, times 24h, P=priority H/M/L, left=minutes of work remaining, fields split by |, - = none');
  if (o.settings) {
    const c = st.cfg;
    L.push('SETTINGS: study day ' + c.ds + '-' + c.de + ', max ' + c.cap + 'h study/day, works at ' + c.pace + 'x estimated time, plans up to ' + (c.ahead || 0) + 'd ahead, focus goal ' + c.goal + 'm/day' +
      (st.canvas.host ? ', Canvas ' + st.canvas.host + ' synced ' + (st.canvas.lastSync ? (() => { const d = new Date(st.canvas.lastSync); return iso(d) + ' ' + hm(d.getHours() * 60 + d.getMinutes()); })() : 'never') : ''));
  }

  if (st.classes.length) {
    L.push('', 'CLASSES (weekly)');
    st.classes.forEach((c) => {
      const g = {};
      c.slots.slice().sort((a, b) => a.day - b.day).forEach((s) => { const k = s.s + '-' + s.e + (s.loc ? ' @' + clean(s.loc) : ''); (g[k] = g[k] || []).push(DN[s.day]); });
      L.push(clean(c.n) + ': ' + (Object.keys(g).map((k) => (g[k].length === 7 ? 'daily' : g[k].join(',')) + ' ' + k).join('; ') || 'no times set'));
    });
  }
  if (st.routines.length) {
    L.push('', 'ROUTINES (repeat)');
    st.routines.slice().sort((a, b) => mn(a.s) - mn(b.s)).forEach((r) => L.push(clean(r.name) + ': ' + ((r.days || []).length === 7 ? 'daily' : (r.days || []).slice().sort().map((d) => DN[d]).join(',')) + ' ' + r.s + '-' + r.e));
  }

  const conf = new Map(st.conflicts.map((c) => [c.id, c]));
  const notes = (t) => {
    const n = [];
    if (t.kind && t.kind !== 'assignment' && t.kind !== 'feed') n.push(KIND[t.kind] ? KIND[t.kind].toLowerCase() : t.kind);
    if (!t.done && t.d && t.d < todayS) n.push('OVERDUE');
    if (t.inClass) { const sl = inClassSlot(st, t); n.push('in class' + (sl ? ' ' + hm(sl.s) + '-' + hm(sl.e) : '')); }
    const bs = !t.done && t.block ? blockState(st, t) : null;
    if (bs && bs.blocked) {
      const b = t.block;
      n.push(b.kind === 'task' ? 'blocked until ' + bs.waiting.map((w) => ref(w.id)).join(',') + ' done'
        : b.kind === 'cond' ? 'waiting for: ' + clean(b.note) + (b.until ? ' (expected ' + b.until + ')' : '')
        : 'snoozed' + (b.until ? ' until ' + b.until : '') + (b.note ? ' (' + clean(b.note) + ')' : ''));
    }
    if (t.opens && t.opens > todayS) n.push('opens ' + t.opens + (t.opensTime ? ' ' + t.opensTime : ''));
    else if (t.locked) n.push('locked');
    if (conf.has(t.id)) n.push('Canvas now says due ' + (conf.get(t.id).theirs || 'none'));
    if (!t.done && t.spent) n.push(t.spent + 'm done');
    if (o.links && t.url) n.push(t.url);
    return n.join('; ') || '-';
  };
  L.push('', 'OPEN TASKS (' + open.length + ') id|due|class|title|P|left|notes');
  open.forEach((t) => L.push([ref(t.id), dt(t.d, t.time), cn(t.cls), clean(t.t), (t.p || 'm').toUpperCase(), t.inClass ? 0 : remaining(t), notes(t)].join('|')));
  if (!open.length) L.push('none');

  if (st.held.length) {
    L.push('', 'NOT YET RELEASED (joins list on unlock) unlocks|due|class|title');
    st.held.slice().sort((a, b) => (a.hold < b.hold ? -1 : 1)).forEach((h) => L.push([h.hold || '-', dt(h.d, h.time), cn(h.cls), clean(h.t)].join('|')));
  }
  if (done.length) {
    L.push('', 'DONE LAST 14D id|done|class|title');
    done.forEach((t) => L.push([ref(t.id), t.doneAt || t.d || '-', cn(t.cls), clean(t.t)].join('|')));
  }

  // Day-by-day calendar: one-off items only (classes and routines repeat, see above).
  const plan = o.plan ? autoPlan(endS).out : {};
  const days = [];
  for (let d = new Date(now.getFullYear(), now.getMonth(), now.getDate()); iso(d) <= endS; d.setDate(d.getDate() + 1)) {
    const ds = iso(d), it = [];
    st.events.filter((e) => e.d === ds).forEach((e) => it.push({ s: e.allDay ? -1 : e.s, x: (e.allDay ? 'all day' : hm(e.s) + '-' + hm(e.e)) + ' ' + clean(e.title) }));
    st.blocks.filter((b) => b.d === ds).forEach((b) => it.push({ s: mn(b.s), x: b.s + '-' + b.e + ' ' + clean(b.t) }));
    st.tasks.filter((t) => t.inClass && !t.done && t.d === ds).forEach((t) => { const sl = inClassSlot(st, t); it.push({ s: sl ? sl.s : 0, x: (sl ? hm(sl.s) + '-' + hm(sl.e) + ' ' : '') + 'in-class ' + ref(t.id) + ' ' + clean(t.t) }); });
    (plan[ds] || []).forEach((p) => it.push({ s: p.s, x: hm(p.s) + '-' + hm(p.e) + ' study ' + ref(p.t.id) }));
    if (it.length) days.push(ds + ' ' + wd(ds) + ': ' + it.sort((a, b) => a.s - b.s).map((x) => x.x).join('; '));
  }
  L.push('', 'CALENDAR next ' + (+o.days || 14) + 'd (events, your blocks, in-class tests' + (o.plan ? ', planned study time' : '') + '; classes/routines not repeated)');
  L.push(...(days.length ? days : ['nothing scheduled']));

  if (o.focus) {
    const by = focusTotals(), f = [];
    let tot = 0;
    for (let i = 6; i >= 0; i--) { const d = new Date(now); d.setDate(d.getDate() - i); const m = (by[iso(d)] || {}).m || 0; tot += m; f.push(DN[d.getDay()] + ' ' + m); }
    L.push('', 'FOCUS MINUTES last 7d: ' + f.join(', ') + ' (total ' + tot + ', goal ' + st.cfg.goal + '/day)');
  }
  if (o.budget) {
    const key = todayS.slice(0, 7), by = {};
    let inc = 0, out = 0;
    st.tx.filter((x) => (x.d || '').slice(0, 7) === key).forEach((x) => { if (x.type === 'in') inc += x.a; else { out += x.a; by[x.c] = (by[x.c] || 0) + x.a; } });
    L.push('', 'BUDGET ' + key + ': income ' + inc.toFixed(2) + ', spent ' + out.toFixed(2) + (out ? ' (' + Object.keys(by).sort((a, b) => by[b] - by[a]).map((c) => c + ' ' + by[c].toFixed(2)).join(', ') + ')' : ''));
  }
  return L.join('\n') + '\n';
}
ACT.axSet = (k, v) => {
  const o = axOpts();
  o[k] = v === undefined ? (EL && EL.type === 'checkbox' ? EL.checked : !o[k]) : v;
  st.cfg.ax = o; save(); render();
};
ACT.axCopy = async () => {
  const txt = aiExport();
  try { await navigator.clipboard.writeText(txt); toast('Copied ✓ Paste it into any AI chat'); }
  catch (e) { const a = $('axout'); if (a) { a.focus(); a.select(); document.execCommand('copy'); toast('Copied ✓'); } else toast('Could not copy'); }
};
ACT.axSave = () => {
  const url = blobUrl(aiExport(), 'text/plain');
  const a = document.createElement('a'); a.href = url; a.download = 'planner-for-ai-' + todayS + '.txt';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
};
function viewExport() {
  const o = axOpts(), txt = aiExport(o);
  const chk = (k, l) => '<div class="check"><input type="checkbox" id="ax_' + k + '"' + (o[k] ? ' checked' : '') + CH('axSet', k) + '><label for="ax_' + k + '">' + l + '</label></div>';
  const seg = '<div class="seg">' + [7, 14, 30, 60].map((n) => '<button class="' + (+o.days === n ? 'on' : '') + '"' + C('axSet', 'days', n) + '>' + n + ' days</button>').join('') + '</div>';
  return '<div class="cols"><div><div class="card"><h3>📋 Export for AI</h3><div class="s" style="margin-bottom:10px">Everything in your planner as short plain text that ChatGPT, Claude, Gemini or any AI agent can read. Copy it and paste it into a chat, or save it as a .txt file. Nothing is sent anywhere.</div>' +
    '<div class="btnrow" style="margin-bottom:6px"><button class="btn"' + C('axCopy') + '>📋 Copy</button><button class="btn sec"' + C('axSave') + '>⬇ Save .txt</button></div>' +
    '<div class="s">' + txt.split('\n').length + ' lines · about ' + Math.ceil(txt.length / 4).toLocaleString() + ' tokens</div></div>' +
    '<div class="card"><h3>Include</h3><div class="s" style="margin-bottom:6px">Calendar range</div>' + seg +
    chk('plan', 'Planned study time (📚 blocks)') + chk('done', 'Tasks finished in the last 14 days') + chk('focus', 'Focus minutes (last 7 days)') +
    chk('settings', 'Settings (study hours, pace, daily limit)') + chk('budget', 'Budget this month') + chk('links', 'Canvas links (uses more tokens)') +
    '<div class="s" style="margin-top:6px">Open tasks, classes, routines, calendar events and locked items are always included. AI keys and Canvas tokens never are.</div></div></div>' +
    '<div><div class="card"><h3>Preview</h3><textarea id="axout" readonly style="min-height:420px;font-family:ui-monospace,Consolas,monospace;font-size:12px;white-space:pre;overflow:auto">' + esc(txt) + '</textarea></div></div></div>';
}

/* ================= render ================= */
function renderMini() {
  const m = $('mini');
  if (!m) return;
  if (timer.status === 'idle' || tab === 'focus' || (tab === 'now')) { m.innerHTML = ''; return; }
  const brk = timer.phase !== 'work';
  const name = brk ? LABEL[timer.phase] : (taskName(timer.tid) || 'Focus');
  m.innerHTML = '<div class="minibar' + (brk ? ' brk' : '') + '"' + C('go', 'focus') + '>⏱ <b id="ftime2">' + (timer.status === 'ready' ? 'Next: ' + LABEL[timer.phase] : fmtT(tLeft())) + '</b><span class="tt">' + esc(name) + '</span>' +
    (timer.status === 'running' ? '<button' + C('fOp', 'pause') + '>❚❚</button>' : timer.status === 'paused' ? '<button' + C('fOp', 'resume') + '>▶</button>' : '<button' + C('fOp', 'start') + '>▶</button>') + '</div>';
}
function renderSyncLabel() {
  const cv = st.canvas;
  const t = !cv.host ? (session.user ? '☁ saved to your account' : 'saved in this browser') : canvasPerm === false ? '🔑 Canvas access needed' : (cv.lastStatus && cv.lastStatus.kind === 'err') ? '⚠ Canvas sync problem' : '☁ Canvas synced ' + ago(cv.lastSync);
  const e = $('sync'); if (e) e.textContent = syncState.running ? '⏳ ' + (syncState.text || 'Syncing…') : syncBusy ? 'Syncing…' : t;
}
function render() {
  if (!ready) return;
  todayS = iso(new Date());
  document.querySelectorAll('nav button').forEach((b) => { const t = b.dataset.t; b.classList.toggle('on', t === tab || (t === 'more' && SUB.indexOf(tab) > -1)); });
  const V = { backup: viewBackup, files: viewFiles, now: viewNow, sched: viewSched, tasks: viewTasks, focus: viewFocus, ai: viewAI, more: viewMore, budget: viewBudget, classes: viewClasses, settings: viewSettings, sync: viewSync, import: viewImport, export: viewExport };
  const back = SUB.indexOf(tab) > -1 ? '<button class="backbtn"' + C('go', 'more') + '>More</button>' : '';
  const vw = $('view'), y = window.scrollY;
  vw.innerHTML = (back + (V[tab] || viewNow)()).replace(/(<h3[^>]*>)(?:[\p{Extended_Pictographic}\u2190-\u21FF\u2600-\u27BF][\uFE0F\u200D]?)+\s*/gu, '$1') + '<footer>Triaj · ' + (session.user ? 'synced to your account' : 'saved in this browser') + ' · <a class="lnk" href="#"' + C('go', 'sync') + '>sync settings</a></footer>';
  if (tab !== lastTab) { vw.classList.remove('fade'); void vw.offsetWidth; vw.classList.add('fade'); } else window.scrollTo(0, y);
  lastTab = tab;
  renderMini(); renderSyncLabel();
  document.title = timer.status === 'running' ? fmtT(tLeft()) + ' · ' + (timer.phase === 'work' ? 'Focus' : 'Break') : 'Triaj';
}

/* ================= effects ================= */
function toast(msg) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t);
  setTimeout(() => t.classList.add('out'), 2200); setTimeout(() => t.remove(), 2700);
}
function burst() {
  if (st.cfg.sound !== false) playSound('chime', 0.4);
  if (st.cfg.fx === false || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
  const e = window.event, x = e && e.clientX ? e.clientX : window.innerWidth / 2, y = e && e.clientY ? e.clientY : window.innerHeight / 2;
  const cols = ['#f43f5e', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7'];
  for (let i = 0; i < 18; i++) {
    const p = document.createElement('i'), a = Math.random() * 6.28, d = 40 + Math.random() * 80;
    p.className = 'conf';
    p.style.cssText = 'left:' + x + 'px;top:' + y + 'px;background:' + cols[i % 5] + ';--dx:' + (Math.cos(a) * d) + 'px;--dy:' + (Math.sin(a) * d - 40) + 'px';
    document.body.appendChild(p); setTimeout(() => p.remove(), 900);
  }
}
let rsT = null;
window.addEventListener('resize', () => { clearTimeout(rsT); rsT = setTimeout(() => { if (!typing() && (tab === 'sched' || tab === 'now')) render(); }, 250); });

// Live clock for the timer display.
setInterval(() => {
  if (timer.status === 'running') {
    const left = tLeft();
    ['ftime', 'ftime2'].forEach((id) => { const e = $(id); if (e) e.textContent = fmtT(left); });
    const fr = $('fring'); if (fr && timer.total) fr.style.strokeDashoffset = String(+fr.dataset.c * (1 - left / timer.total));
    document.title = fmtT(left) + ' · ' + (timer.phase === 'work' ? 'Focus' : 'Break');
    if (left <= 0) send({ cmd: 'timer', op: 'tick' });
  }
  if (iso(new Date()) !== todayS && !typing()) render();
}, 1000);
setInterval(() => { const d = sweepInClass(st); if (d.length) { const r = sweepBlocks(st); save(); softRender(); readyToast(r); } }, 60000);
setInterval(() => { if (!typing()) renderSyncLabel(); }, 30000);

/* ================= boot ================= */
(async () => {
  const d = await ext.storage.local.get(['plan', 'timer', 'syncState', 'dlog']);
  dlog = d.dlog || {};
  loadBk();
  syncState = d.syncState && d.syncState.running && Date.now() - d.syncState.at < 120000 ? d.syncState : { running: false };
  st = normalize(d.plan);
  timer = d.timer || { status: 'idle', phase: 'work' };
  if (!d.plan) {
    save();
  }
  const h = (location.hash || '').slice(1);
  if (h && (['now', 'sched', 'tasks', 'focus', 'files', 'ai', 'more'].concat(SUB)).indexOf(h) > -1) tab = h;
  window.addEventListener('hashchange', () => { const x = (location.hash || '').slice(1); if (x && x !== tab && (['now', 'sched', 'tasks', 'focus', 'files', 'ai', 'more'].concat(SUB)).indexOf(x) > -1) ACT.go(x); });
  if (st.cfg.sv) sv = st.cfg.sv;
  applyTheme();
  const icd = sweepInClass(st);
  const freed = sweepBlocks(st);
  if (icd.length) save();
  if (freed.length) save();
  ready = true;
  render();
  readyToast(freed);
  checkCanvasPerm();
})();
