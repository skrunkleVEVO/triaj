// The focus timer. Shared by the website (when no companion is installed, or on a phone) and the
// companion extension (which runs it in the background so it keeps going with Triaj closed, shows the
// countdown on the toolbar icon and blocks distracting sites). scripts/sync-extension.mjs copies this
// file into the extension; it must stay self-contained (no imports).
//
// env = {
//   getTimer(), saveTimer(t)                 persisted timer state
//   plan()                                   { timer: cfg.timer, sound: bool, tasks: [{ id, t }] }
//   logFocus(entry)                          { d, m, tid, at } finished minutes, or { d, x: 1, tid, at } a distraction
//   alarms: { create(name, info), clear(name) }
//   notify(id, { title, message, buttons, priority, silent }), clearNotify(id), askNotify()
//   play(sound, volume), ambient(kind, volume), ambientOff()
// }

export const PRESETS = [
  { id: 'pomo', name: 'Pomodoro', work: 25, short: 5, long: 15, rounds: 4 },
  { id: 'deep', name: 'Deep work', work: 50, short: 10, long: 30, rounds: 3 },
  { id: 'sprint', name: 'Sprints', work: 15, short: 3, long: 10, rounds: 4 },
  { id: 'gentle', name: 'Gentle start', work: 10, short: 5, long: 15, rounds: 3 }
];
export const TIMER_IDLE = { phase: 'work', status: 'idle', round: 0, tid: 0, presetId: '', endAt: 0, left: 0, total: 0 };
export const LABEL = { work: 'Focus', short: 'Short break', long: 'Long break' };
export const TIMER_ALARMS = ['timer-end', 'refocus', 'badge'];

export function leftSec(t) { return t.status === 'running' ? Math.max(0, Math.round((t.endAt - Date.now()) / 1000)) : t.left; }

export function createTimer(env) {
  const pad = (n) => String(n).padStart(2, '0');
  const today = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const get = async () => Object.assign({}, TIMER_IDLE, (await env.getTimer()) || {});
  const cfgOf = async () => {
    const p = (await env.plan()) || {};
    const T = Object.assign({ presets: PRESETS, presetId: 'pomo', autoBreak: true, autoWork: false, refocus: 10, refocusSound: 'nudge', endSound: 'chime', breakSound: 'marimba', volume: 0.7, ambient: 'none', ambientVol: 0.25, notify: true }, p.timer || {});
    if (!Array.isArray(T.presets) || !T.presets.length) T.presets = PRESETS;
    return { T, sound: p.sound !== false, tasks: p.tasks || [] };
  };
  const presetOf = (T, id) => T.presets.find((p) => p.id === (id || T.presetId)) || T.presets[0];
  const phaseMin = (p, ph) => (ph === 'work' ? p.work : ph === 'short' ? p.short : p.long);
  const clearAlarms = () => Promise.all(TIMER_ALARMS.map((n) => env.alarms.clear(n)));
  const play = (c, s) => { if (c.sound && s && s !== 'none') return env.play(s, c.T.volume); };
  const ambientOn = (c) => (c.sound && c.T.ambient && c.T.ambient !== 'none' ? env.ambient(c.T.ambient, c.T.ambientVol) : env.ambientOff());

  async function schedule(t, c) {
    await clearAlarms();
    if (t.status !== 'running') return;
    env.alarms.create('timer-end', { when: t.endAt });
    env.alarms.create('badge', { delayInMinutes: 0.5, periodInMinutes: 0.5 });
    const rf = +c.T.refocus || 0;
    if (t.phase === 'work' && rf > 0 && rf * 60 < leftSec(t) - 30) env.alarms.create('refocus', { delayInMinutes: rf, periodInMinutes: rf });
  }

  async function startPhase(phase, o) {
    o = o || {};
    const c = await cfgOf(), cur = await get();
    const p = presetOf(c.T, o.presetId || cur.presetId);
    const mins = +o.minutes > 0 ? +o.minutes : phaseMin(p, phase);
    const t = Object.assign({}, cur, {
      phase, status: 'running', presetId: p.id, total: Math.round(mins * 60), endAt: Date.now() + mins * 60000, left: 0,
      startedAt: Date.now(), custom: +o.minutes > 0, distractions: phase === 'work' ? 0 : (cur.distractions || 0)
    });
    if (o.tid !== undefined) t.tid = +o.tid || 0;
    if (o.resetRound || (o.presetId && o.presetId !== cur.presetId)) t.round = 0;
    await env.saveTimer(t);
    await schedule(t, c);
    if (phase === 'work') await ambientOn(c); else await env.ambientOff();
    env.clearNotify('timer');
    return t;
  }

  async function completePhase(natural, forceStart) {
    const t = await get();
    if (t.status !== 'running' && t.status !== 'paused') return t;
    if (natural && t.status === 'running' && Date.now() < t.endAt - 1500) return t; // fired early: ignore
    const c = await cfgOf(), T = c.T, p = presetOf(T, t.presetId);
    const elapsed = natural ? t.total : t.total - leftSec(t);
    await clearAlarms();
    let mins = 0, next;
    if (t.phase === 'work') {
      mins = Math.round(elapsed / 60);
      if (mins >= 1) await env.logFocus({ d: today(), m: mins, tid: t.tid || 0, at: Date.now() });
      t.round = (t.round || 0) + 1;
      next = t.round % Math.max(1, p.rounds) === 0 ? 'long' : 'short';
    } else next = 'work';
    t.lastDone = { phase: t.phase, mins, at: Date.now() };
    await env.ambientOff();
    if (natural) await play(c, t.phase === 'work' ? T.endSound : T.breakSound);

    const auto = forceStart || (next === 'work' ? T.autoWork : T.autoBreak);
    const nm = phaseMin(p, next);
    Object.assign(t, { phase: next, status: 'ready', total: nm * 60, left: nm * 60, endAt: 0 });
    await env.saveTimer(t);
    if (auto) await startPhase(next);

    if (natural && T.notify !== false) {
      const task = c.tasks.find((x) => x.id === t.tid);
      const title = t.lastDone.phase === 'work' ? 'Focus done: +' + mins + ' min' : 'Break is over';
      const msg = t.lastDone.phase === 'work'
        ? (auto ? 'Your ' + nm + ' min ' + LABEL[next].toLowerCase() + ' has started. Stand up, stretch, drink water.' : 'Time for a ' + nm + ' min ' + LABEL[next].toLowerCase() + '.')
        : (auto ? 'Next focus round started' + (task ? ': ' + task.t : '.') : 'Ready for the next round' + (task ? ' on ' + task.t : '') + '?');
      const buttons = auto ? [{ title: next === 'work' ? 'Pause' : 'Skip break' }, { title: 'Stop' }] : [{ title: 'Start ' + LABEL[next].toLowerCase() }, { title: 'Stop for now' }];
      env.notify('timer', { title, message: msg, buttons, priority: 2 });
    }
    return get();
  }

  async function op(m) {
    const t = await get();
    switch (m.op) {
      case 'start':
        if (env.askNotify) env.askNotify();
        return startPhase(m.phase || (t.status === 'ready' ? t.phase : 'work'), { tid: m.tid, minutes: m.minutes, presetId: m.presetId, resetRound: m.resetRound });
      case 'pause':
        if (t.status !== 'running') return t;
        t.left = leftSec(t); t.status = 'paused';
        await env.saveTimer(t); await schedule(t, await cfgOf()); await env.ambientOff();
        return t;
      case 'resume': {
        if (t.status !== 'paused') return t;
        const c = await cfgOf();
        t.endAt = Date.now() + t.left * 1000; t.status = 'running';
        await env.saveTimer(t); await schedule(t, c);
        if (t.phase === 'work') await ambientOn(c);
        return t;
      }
      case 'toggle':
        if (t.status === 'running') return op({ op: 'pause' });
        if (t.status === 'paused') return op({ op: 'resume' });
        return op({ op: 'start' });
      case 'stop': {
        if ((t.status === 'running' || t.status === 'paused') && t.phase === 'work') {
          const mins = Math.round((t.total - leftSec(t)) / 60);
          if (mins >= 1) await env.logFocus({ d: today(), m: mins, tid: t.tid || 0, at: Date.now() });
        }
        await clearAlarms();
        await env.ambientOff();
        env.clearNotify('timer');
        const s = Object.assign({}, TIMER_IDLE, { tid: t.tid, presetId: t.presetId, round: m.resetRound ? 0 : t.round });
        await env.saveTimer(s);
        return s;
      }
      case 'skip': return completePhase(false, true);
      case 'tick':
        if (t.status === 'running' && Date.now() >= t.endAt) return completePhase(true);
        return t;
      case 'add': {
        if (t.status !== 'running' && t.status !== 'paused') return t;
        const s = (+m.minutes || 5) * 60;
        t.total += s;
        if (t.status === 'running') t.endAt += s * 1000; else t.left += s;
        await env.saveTimer(t); await schedule(t, await cfgOf());
        return t;
      }
      case 'task': t.tid = +m.tid || 0; await env.saveTimer(t); return t;
      case 'distracted':
        t.distractions = (t.distractions || 0) + 1;
        await env.logFocus({ d: today(), x: 1, tid: t.tid || 0, at: Date.now() });
        await env.saveTimer(t);
        return t;
      case 'ambient': {
        const c = await cfgOf();
        if (t.status === 'running' && t.phase === 'work') await ambientOn(c); else await env.ambientOff();
        return t;
      }
      case 'get': return t;
    }
    return t;
  }

  async function refocus() {
    const t = await get();
    if (t.status !== 'running' || t.phase !== 'work') return;
    const c = await cfgOf();
    await play(c, c.T.refocusSound || 'nudge');
    if (c.T.refocusNotify) {
      const task = c.tasks.find((x) => x.id === t.tid);
      env.notify('refocus', { silent: true, title: 'Still with it?', message: (task ? task.t + ': ' : '') + Math.ceil(leftSec(t) / 60) + ' min left in this round.' });
      setTimeout(() => env.clearNotify('refocus'), 8000);
    }
  }

  // Returns true if the alarm belonged to the timer.
  async function onAlarm(name) {
    if (name === 'timer-end') { await completePhase(true); return true; }
    if (name === 'refocus') { await refocus(); return true; }
    if (name === 'badge') {
      const t = await get();
      if (t.status === 'running' && Date.now() >= t.endAt) await completePhase(true); else await env.saveTimer(t, true);
      return true;
    }
    return false;
  }

  // A notification button: 0 = the main action, 1 = stop.
  async function onButton(idx) {
    const t = await get();
    if (idx === 1) return op({ op: 'stop' });
    if (t.status === 'ready') return op({ op: 'start' });
    if (t.status === 'running' && t.phase === 'work') return op({ op: 'pause' });
    if (t.status === 'running') return op({ op: 'skip' });
  }

  return { op, onAlarm, onButton, get };
}
