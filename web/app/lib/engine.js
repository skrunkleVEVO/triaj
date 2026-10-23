// Runs what the extension's background worker used to do, inside the page: Canvas + calendar sync on
// a schedule, the focus timer, sounds, notifications, the app badge and the daily heads-up.
// Alarms are fired by one tab at a time (see platform.js), so several open tabs never double up.
import {
  loadPlan, updatePlan, todayIso, iso, scanCanvasCore, filterCanvas, canvasEvents, mergeItems, releaseHeld,
  statsText, parseICS, expandEvents, icsToItems, originOf, need, matchClass, sweepBlocks, makeBackup, snapshot, sweepInClass
} from './shared.js';
import { downloadAll } from './canvasfiles.js';
import { playSound, startAmbient, stopAmbient } from './sounds.js';
import { ext, APP_VERSION, isLeader } from './platform.js';
import * as bridge from './bridge.js';

const TIMER_IDLE = { phase: 'work', status: 'idle', round: 0, tid: 0, presetId: '', endAt: 0, left: 0, total: 0 };
const LABEL = { work: 'Focus', short: 'Short break', long: 'Long break' };

/* ================= helpers ================= */
async function getTimer() { const d = await ext.storage.local.get('timer'); return Object.assign({}, TIMER_IDLE, d.timer || {}); }
async function setTimer(t) { await ext.storage.local.set({ timer: t }); await updateBadge(t); return t; }
function presetOf(st, id) { const T = st.cfg.timer; return T.presets.find((p) => p.id === (id || T.presetId)) || T.presets[0]; }
function phaseMin(p, ph) { return ph === 'work' ? p.work : ph === 'short' ? p.short : p.long; }
function leftSec(t) { return t.status === 'running' ? Math.max(0, Math.round((t.endAt - Date.now()) / 1000)) : t.left; }

function openPlanner(hash) {
  try { window.focus(); } catch (e) {}
  if (hash && location.hash.slice(1) !== hash) location.hash = hash;
}

/* ================= audio ================= */
async function play(sound, st) {
  st = st || await loadPlan();
  if (st.cfg.sound === false || !sound || sound === 'none') return;
  try { playSound(sound, st.cfg.timer.volume); } catch (e) {}
}
async function ambientOn(st) {
  const T = st.cfg.timer;
  if (st.cfg.sound === false || !T.ambient || T.ambient === 'none') return stopAmbient();
  try { startAmbient(T.ambient, T.ambientVol); } catch (e) {}
}
function ambientOff() { try { stopAmbient(); } catch (e) {} }

/* ================= badge ================= */
async function updateBadge(t) {
  t = t || await getTimer();
  const st = await loadPlan();
  await ext.action.setBadge(st.cfg.timer.badge !== false && t.status === 'running' ? Math.ceil(leftSec(t) / 60) : 0);
}

/* ================= focus timer ================= */
async function scheduleTimerAlarms(t, st) {
  await Promise.all(['timer-end', 'refocus', 'badge'].map((n) => ext.alarms.clear(n)));
  if (t.status !== 'running') return;
  ext.alarms.create('timer-end', { when: t.endAt });
  ext.alarms.create('badge', { delayInMinutes: 0.5, periodInMinutes: 0.5 });
  const rf = +st.cfg.timer.refocus || 0;
  if (t.phase === 'work' && rf > 0 && rf * 60 < leftSec(t) - 30) ext.alarms.create('refocus', { delayInMinutes: rf, periodInMinutes: rf });
}

async function startPhase(phase, o) {
  o = o || {};
  const st = await loadPlan(), cur = await getTimer();
  const p = presetOf(st, o.presetId || cur.presetId);
  const mins = +o.minutes > 0 ? +o.minutes : phaseMin(p, phase);
  const t = Object.assign({}, cur, {
    phase, status: 'running', presetId: p.id, total: Math.round(mins * 60), endAt: Date.now() + mins * 60000, left: 0,
    startedAt: Date.now(), custom: +o.minutes > 0, distractions: phase === 'work' ? 0 : (cur.distractions || 0)
  });
  if (o.tid !== undefined) t.tid = +o.tid || 0;
  if (o.resetRound || o.presetId && o.presetId !== cur.presetId) t.round = 0;
  await setTimer(t);
  await scheduleTimerAlarms(t, st);
  if (phase === 'work') await ambientOn(st); else ambientOff();
  ext.notifications.clear('timer');
  return t;
}

async function logFocus(tid, mins) {
  await updatePlan((st) => {
    st.focus.push({ d: todayIso(), m: mins, tid: tid || 0, at: Date.now() });
    if (tid) st.tasks.forEach((x) => { if (x.id === tid) x.spent = (x.spent || 0) + mins; });
  });
}

async function completePhase(natural, forceStart) {
  const t = await getTimer();
  if (t.status !== 'running' && t.status !== 'paused') return t;
  if (natural && t.status === 'running' && Date.now() < t.endAt - 1500) return t; // alarm fired early, ignore
  const st = await loadPlan(), T = st.cfg.timer, p = presetOf(st, t.presetId);
  const elapsed = natural ? t.total : t.total - leftSec(t);
  await Promise.all(['timer-end', 'refocus', 'badge'].map((n) => ext.alarms.clear(n)));
  let mins = 0, next;
  if (t.phase === 'work') {
    mins = Math.round(elapsed / 60);
    if (mins >= 1) await logFocus(t.tid, mins);
    t.round = (t.round || 0) + 1;
    next = t.round % Math.max(1, p.rounds) === 0 ? 'long' : 'short';
  } else next = 'work';
  t.lastDone = { phase: t.phase, mins, at: Date.now() };
  ambientOff();
  if (natural) await play(t.phase === 'work' ? T.endSound : T.breakSound, st);

  const auto = forceStart || (next === 'work' ? T.autoWork : T.autoBreak);
  const nm = phaseMin(p, next);
  Object.assign(t, { phase: next, status: 'ready', total: nm * 60, left: nm * 60, endAt: 0 });
  await setTimer(t);
  if (auto) await startPhase(next);

  if (natural && T.notify !== false) {
    const task = st.tasks.find((x) => x.id === t.tid);
    const title = t.lastDone.phase === 'work' ? 'Focus done: +' + mins + ' min 🎉' : 'Break is over ☕';
    const msg = t.lastDone.phase === 'work'
      ? (auto ? 'Your ' + nm + ' min ' + LABEL[next].toLowerCase() + ' has started. Stand up, stretch, drink water.' : 'Time for a ' + nm + ' min ' + LABEL[next].toLowerCase() + '.')
      : (auto ? 'Next focus round started' + (task ? ': ' + task.t : '.') : 'Ready for the next round' + (task ? ' on ' + task.t : '') + '?');
    const buttons = auto ? [{ title: next === 'work' ? 'Pause' : 'Skip break' }, { title: 'Stop' }] : [{ title: 'Start ' + LABEL[next].toLowerCase() }, { title: 'Stop for now' }];
    ext.notifications.create('timer', { title, message: msg, buttons, priority: 2 });
  }
  return getTimer();
}

async function timerOp(m) {
  const t = await getTimer();
  switch (m.op) {
    case 'start':
      ext.notifications.ask();
      return startPhase(m.phase || (t.status === 'ready' ? t.phase : 'work'), { tid: m.tid, minutes: m.minutes, presetId: m.presetId, resetRound: m.resetRound });
    case 'pause':
      if (t.status !== 'running') return t;
      t.left = leftSec(t); t.status = 'paused';
      await setTimer(t); await scheduleTimerAlarms(t, await loadPlan()); ambientOff();
      return t;
    case 'resume': {
      if (t.status !== 'paused') return t;
      const st = await loadPlan();
      t.endAt = Date.now() + t.left * 1000; t.status = 'running';
      await setTimer(t); await scheduleTimerAlarms(t, st);
      if (t.phase === 'work') await ambientOn(st);
      return t;
    }
    case 'toggle':
      if (t.status === 'running') return timerOp({ op: 'pause' });
      if (t.status === 'paused') return timerOp({ op: 'resume' });
      return timerOp({ op: 'start' });
    case 'stop': {
      if ((t.status === 'running' || t.status === 'paused') && t.phase === 'work') {
        const mins = Math.round((t.total - leftSec(t)) / 60);
        if (mins >= 1) await logFocus(t.tid, mins);
      }
      await Promise.all(['timer-end', 'refocus', 'badge'].map((n) => ext.alarms.clear(n)));
      ambientOff();
      ext.notifications.clear('timer');
      return setTimer(Object.assign({}, TIMER_IDLE, { tid: t.tid, presetId: t.presetId, round: m.resetRound ? 0 : t.round }));
    }
    case 'skip':
      return completePhase(false, true);
    case 'tick':
      if (t.status === 'running' && Date.now() >= t.endAt) return completePhase(true);
      return t;
    case 'add': {
      if (t.status !== 'running' && t.status !== 'paused') return t;
      const s = (+m.minutes || 5) * 60;
      t.total += s;
      if (t.status === 'running') t.endAt += s * 1000; else t.left += s;
      await setTimer(t); await scheduleTimerAlarms(t, await loadPlan());
      return t;
    }
    case 'task':
      t.tid = +m.tid || 0; return setTimer(t);
    case 'distracted':
      t.distractions = (t.distractions || 0) + 1;
      await updatePlan((st) => { st.focus.push({ d: todayIso(), x: 1, tid: t.tid || 0, at: Date.now() }); });
      await setTimer(t);
      return t;
    case 'ambient': {
      const st = await loadPlan();
      if (t.status === 'running' && t.phase === 'work') await ambientOn(st); else ambientOff();
      return t;
    }
  }
  return t;
}

async function refocusNudge() {
  const t = await getTimer();
  if (t.status !== 'running' || t.phase !== 'work') return;
  const st = await loadPlan(), T = st.cfg.timer;
  await play(T.refocusSound || 'nudge', st);
  if (T.refocusNotify) {
    const task = st.tasks.find((x) => x.id === t.tid);
    ext.notifications.create('refocus', { silent: true,
      title: 'Still with it? 👀', message: (task ? task.t + ' · ' : '') + Math.ceil(leftSec(t) / 60) + ' min left in this round.' });
    setTimeout(() => ext.notifications.clear('refocus'), 8000);
  }
}

/* ================= Canvas + calendar sync ================= */
const NOEXT = 'Canvas sync runs through the Triaj companion extension, and this browser doesn\'t have it. ' +
  'Install it on your computer (More → Sync shows how). Anything it syncs shows up here on every device.';
async function hasOrigin(origin) {
  try { return await ext.permissions.contains({ origins: [origin + '/*'] }); } catch (e) { return false; }
}

async function setSyncState(running, text) {
  await ext.storage.local.set({ syncState: { running, text: text || '', at: Date.now() } });
}

// Build the "what Canvas has vs. your planner" report shown on the Sync page.
function buildReport(st, data, dropped, skips) {
  const inTasks = new Map(st.tasks.filter((t) => t.uid).map((t) => [t.uid, t]));
  const inHeld = new Set(st.held.map((t) => t.uid));
  const left = dropped.concat(skips);
  const leftUid = new Map(left.map((x) => [x.item.uid, x.reason]));
  const courses = data.courses.map((c) => {
    const its = data.items.filter((i) => i.courseId === c.id);
    const r = { id: c.id, code: c.code, found: its.length, open: 0, done: 0, waiting: 0, left: 0, due7: 0 };
    const wk = new Date(); wk.setDate(wk.getDate() + 7); const w = iso(wk), today = todayIso();
    its.forEach((i) => {
      const t = inTasks.get(i.uid);
      if (t) { if (t.done) r.done++; else { r.open++; if (t.d && t.d >= today && t.d <= w) r.due7++; } }
      else if (inHeld.has(i.uid)) r.waiting++;
      else if (leftUid.has(i.uid)) r.left++;
    });
    return r;
  });
  const slim = (x) => {
    const i = x.item;
    return { reason: x.reason, item: { title: i.title, due: i.due || '', time: i.time || '', course: i.course || '', courseId: i.courseId || '', uid: i.uid,
      kind: i.kind || '', url: i.url || '', unlockAt: i.unlockAt || '', unlockTime: i.unlockTime || '', lockAt: i.lockAt || '', locked: !!i.locked, from: i.from || '' } };
  };
  // Most useful first: things that are still upcoming, then the rest.
  const today = todayIso();
  const order = (x) => (x.item.due && x.item.due >= today ? 0 : x.item.due ? 2 : 1);
  return { at: new Date().toISOString(), courses, total: data.items.length, plannerOk: data.plannerOk,
    left: left.map(slim).sort((a, b) => order(a) - order(b) || (a.item.due < b.item.due ? -1 : 1)).slice(0, 500) };
}

// preData: a scan already made inside an open Canvas tab (companion "Sync from this tab"), which needs no stored permission.
async function syncCanvas(manual, preData, preVia) {
  const st0 = await loadPlan(), cv = st0.canvas;
  if (!cv.host) return { kind: 'info', text: 'Canvas is not set up yet.' };
  // Without the companion nothing is recorded: the status is shared with your other devices.
  if (!preData && !bridge.available()) return { kind: 'err', code: 'ext', text: NOEXT };
  const origin = 'https://' + cv.host;
  const fail = async (text, code) => {
    await setSyncState(false, '');
    await updatePlan((st) => { st.canvas.lastStatus = { kind: 'err', text, code: code || '', at: new Date().toISOString() }; });
    return { kind: 'err', text, code: code || '' };
  };
  if (!preData && !(await hasOrigin(origin))) {
    return fail('Your browser is not letting Triaj read ' + cv.host + ' right now. This is a browser permission for the companion extension, not your Canvas login. ' +
      'Press "Allow access" to fix it.', 'perm');
  }
  await setSyncState(true, preData ? 'Saving what was read from your Canvas tab…' : 'Connecting to Canvas…');
  const progress = (t) => { setSyncState(true, t); };
  let data = preData || null;
  const via = preVia || (cv.token ? 'access token' : 'your Canvas sign-in');
  if (!data) try {
    data = await scanCanvasCore(origin, cv.token, progress, bridge.fetch);
  } catch (e) {
    if (e && e.auth) return fail(cv.token ? 'Canvas rejected your access token. Make a new one in Canvas (Account → Settings → New access token).' :
      'Not signed in to Canvas. Open ' + cv.host + ' in this browser and sign in (or click the Triaj companion icon there and press "Sync from this tab"), or add an access token so sync works even when you are signed out.');
    return fail('Could not reach Canvas: ' + ((e && e.message) || e));
  }
  await setSyncState(true, 'Updating your planner…');
  let S;
  await updatePlan((st) => {
    const f = filterCanvas(data, st.canvas);
    const ev = canvasEvents(data, st.canvas.excluded);
    S = mergeItems(st, f.keep.concat(ev.tasks), { source: 'canvas', skipPast: st.canvas.skipPast, autoClasses: st.canvas.autoClasses, autoComplete: st.canvas.autoComplete });
    // Calendar events: busy time in the schedule, coloured by class.
    ev.occ.forEach((o) => { const c = st.classes.find((x) => x.id === matchClass(st, '', o.courseId, false)); o.color = c ? c.color : '#475569'; });
    st.events = st.events.filter((e) => e.feed !== 'canvas').concat(ev.occ);
    st.canvas.courses = data.courses;
    // Keep every course in the syllabus list, even ones with nothing found, so it is clear what was checked.
    st.canvas.syllabi = data.syllabi;
    st.canvas.lastSync = new Date().toISOString();
    st.canvas.report = buildReport(st, data, f.dropped, S.skips);
    const upcomingLeft = st.canvas.report.left.filter((x) => x.item.due && x.item.due >= todayIso() && !/submitted|completed|marked done/.test(x.reason)).length;
    let text = statsText(S);
    if (upcomingLeft) text += ' · ' + upcomingLeft + ' upcoming Canvas item' + (upcomingLeft === 1 ? '' : 's') + ' not added (see report)';
    st.canvas.lastStatus = { kind: data.warnings.length || !data.plannerOk ? 'warn' : 'ok', text, stats: Object.assign({}, S, { skips: undefined }), via,
      warnings: data.warnings.slice(0, 8), at: st.canvas.lastSync, items: data.items.length, events: ev.occ.length };
  });
  await setSyncState(false, '');
  if (!manual && (S.added || S.conflicts || S.released)) {
    ext.notifications.create('sync', { title: 'Canvas synced', message: statsText(S) });
  }
  await unblockSweep(); // submitted prerequisites free up the tasks waiting on them
  return { kind: 'ok', text: statsText(S), stats: Object.assign({}, S, { skips: undefined }) };
}

// Calendars that allow it are read straight from the page; the rest go through the companion.
async function getFeed(url) {
  try {
    const r = await fetch(url, { credentials: 'omit', cache: 'no-store' });
    if (r.ok) return r.text();
  } catch (e) {}
  if (!bridge.available()) { const e = new Error('This calendar can only be read through the Triaj companion extension.'); e.noext = true; throw e; }
  const origin = originOf(url);
  if (!origin || !(await hasOrigin(origin))) throw new Error('Permission needed for ' + (origin || 'this link') + '. Click Reconnect.');
  const r = await bridge.fetch(url, { credentials: 'omit', cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}

async function syncFeed(feed, quiet) {
  const url = String(feed.url).replace(/^webcal:/i, 'https:');
  let status;
  try {
    const txt = await getFeed(url);
    if (txt.indexOf('BEGIN:VCALENDAR') < 0) throw new Error('That link is not a calendar (.ics) feed.');
    const evs = parseICS(txt);
    await updatePlan((st) => {
      const f = st.feeds.find((x) => x.id === feed.id);
      if (!f) return;
      if (f.type === 'events') {
        const from = new Date(); from.setDate(from.getDate() - 7);
        const to = new Date(); to.setDate(to.getDate() + 120);
        const occ = expandEvents(evs, from, to).map((o) => Object.assign(o, { feed: f.id, color: f.color || '#64748b' }));
        st.events = st.events.filter((e) => e.feed !== f.id).concat(occ);
        status = { kind: 'ok', text: occ.length + ' events in the next 4 months' };
      } else {
        const S = mergeItems(st, icsToItems(evs, f.id), { source: 'feed', skipPast: true, defCls: f.cls || 0, autoClasses: false });
        status = { kind: 'ok', text: statsText(S) };
      }
      f.lastSync = new Date().toISOString(); f.lastStatus = status;
    });
  } catch (e) {
    status = { kind: 'err', text: (e && e.message) || String(e) };
    if (!(quiet && e && e.noext)) await updatePlan((st) => { const f = st.feeds.find((x) => x.id === feed.id); if (f) { f.lastStatus = status; } });
  }
  return status;
}

let syncing = null;
function syncAll(manual) {
  if (syncing) return syncing;
  syncing = (async () => {
    const st = await loadPlan(), out = { feeds: {} };
    if (st.canvas.host && (manual || bridge.available())) out.canvas = await syncCanvas(manual).catch((e) => ({ kind: 'err', text: String(e && e.message || e) }));
    for (const f of st.feeds) { await setSyncState(true, 'Updating calendar: ' + f.name + '…'); out.feeds[f.id] = await syncFeed(f, !manual); }
    await setSyncState(false, '');
    await updatePlan((s) => { releaseHeld(s); s.lastSyncAll = new Date().toISOString(); });
    return out;
  })().finally(() => { syncing = null; setSyncState(false, ''); });
  return syncing;
}

/* ================= daily digest ================= */
function nextAt(hhmm) {
  const d = new Date(), p = String(hhmm || '08:00').split(':');
  d.setHours(+p[0], +p[1], 0, 0);
  if (d <= new Date()) d.setDate(d.getDate() + 1);
  return d.getTime();
}
async function digest() {
  const st = await loadPlan();
  const today = todayIso(), tm = new Date(); tm.setDate(tm.getDate() + 1);
  const tmr = iso(tm), open = st.tasks.filter((t) => !t.done && t.d);
  const od = open.filter((t) => t.d < today), dt = open.filter((t) => t.d === today), dm = open.filter((t) => t.d === tmr);
  if (!od.length && !dt.length && !dm.length) return;
  const parts = [];
  if (dt.length) parts.push('Today: ' + dt.slice(0, 3).map((t) => t.t).join(', ') + (dt.length > 3 ? ' +' + (dt.length - 3) : ''));
  if (dm.length) parts.push('Tomorrow: ' + dm.slice(0, 3).map((t) => t.t).join(', ') + (dm.length > 3 ? ' +' + (dm.length - 3) : ''));
  if (od.length) parts.push(od.length + ' overdue');
  const hrs = Math.round(dt.concat(dm).reduce((a, t) => a + (t.inClass ? 0 : Math.max(0, need(t, st.cfg.pace) - (t.spent || 0))), 0) / 6) / 10;
  ext.notifications.create('digest', { title: 'Your day' + (hrs ? ' · about ' + hrs + 'h of work due soon' : ''), message: parts.join('\n'), priority: 1 });
}

/* ================= alarms + setup ================= */
async function setupAlarms(syncSoon) {
  const st = await loadPlan();
  await ext.alarms.clear('sync');
  if (st.canvas.auto !== false && (st.canvas.host || st.feeds.length)) {
    ext.alarms.create('sync', { delayInMinutes: syncSoon ? 0.1 : Math.max(15, +st.canvas.interval || 60), periodInMinutes: Math.max(15, +st.canvas.interval || 60) });
  }
  await ext.alarms.clear('digest');
  if (st.cfg.digest !== false) ext.alarms.create('digest', { when: nextAt(st.cfg.digestTime), periodInMinutes: 1440 });
  ext.alarms.create('midnight', { when: nextAt('00:01'), periodInMinutes: 1440 });
  ext.alarms.create('backup', { delayInMinutes: 2, periodInMinutes: 60 });
}

/* ================= backups ================= */
// Your account already keeps everything; these files are an extra copy in Downloads (needs the companion).
const BK_DIR = 'Triaj Backups';
async function bkState() { return (await ext.storage.local.get('bkState')).bkState || { files: [] }; }
async function fileBackup(reason) {
  const st = await loadPlan(), bs = await bkState();
  bs.files = bs.files || [];
  let ok = false;
  try { ok = await ext.permissions.contains({ permissions: ['downloads'] }); } catch (e) {}
  if (!ok) { bs.lastErr = 'Saving backup files is not turned on yet.'; await ext.storage.local.set({ bkState: bs }); return { kind: 'err', text: bs.lastErr }; }
  const b = await makeBackup(st.cfg.backupSecrets !== false);
  b.reason = reason || 'daily';
  const url = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(b, null, 1));
  const day = todayIso();
  const res = await downloadAll([
    { url, path: BK_DIR + '/triaj-backup-latest.json' },
    { url, path: BK_DIR + '/triaj-backup-' + day + '.json', key: 'dated' }
  ]);
  if (res.failed.length) {
    bs.lastErr = 'Could not save the backup file: ' + res.failed[0].err;
    await ext.storage.local.set({ bkState: bs });
    return { kind: 'err', text: bs.lastErr };
  }
  // Keep one dated file per day, for the last 14 days that had a backup.
  const dated = res.ok.find((x) => x.key === 'dated');
  bs.files = bs.files.filter((f) => f.d !== day);
  if (dated) bs.files.unshift({ d: day, id: dated.id });
  for (const old of bs.files.slice(14)) { try { await ext.downloads.removeFile(old.id); } catch (e) {} }
  bs.files = bs.files.slice(0, 14);
  Object.assign(bs, { lastAt: new Date().toISOString(), lastErr: '', lastTasks: b.summary.tasks, latestId: (res.ok.find((x) => !x.key) || {}).id });
  await ext.storage.local.set({ bkState: bs });
  return { kind: 'ok', text: 'Backup saved to Downloads/' + BK_DIR };
}
async function backupCheck() {
  await unblockSweep(); // also checks off in-class items whose class is over
  await snapshot('Daily copy');
  const st = await loadPlan(), bs = await bkState();
  if (st.cfg.autoBackup === false || !bridge.available()) return;
  if (!bs.lastAt || Date.now() - new Date(bs.lastAt) > 20 * 3600e3) await fileBackup('daily');
}

/* ================= blockers ================= */
async function unblockSweep() {
  let ready = [];
  await updatePlan((st) => { sweepInClass(st); ready = sweepBlocks(st); });
  if (ready.length) {
    ext.notifications.create('unblocked', { title: '🔓 Ready to start now',
      message: ready.map((t) => t.t).slice(0, 4).join(', ') + (ready.length > 4 ? ' +' + (ready.length - 4) + ' more' : '') });
  }
}

ext.alarms.onAlarm.addListener(async (a) => {
  if (a.name === 'timer-end') await completePhase(true);
  else if (a.name === 'refocus') await refocusNudge();
  else if (a.name === 'badge') {
    const t = await getTimer();
    if (t.status === 'running' && Date.now() >= t.endAt) await completePhase(true); else await updateBadge(t);
  }
  else if (a.name === 'sync') { await syncAll(false); await unblockSweep(); }
  else if (a.name === 'backup') await backupCheck();
  else if (a.name === 'digest') await digest();
  else if (a.name === 'midnight') { await updatePlan((st) => { releaseHeld(st); }); await unblockSweep(); }
});

ext.notifications.onButtonClicked.addListener(async (id, idx) => {
  ext.notifications.clear(id);
  if (id !== 'timer') return;
  const t = await getTimer();
  if (idx === 1) return timerOp({ op: 'stop' });
  if (t.status === 'ready') return timerOp({ op: 'start' });
  if (t.status === 'running' && t.phase === 'work') return timerOp({ op: 'pause' });
  if (t.status === 'running') return timerOp({ op: 'skip' });
});
ext.notifications.onClicked.addListener((id) => { ext.notifications.clear(id); openPlanner(id === 'sync' || id === 'unblocked' ? 'tasks' : id === 'timer' || id === 'refocus' ? 'focus' : 'now'); });

// Same shortcut the extension had, while Triaj is the focused tab.
document.addEventListener('keydown', (e) => {
  if (e.altKey && e.shiftKey && e.code === 'KeyF') { e.preventDefault(); timerOp({ op: 'toggle' }); }
});

// "Sync from this tab" in the companion leaves a scan for the page to pick up.
async function takeScan() {
  const r = await bridge.call('scan.take');
  if (r && r.data && Array.isArray(r.data.items)) return syncCanvas(true, r.data, 'your open Canvas tab');
  return null;
}
bridge.on('scan', () => { takeScan(); });

async function handle(m) {
  if (!m) return null;
  if (m.cmd === 'timer') return timerOp(m);
  if (m.cmd === 'importScan') {
    if (!m.data || !Array.isArray(m.data.items)) return { kind: 'err', text: 'Nothing was read from that tab.' };
    return syncCanvas(true, m.data, 'this Canvas tab');
  }
  if (m.cmd === 'sync') {
    if (m.what === 'canvas') return syncCanvas(true);
    if (m.what === 'feed') { const st = await loadPlan(); const f = st.feeds.find((x) => x.id === m.id); return f ? syncFeed(f) : null; }
    return syncAll(true);
  }
  if (m.cmd === 'backupNow') return fileBackup(m.reason || 'manual');
  if (m.cmd === 'snapshot') return snapshot(m.reason || 'Manual', true);
  if (m.cmd === 'reschedule') {
    await setupAlarms(!!m.syncSoon); await updateBadge();
    const st = await loadPlan();
    bridge.call('config', { canvasHost: st.canvas.host || '' });
    return true;
  }
  if (m.cmd === 'open') { openPlanner(m.hash); return true; }
  if (m.cmd === 'preview') { playSound(m.sound, m.volume); return true; }
  return null;
}
ext.runtime.setHandler((m) => handle(m).catch((e) => ({ kind: 'err', text: String(e && e.message || e) })));

export async function start() {
  // A copy of the data as it was before a new version of Triaj touches it.
  const v = (await ext.storage.local.get('appVersion')).appVersion;
  if (v && v !== APP_VERSION) await snapshot('Before update from v' + v + ' to v' + APP_VERSION, true);
  if (v !== APP_VERSION) await ext.storage.local.set({ appVersion: APP_VERSION });
  // Opening Triaj counts as "the browser started": sync soon, then on the usual schedule.
  if (isLeader()) await setupAlarms(true);
  else setTimeout(() => { if (isLeader()) setupAlarms(true); }, 1500);
  await updateBadge();
  const ok = await bridge.whenReady(1500);
  if (ok) {
    const st = await loadPlan();
    bridge.call('config', { canvasHost: st.canvas.host || '', site: location.origin + location.pathname });
    takeScan();
  }
}
