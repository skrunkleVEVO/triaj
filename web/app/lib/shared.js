// Shared data model, storage, calendar parsing and sync-merge logic.
// Used by the planner page and its engine (which took over from the extension's background worker).
import { ext } from './platform.js';

export const PAL = ['#6d28d9', '#0e7490', '#c2410c', '#15803d', '#be185d', '#1d4ed8', '#a16207'];

export const PRESETS = [
  { id: 'pomo', name: 'Pomodoro', work: 25, short: 5, long: 15, rounds: 4 },
  { id: 'deep', name: 'Deep work', work: 50, short: 10, long: 30, rounds: 3 },
  { id: 'sprint', name: 'Sprints', work: 15, short: 3, long: 10, rounds: 4 },
  { id: 'gentle', name: 'Gentle start', work: 10, short: 5, long: 15, rounds: 3 }
];

export const TIMER_DEFAULTS = {
  presets: PRESETS,
  presetId: 'pomo',
  autoBreak: true,      // start the break automatically when focus ends
  autoWork: false,      // start the next focus automatically when a break ends
  refocus: 10,          // gentle nudge every N minutes during focus (0 = off)
  refocusSound: 'nudge',
  refocusNotify: false,
  endSound: 'chime',
  breakSound: 'marimba',
  volume: 0.7,
  ambient: 'none',
  ambientVol: 0.25,
  notify: true,
  badge: true
};

export const CFG_DEFAULTS = {
  ds: '08:00', de: '22:00', pace: 1.5, cap: 5, goal: 90, prep: 30, buf: 10, ahead: 7,
  theme: 'ink', mode: 'auto', paper: 'dots', fx: true, sound: true,
  digest: true, digestTime: '08:00',
  aiKey: '', aiModel: 'claude-haiku-5-5', aiProvider: '', geminiKey: '', geminiModel: ''
};

export const CANVAS_DEFAULTS = {
  host: '', token: '', auto: true, interval: 60,
  assign: true, modReq: true, modOther: false, skipPast: true, syl: true,
  autoClasses: true, autoComplete: true,
  excluded: [], courses: [], syllabi: [],
  lastSync: '', lastStatus: null
};

export function blankState() {
  return {
    tasks: [], tx: [], classes: [], blocks: [], focus: [], routines: [], held: [],
    events: [], feeds: [], conflicts: [], dismissed: [],
    cfg: {}, canvas: {}, rev: 0
  };
}

export function normalize(o) {
  const st = Object.assign(blankState(), o || {});
  st.cfg = Object.assign({}, CFG_DEFAULTS, st.cfg || {});
  st.cfg.timer = Object.assign({}, TIMER_DEFAULTS, st.cfg.timer || {});
  if (!Array.isArray(st.cfg.timer.presets) || !st.cfg.timer.presets.length) st.cfg.timer.presets = PRESETS.slice();
  st.canvas = Object.assign({}, CANVAS_DEFAULTS, st.canvas || {});
  ['tasks', 'tx', 'classes', 'blocks', 'focus', 'routines', 'held', 'events', 'feeds', 'conflicts', 'dismissed'].forEach((k) => {
    if (!Array.isArray(st[k])) st[k] = [];
  });
  // v2.0 used one id per assignment type; v2.1 uses canvas:a:<assignment id> for all of them.
  const mig = (u) => (typeof u === 'string' ? u.replace(/^canvas:(assignment|quiz|discussion):/, 'canvas:a:') : u);
  st.tasks.forEach((t) => { if (t.uid) t.uid = mig(t.uid); });
  st.held.forEach((t) => { if (t.uid) t.uid = mig(t.uid); });
  st.conflicts.forEach((c) => { c.uid = mig(c.uid); });
  st.dismissed = st.dismissed.map(mig);
  if (!st.canvas.sylDone || typeof st.canvas.sylDone !== 'object') st.canvas.sylDone = {};
  // Triaj 3: Ink replaces purple as the default look (only for people who never picked a color).
  if (!st.cfg.themeV) { if (st.cfg.theme === 'purple' && !st.cfg.themePicked) st.cfg.theme = 'ink'; st.cfg.themeV = 3; }
  return st;
}

/* ---------- storage ---------- */
export async function loadPlan() {
  const d = await ext.storage.local.get('plan');
  return normalize(d.plan);
}
export async function savePlan(st, who) {
  st.rev = (st.rev || 0) + 1;
  st.by = who || 'bg';
  await ext.storage.local.set({ plan: st });
  return st.rev;
}
// Read, change and write in one go so background jobs never work on stale data.
export async function updatePlan(fn, who) {
  const st = await loadPlan();
  const r = await fn(st);
  await savePlan(st, who);
  return r;
}

/* ---------- small helpers ---------- */
let seq = 0;
export function newId() { seq = (seq + 1) % 1000; return Date.now() * 1000 + seq; }
export function p2(n) { return String(n).padStart(2, '0'); }
export function iso(d) { return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
export function todayIso() { return iso(new Date()); }
export function mn(t) { const p = String(t || '0:0').split(':'); return +p[0] * 60 + +p[1]; }
export function hm(m) { return p2(Math.floor(m / 60)) + ':' + p2(m % 60); }
export function need(t, pace) { return t.fixed > 0 ? t.fixed : Math.ceil((t.est || 60) * (pace || 1)); }
export function remainingMin(t, pace) { return Math.max(0, need(t, pace) - (t.spent || 0)); }

export function guessTask(title, kind) {
  kind = String(kind || '');
  const ex = kind === 'exam' || /exam|midterm|final/i.test(title), qz = kind === 'quiz' || /quiz|test/i.test(title);
  const rd = /read|chapter|video|watch|module/i.test(title) || /page|file/.test(kind);
  if (ex) return { est: 180, p: 'h' };
  if (qz) return { est: 60, p: 'h' };
  if (kind === 'note') return { est: 30, p: 'm' };
  if (kind === 'discussion' || kind === 'peer review') return { est: 45, p: 'm' };
  return { est: rd ? 30 : 90, p: 'm' };
}

export function lockState(i, today) {
  const u = i.unlockAt || '', lk = i.lockAt || '';
  if (u && u > today) return { s: 'held', date: u };
  if (lk && lk < today) return { s: 'closed' };
  if (i.locked && u !== today) return { s: 'locked' };
  return { s: 'open' };
}

/* ---------- classes ---------- */
export function matchClass(st, name, canvasId, autoCreate) {
  if (canvasId) {
    const byId = st.classes.find((c) => c.canvasId && String(c.canvasId) === String(canvasId));
    if (byId) return byId.id;
  }
  if (!name) return 0;
  const n = name.toLowerCase(), w = n.split(/\s+/).slice(0, 2).join(' ');
  const c = st.classes.find((c) => { const k = c.n.toLowerCase(); return n.indexOf(k) > -1 || k.indexOf(n) > -1; }) ||
    st.classes.find((c) => c.n.toLowerCase().indexOf(w) === 0);
  if (c) { if (canvasId && !c.canvasId) c.canvasId = String(canvasId); return c.id; }
  if (!autoCreate) return 0;
  const nc = { id: newId(), n: name, color: PAL[st.classes.length % PAL.length], slots: [], canvasId: canvasId ? String(canvasId) : '' };
  st.classes.push(nc);
  return nc.id;
}

/* ---------- merge synced items into the planner ---------- */
// items: [{title, due, time, course, courseId, uid, kind, url, unlockAt, lockAt, locked, finished, est, p, cls}]
// opts: {source, skipPast, autoClasses, autoComplete, defCls, force}
// Every item that is not added is recorded in S.skips with a plain-language reason.
function adoptLegacy(st, i) {
  // Items first synced as module entries now arrive from the To-Do feed with a better id: keep the same task.
  const tl = i.title.toLowerCase().trim();
  const t = st.tasks.find((x) => x.uid && /^canvas:module:/.test(x.uid) && x.t.toLowerCase().trim() === tl && (!x.d || !i.due || x.d === i.due));
  if (t) t.uid = i.uid;
  return t || null;
}
export function mergeItems(st, items, opts) {
  opts = opts || {};
  const today = todayIso(), src = opts.source || '';
  const S = { total: items.length, added: 0, held: 0, updated: 0, conflicts: 0, completed: 0, same: 0, released: 0, skipped: 0, skips: [] };
  const skip = (i, reason) => { S.skipped++; S.skips.push({ item: i, reason }); };
  const titleKey = (t, d) => String(t).toLowerCase().trim() + '|' + (d || '');
  const keyMap = new Map();
  st.tasks.concat(st.held).forEach((t) => keyMap.set(titleKey(t.t, t.d), t.src || ''));
  const dismissed = new Set(st.dismissed);
  let cur = null;
  const lockInfo = (t, L) => { t.opens = L.s === 'held' ? L.date : ''; t.opensTime = L.s === 'held' ? (cur.unlockTime || '') : ''; t.locked = L.s === 'locked'; };

  items.forEach((i) => {
    if (!i || !i.title || !i.uid) return;
    cur = i;
    const nd = i.due || '';
    const L = lockState(i, today);
    let ex = st.tasks.find((t) => t.uid === i.uid);
    if (!ex && src === 'canvas') ex = adoptLegacy(st, i);
    if (ex) {
      let ch = false;
      if (i.url && ex.url !== i.url) ex.url = i.url;
      if (i.kind) ex.kind = i.kind;
      ex.time = i.time || '';
      lockInfo(ex, L);
      if (i.finished && !ex.done && !ex.userUndone && opts.autoComplete !== false) {
        ex.done = true; ex.doneAt = today; ex.autoDone = true; S.completed++; ch = true;
      }
      const base = ex.cDue !== undefined ? ex.cDue : null;
      if (base !== null && nd !== base) {
        if ((ex.d || '') === base) { ex.d = nd; S.updated++; ch = true; }
        else if (!ex.done) {
          st.conflicts = st.conflicts.filter((c) => c.uid !== i.uid);
          st.conflicts.push({ uid: i.uid, id: ex.id, title: ex.t, yours: ex.d || '', theirs: nd, source: src });
          S.conflicts++; ch = true;
        }
        ex.cDue = nd;
      } else if (base === null) ex.cDue = nd;
      if (ex.cTitle !== undefined && i.title !== ex.cTitle && ex.t === ex.cTitle) { ex.t = i.title; ex.cTitle = i.title; S.updated++; ch = true; }
      if (!ch) S.same++;
      return;
    }
    const h = st.held.find((x) => x.uid === i.uid);
    if (h) {
      if (i.finished) { st.held = st.held.filter((x) => x !== h); return; }
      h.d = nd; h.time = i.time || '';
      if (nd || L.s === 'open') {
        // Anything with a due date belongs on the list, locked or not.
        delete h.hold; lockInfo(h, L); h.cDue = nd; h.done = !!h.done; h.spent = h.spent || 0;
        if (i.kind) h.kind = i.kind;
        if (i.url) h.url = i.url;
        st.tasks.push(h); st.held = st.held.filter((x) => x !== h); S.released++; return;
      }
      if (L.s === 'held') h.hold = L.date;
      S.same++; return;
    }
    if (opts.force) st.dismissed = st.dismissed.filter((u) => u !== i.uid);
    else {
      if (i.finished) return skip(i, i.kind === 'note' ? 'marked done in Canvas' : 'already submitted or completed');
      if (dismissed.has(i.uid)) return skip(i, 'you deleted it from the planner');
      if (L.s === 'closed') return skip(i, 'closed in Canvas (available until ' + i.lockAt + ')');
      if (opts.skipPast && nd && nd < today) return skip(i, 'already past due');
      const k = titleKey(i.title, nd);
      if (keyMap.has(k) && keyMap.get(k) !== src) return skip(i, 'same title and date already in your planner');
      if (!nd && L.s === 'locked') return skip(i, 'locked in Canvas with no date yet (added once it opens)');
    }
    const g = guessTask(i.title, i.kind);
    const cls = i.cls !== undefined ? i.cls : (matchClass(st, i.course, i.courseId, opts.autoClasses) || opts.defCls || 0);
    const t = {
      id: newId(), t: i.title, d: nd, time: i.time || '', p: i.p || g.p, cls: cls, est: i.est || g.est, fixed: 0, done: false, spent: 0,
      uid: i.uid, cDue: nd, cTitle: i.title, url: i.url || '', src: src, kind: i.kind || ''
    };
    lockInfo(t, L);
    keyMap.set(titleKey(t.t, t.d), src);
    if (L.s === 'held' && !nd && !opts.force) { t.hold = L.date; st.held.push(t); S.held++; }
    else { st.tasks.push(t); S.added++; }
  });
  return S;
}

// Move tasks whose unlock date has arrived onto the to-do list.
export function releaseHeld(st) {
  const today = todayIso();
  const rel = st.held.filter((h) => h.hold <= today);
  rel.forEach((h) => { delete h.hold; if (!st.tasks.some((t) => t.uid && t.uid === h.uid)) st.tasks.push(h); });
  st.held = st.held.filter((h) => h.hold);
  return rel.length;
}

export function statsText(S) {
  const a = [];
  if (S.added) a.push(S.added + ' new');
  if (S.held) a.push(S.held + ' waiting to unlock');
  if (S.released) a.push(S.released + ' unlocked');
  if (S.updated) a.push(S.updated + ' updated');
  if (S.completed) a.push(S.completed + ' checked off (submitted)');
  if (S.conflicts) a.push(S.conflicts + ' date conflict' + (S.conflicts === 1 ? '' : 's'));
  return a.length ? a.join(' · ') : 'Up to date';
}

/* ---------- iCalendar (.ics) ---------- */
function unesc(s) { return String(s || '').replace(/\\n/gi, ' ').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\').trim(); }

function parseDT(v) {
  const m = String(v || '').match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?/);
  if (!m) return null;
  if (!m[4]) return { date: new Date(+m[1], +m[2] - 1, +m[3]), allDay: true };
  const d = m[7] ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)))
    : new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  return { date: d, allDay: false };
}

export function parseICS(txt) {
  txt = String(txt || '').replace(/\r/g, '').replace(/\n[ \t]/g, '');
  const out = [];
  txt.split('BEGIN:VEVENT').slice(1).forEach((b) => {
    b = b.split('END:VEVENT')[0];
    const g = (k) => { const m = b.match(new RegExp('^' + k + '(?:;[^:\\n]*)?:(.*)$', 'm')); return m ? m[1].trim() : ''; };
    const all = (k) => { const r = []; const re = new RegExp('^' + k + '(?:;[^:\\n]*)?:(.*)$', 'gm'); let m; while ((m = re.exec(b))) r.push(m[1].trim()); return r; };
    const s = parseDT(g('DTSTART'));
    if (!s) return;
    let e = parseDT(g('DTEND'));
    if (!e) {
      const du = g('DURATION').match(/P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/);
      const ms = du ? (((+du[1] || 0) * 24 + (+du[2] || 0)) * 60 + (+du[3] || 0)) * 60000 : 0;
      e = { date: new Date(s.date.getTime() + ms), allDay: s.allDay };
    }
    const ex = new Set();
    all('EXDATE').forEach((v) => v.split(',').forEach((x) => { const d = parseDT(x); if (d) ex.add(iso(d.date)); }));
    out.push({
      uid: g('UID'), summary: unesc(g('SUMMARY')), url: g('URL'), start: s.date, end: e.date, allDay: s.allDay,
      rrule: g('RRULE'), exdates: ex, status: g('STATUS')
    });
  });
  return out;
}

// Expand (possibly recurring) events into dated occurrences between from and to (Date objects).
export function expandEvents(evs, from, to) {
  const out = [];
  const DAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  evs.forEach((ev) => {
    if (ev.status === 'CANCELLED') return;
    const lenMs = Math.max(0, ev.end - ev.start);
    const push = (d) => {
      const st = new Date(d.getFullYear(), d.getMonth(), d.getDate(), ev.start.getHours(), ev.start.getMinutes());
      const en = new Date(st.getTime() + lenMs);
      if (en < from || st > to) return;
      if (ev.exdates.has(iso(st))) return;
      out.push({ uid: ev.uid + '@' + iso(st), title: ev.summary, d: iso(st), allDay: ev.allDay,
        s: ev.allDay ? 0 : st.getHours() * 60 + st.getMinutes(),
        e: ev.allDay ? 1440 : (iso(en) === iso(st) ? en.getHours() * 60 + en.getMinutes() : 1440) });
    };
    if (!ev.rrule) { push(ev.start); return; }
    const R = {};
    ev.rrule.split(';').forEach((p) => { const kv = p.split('='); R[kv[0]] = kv[1]; });
    const iv = Math.max(1, +R.INTERVAL || 1), count = +R.COUNT || 0;
    const until = R.UNTIL ? parseDT(R.UNTIL).date : null;
    const by = R.BYDAY ? R.BYDAY.split(',').map((x) => DAYS[x.slice(-2)]).filter((x) => x !== undefined) : null;
    const s0 = new Date(ev.start.getFullYear(), ev.start.getMonth(), ev.start.getDate());
    const weekStart = (d) => { const x = new Date(d); x.setDate(x.getDate() - x.getDay()); return x; };
    const ws0 = weekStart(s0);
    let n = 0;
    const d = new Date(count ? s0 : Math.max(s0, new Date(from.getFullYear(), from.getMonth(), from.getDate() - 1)));
    for (let k = 0; k < 2000 && d <= to; k++, d.setDate(d.getDate() + 1)) {
      if (until && d > until) break;
      const dd = Math.round((d - s0) / 864e5);
      let ok = false;
      if (R.FREQ === 'DAILY') ok = dd % iv === 0;
      else if (R.FREQ === 'WEEKLY') {
        const wk = Math.round((weekStart(d) - ws0) / (7 * 864e5));
        ok = wk % iv === 0 && (by ? by.includes(d.getDay()) : d.getDay() === s0.getDay());
      } else if (R.FREQ === 'MONTHLY') {
        const mo = (d.getFullYear() - s0.getFullYear()) * 12 + d.getMonth() - s0.getMonth();
        ok = mo % iv === 0 && d.getDate() === s0.getDate();
      } else if (R.FREQ === 'YEARLY') ok = d.getMonth() === s0.getMonth() && d.getDate() === s0.getDate();
      if (!ok) continue;
      n++;
      if (count && n > count) break;
      push(d);
    }
  });
  return out;
}

// Turn calendar events into task items (for Canvas calendar feeds and to-do style feeds).
export function icsToItems(evs, feedId) {
  return evs.filter((e) => e.summary && e.status !== 'CANCELLED').map((e) => {
    const cm = e.summary.match(/\[([^\]]+)\]\s*$/);
    return {
      title: cm ? e.summary.replace(/\s*\[[^\]]+\]\s*$/, '') : e.summary,
      due: iso(e.start), course: cm ? cm[1] : '', uid: 'ics:' + (e.uid || (feedId + ':' + e.summary + iso(e.start))),
      url: e.url || '', kind: 'feed'
    };
  });
}

export { scanCanvasCore } from './canvas-scan.js';

// Split scanned items into ones to merge and ones left out by your Sync settings (with the reason).
export function filterCanvas(data, cv) {
  const ex = new Set((cv.excluded || []).map(String));
  const keep = [], dropped = [];
  data.items.forEach((i) => {
    if (ex.has(String(i.courseId))) return dropped.push({ item: i, reason: 'course is turned off in Sync settings' });
    const isMod = String(i.kind).indexOf('module') === 0;
    if (isMod && i.req && !cv.modReq) return dropped.push({ item: i, reason: 'required module items are turned off' });
    if (isMod && !i.req && !cv.modOther) return dropped.push({ item: i, reason: 'optional module item (turned off in Sync settings)' });
    if (!isMod && !cv.assign) return dropped.push({ item: i, reason: 'assignments are turned off' });
    keep.push(i);
  });
  return { keep, dropped };
}

// Canvas calendar events (exams, labs) become busy time; exam-like ones also become a task to study for.
export function canvasEvents(data, excluded) {
  const ex = new Set((excluded || []).map(String));
  const occ = [], tasks = [];
  (data.events || []).forEach((e) => {
    if (e.courseId && ex.has(e.courseId)) return;
    const s = new Date(e.start), en = new Date(e.end || e.start);
    if (isNaN(s)) return;
    const d = iso(s);
    occ.push({ uid: e.uid, title: e.title + (e.course ? ' · ' + e.course : ''), d, allDay: e.allDay, courseId: e.courseId, feed: 'canvas', url: e.url,
      s: e.allDay ? 0 : s.getHours() * 60 + s.getMinutes(), e: e.allDay ? 1440 : (iso(en) === d ? en.getHours() * 60 + en.getMinutes() : 1440) });
    if (/midterm|exam|final|quiz|test\b/i.test(e.title)) {
      tasks.push({ title: e.title, due: d, time: e.allDay ? '' : p2(s.getHours()) + ':' + p2(s.getMinutes()), course: e.course, courseId: e.courseId,
        uid: e.uid, kind: 'exam', url: e.url, from: 'Calendar' });
    }
  });
  return { occ, tasks };
}

export function originOf(url) {
  try { const u = new URL(String(url).replace(/^webcal:/i, 'https:')); return u.origin; } catch (e) { return ''; }
}
export function cleanHost(h) {
  return String(h || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
}

/* ---------- "can't do now" ---------- */
// t.block = { kind: 'task' (waiting on other tasks) | 'cond' (waiting for something to happen) | 'later' (snoozed),
//             deps: [task ids], note: '', until: 'YYYY-MM-DD' (snooze end / when the condition is expected), since }
export function blockState(st, t, today) {
  const b = t && t.block;
  if (!b || t.done) return null;
  today = today || todayIso();
  if (b.kind === 'task') {
    const waiting = (b.deps || []).map((id) => st.tasks.find((x) => x.id === id)).filter((x) => x && !x.done);
    return waiting.length ? { blocked: true, waiting } : { blocked: false, cleared: true };
  }
  if (b.kind === 'later') return b.until && b.until <= today ? { blocked: false, cleared: true } : { blocked: true };
  return { blocked: true, check: !!(b.until && b.until <= today) };
}
export function isBlocked(st, t) { const s = blockState(st, t); return !!(s && s.blocked); }
// Clear blocks whose conditions are met. Returns the tasks that just became ready.
export function sweepBlocks(st) {
  const ready = [];
  st.tasks.forEach((t) => {
    if (!t.block) return;
    if (t.done) { delete t.block; return; }
    const s = blockState(st, t);
    if (s && s.cleared) { ready.push(t); delete t.block; }
  });
  return ready;
}
// Does task a (directly or through others) wait on task b?
export function dependsOn(st, a, b, seen) {
  seen = seen || new Set();
  if (seen.has(a)) return false;
  seen.add(a);
  const t = st.tasks.find((x) => x.id === a);
  const deps = (t && t.block && t.block.kind === 'task' && t.block.deps) || [];
  return deps.some((d) => d === b || dependsOn(st, d, b, seen));
}

/* ---------- backups ---------- */
export async function makeBackup(withSecrets) {
  const d = await ext.storage.local.get(['plan', 'dlog']);
  const plan = normalize(d.plan);
  if (!withSecrets) { plan.cfg.aiKey = ''; plan.cfg.geminiKey = ''; plan.canvas.token = ''; }
  return {
    app: 'triaj', kind: 'backup', version: ext.runtime.getManifest().version, at: new Date().toISOString(), secrets: !!withSecrets,
    summary: { tasks: plan.tasks.length, classes: plan.classes.length, routines: plan.routines.length, feeds: plan.feeds.length, focusSessions: plan.focus.length, transactions: plan.tx.length },
    data: { plan, dlog: d.dlog || {} }
  };
}
// Accepts this format, v2.0/v2.1 backups and backups from the old Claude artifact (a bare plan object).
export function parseBackup(o) {
  if (o && (o.app === 'triaj' || o.app === 'my-planner') && o.data && o.data.plan && Array.isArray(o.data.plan.tasks)) return { plan: o.data.plan, dlog: o.data.dlog || null, at: o.at, version: o.version, summary: o.summary };
  if (o && Array.isArray(o.tasks)) return { plan: o, dlog: null, at: '', version: 'older version', summary: { tasks: o.tasks.length, classes: (o.classes || []).length } };
  return null;
}
// A copy kept in this browser (survives updates and bugs; your account has the live data).
export async function snapshot(reason, force) {
  const d = await ext.storage.local.get(['plan', 'snaps', 'dlog']);
  if (!d.plan) return false;
  const p = d.plan;
  if (!(p.tasks || []).length && !(p.classes || []).length && !(p.routines || []).length) return false; // nothing worth keeping
  const snaps = d.snaps || [];
  if (!force && snaps[0] && snaps[0].rev === d.plan.rev) return false; // nothing changed since the last one
  snaps.unshift({ at: new Date().toISOString(), reason, version: ext.runtime.getManifest().version, rev: d.plan.rev,
    tasks: (d.plan.tasks || []).length, classes: (d.plan.classes || []).length, plan: d.plan, dlog: d.dlog || {} });
  await ext.storage.local.set({ snaps: snaps.slice(0, 15) });
  return true;
}

/* ---------- themes ---------- */
// Every color theme gets its own light, dark and black palette. All text/background pairs are
// checked for contrast in tools (see README); --on-pri is whichever of white/near-black reads best.
export const THEMES = {
  ink: { name: 'Ballpoint', h: 224, s: 62, light: '#2546b0', dark: '#93abff' },
  purple: { name: 'Gel pen', h: 262, s: 60, light: '#6a3fc0', dark: '#b7a2fb' },
  blue: { name: 'Sky', h: 204, s: 80, light: '#0b65a3', dark: '#6cc0f5' },
  teal: { name: 'Mint', h: 172, s: 70, light: '#0f736b', dark: '#4fd8c4' },
  green: { name: 'Sage', h: 134, s: 40, light: '#3a763d', dark: '#8fd497' },
  rose: { name: 'Pink highlighter', h: 340, s: 70, light: '#bb2559', dark: '#ff8fb5' },
  orange: { name: 'Tangerine', h: 22, s: 85, light: '#b9400b', dark: '#ffa066' },
  slate: { name: 'Pencil', h: 220, s: 12, light: '#4a5262', dark: '#a8b0bf' }
};
// Paper templates, like a notebook's: the page ground behind every screen.
export const PAPERS = { dots: 'Dotted', ruled: 'Ruled', grid: 'Grid', blank: 'Blank' };
export const MODES = { auto: 'Auto', light: 'Light', dark: 'Dark', black: 'Black' };

export function hslHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))))).toString(16).padStart(2, '0');
  return '#' + f(0) + f(8) + f(4);
}
function rgbOf(hex) {
  hex = String(hex || '').replace('#', '');
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  const n = parseInt(hex.slice(0, 6), 16);
  return isNaN(n) ? [0, 0, 0] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function luminance(hex) {
  const c = rgbOf(hex).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
export function contrast(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
// Text color for anything drawn on a solid color (class colors, buttons): white or near-black, whichever reads better.
export function onColor(bg) { return contrast(bg, '#ffffff') >= contrast(bg, '#14141a') ? '#ffffff' : '#14141a'; }
// Blend a translucent tint over a background (for checking chip contrast).
export function mix(fg, bg, alpha) {
  const a = rgbOf(fg), b = rgbOf(bg);
  return '#' + a.map((v, i) => Math.round(v * alpha + b[i] * (1 - alpha)).toString(16).padStart(2, '0')).join('');
}

export function resolveMode(mode, systemDark) {
  return mode === 'light' || mode === 'dark' || mode === 'black' ? mode : (systemDark ? 'dark' : 'light');
}
export function themeVars(theme, mode, systemDark) {
  const T = THEMES[theme] || THEMES.ink, m = resolveMode(mode, systemDark), h = T.h, s = T.s, t = s / 100;
  let v;
  // Light is a paper notebook: warm-white page, fresh white sheets, ink-black text, rulings tinted by the pen.
  // Dark is GoodNotes-style dark paper. The highlighters (hl*) are fills that always carry ink-coloured text.
  if (m === 'light') {
    v = { bg: '#f5f3ee', card: '#fffefb', ink: '#1b2233', mute: hslHex(h, 10 * t, 36), line: '#e2ded5',
      soft: hslHex(h, 70 * t, 94), pri: T.light, g1: T.light, g2: hslHex(h, s, 24),
      bad: '#b42318', ok: '#2f7a3a', warn: '#8a5a00', warnbg: '#fff1b8', field: '#fffefb', shadow: 'rgba(27,34,51,.10)',
      hdr: '#f5f3ee', now: '#bf2b3f', soon: '#8f6200', later: '#16765f', grid: hslHex(h, 55 * t, 84),
      hlnow: '#ffc2d3', hlsoon: '#ffe680', hllater: '#bdeed0', hlink: '#1b2233' };
  } else if (m === 'dark') {
    v = { bg: hslHex(h, 10 * t, 9.5), card: hslHex(h, 10 * t, 13), ink: '#eceae4', mute: hslHex(h, 10 * t, 70), line: hslHex(h, 10 * t, 22),
      soft: hslHex(h, 28 * t, 19), pri: T.dark, g1: hslHex(h, 50 * t, 30), g2: hslHex(h, 40 * t, 15),
      bad: '#f87171', ok: '#7fd88d', warn: '#fbbf24', warnbg: '#3a2e0b', field: hslHex(h, 10 * t, 11), shadow: 'rgba(0,0,0,.4)',
      hdr: hslHex(h, 10 * t, 9.5), now: '#ff8a98', soon: '#f5c04a', later: '#5fd6b6', grid: hslHex(h, 14 * t, 19),
      hlnow: '#6e2a3d', hlsoon: '#5c4b10', hllater: '#1d5a40', hlink: '#f3f1ec' };
  } else {
    v = { bg: '#000000', card: '#0d0d10', ink: '#ededf0', mute: '#a1a1aa', line: '#26262c',
      soft: hslHex(h, 40 * t, 11), pri: T.dark, g1: hslHex(h, 55 * t, 20), g2: '#000000',
      bad: '#f87171', ok: '#7fd88d', warn: '#fbbf24', warnbg: '#2b2206', field: '#060608', shadow: 'rgba(0,0,0,.6)',
      hdr: '#000000', now: '#ff8a98', soon: '#f5c04a', later: '#5fd6b6', grid: '#16161b',
      hlnow: '#5a2232', hlsoon: '#4a3d0d', hllater: '#174a35', hlink: '#f3f1ec' };
  }
  v.onpri = onColor(v.pri);
  v.onok = onColor(v.ok);
  v.mode = m;
  return v;
}
export function applyThemeVars(root, theme, mode, systemDark, paper) {
  const v = themeVars(theme, mode, systemDark);
  root.setAttribute('data-paper', PAPERS[paper] ? paper : 'dots');
  Object.keys(v).forEach((k) => { if (k !== 'mode') root.style.setProperty('--' + k, v[k]); });
  root.setAttribute('data-theme', v.mode === 'light' ? 'light' : 'dark');
  root.setAttribute('data-mode', v.mode);
  root.style.colorScheme = v.mode === 'light' ? 'light' : 'dark';
  return v;
}

/* ---------- in-class assessments ---------- */
// t.inClass = true: a test, quiz or in-class assignment done during class. No study blocks are planned for it;
// it is shown on that day's meeting of its class. t.icAt picks one meeting when the class meets twice that day;
// t.icS / t.icE are manual times for when the class doesn't meet on that date.
export function classSlotsOn(st, clsId, ds) {
  const c = st.classes.find((x) => x.id === clsId);
  if (!c || !ds) return [];
  const wd = new Date(ds + 'T00:00:00').getDay();
  return c.slots.filter((x) => x.day === wd).slice().sort((a, b) => mn(a.s) - mn(b.s)).map((x) => ({ s: mn(x.s), e: mn(x.e), loc: x.loc || '', cls: c }));
}
export function inClassSlot(st, t) {
  if (!t || !t.inClass || !t.d) return null;
  const slots = classSlotsOn(st, t.cls, t.d);
  if (slots.length) {
    const pick = t.icAt ? slots.find((x) => x.s === mn(t.icAt)) : null;
    return Object.assign({ matched: true, choices: slots.length }, pick || slots[0]);
  }
  if (t.icS && t.icE && mn(t.icE) > mn(t.icS)) return { s: mn(t.icS), e: mn(t.icE), loc: '', cls: st.classes.find((x) => x.id === t.cls) || null, matched: false };
  return null;
}
// Once the class it happens in is over, an in-class item is done. Returns the tasks it checked off.
export function sweepInClass(st, now) {
  now = now || new Date();
  const today = iso(now), nowM = now.getHours() * 60 + now.getMinutes(), out = [];
  st.tasks.forEach((t) => {
    if (!t.inClass || t.done || !t.d || t.d > today) return;
    const sl = inClassSlot(st, t);
    const over = t.d < today || (sl ? nowM >= sl.e : false);
    if (over) { t.done = true; t.doneAt = t.d; t.autoDone = true; t.icDone = true; out.push(t); }
  });
  return out;
}
