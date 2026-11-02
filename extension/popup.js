// Toolbar popup: the focus timer, site blocking, what's due, Canvas sync, and "Sync from this tab".
// Tasks and settings come from the mirror the Triaj website sends; the timer runs in background.js.
const B = globalThis.browser || globalThis.chrome;
const $ = (id) => document.getElementById(id);
const send = (cmd, args) => B.runtime.sendMessage({ triaj: 1, cmd, args: args || {} }).catch(() => null);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const LABEL = { work: 'Focus', short: 'Short break', long: 'Long break' };
const PRESETS = [{ id: 'pomo', name: 'Pomodoro', work: 25, short: 5, long: 15, rounds: 4 }];
const fmt = (s) => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

let m = {}, timer = { status: 'idle', phase: 'work' }, pickTid = 0, busy = false, tab = null, tabMsg = null, canvasHost = '';
const presets = () => (m.timer && m.timer.presets && m.timer.presets.length ? m.timer.presets : PRESETS);
const presetId = () => (timer.status === 'idle' && m.timer && m.timer.presetId) || timer.presetId || (m.timer && m.timer.presetId) || presets()[0].id;
const preset = () => presets().find((p) => p.id === presetId()) || presets()[0];
const left = () => (timer.status === 'running' ? Math.max(0, Math.round((timer.endAt - Date.now()) / 1000)) : timer.left || 0);
const open = () => m.tasks || [];
const ready = () => open().filter((t) => !t.blocked && !t.inClass);
const need = (t) => (t.fixed > 0 ? t.fixed : Math.ceil((t.est || 60) * (m.pace || 1)));
function ago(s) { if (!s) return 'never'; const n = Math.round((Date.now() - new Date(s)) / 60000); return n < 2 ? 'just now' : n < 60 ? n + ' min ago' : Math.round(n / 60) + ' h ago'; }
function topTask() {
  const today = iso(new Date());
  return ready().slice().sort((a, b) => ((a.d || '9999') !== (b.d || '9999') ? ((a.d || '9999') < (b.d || '9999') ? -1 : 1) : ({ h: 0, m: 1, l: 2 }[a.p] - { h: 0, m: 1, l: 2 }[b.p]))).find((t) => !t.d || t.d >= today) || ready()[0];
}
function theme() {
  const v = m.vars; if (!v) return;
  ['bg', 'card', 'ink', 'mute', 'line', 'soft', 'pri', 'onpri', 'hdr', 'now', 'soon', 'later', 'field'].forEach((k) => { if (v[k]) document.documentElement.style.setProperty('--' + k, v[k]); });
}

function renderTimer() {
  const p = preset(), ph = timer.phase || 'work', brk = ph !== 'work', idle = timer.status === 'idle';
  if (!pickTid) { const t = topTask(); pickTid = t ? t.id : 0; }
  const tid = idle ? pickTid : timer.tid, task = open().find((x) => x.id === tid);
  const secs = idle ? p.work * 60 : left(), total = idle ? p.work * 60 : (timer.total || 1);
  const head = idle ? 'Ready' : timer.status === 'ready' ? 'Up next: ' + LABEL[ph] : timer.status === 'paused' ? 'Paused' : LABEL[ph];
  let h = '<span class="phase' + (brk ? ' brk' : '') + '">' + head + '</span><div class="time' + (brk ? ' brk' : '') + '" id="t">' + fmt(secs) + '</div>' +
    '<div class="bar"><span id="bar" style="width:' + Math.round((1 - secs / total) * 100) + '%;' + (brk ? 'background:var(--later)' : '') + '"></span></div>' +
    '<div class="task">' + (brk ? 'Stretch, water, eyes off the screen' : esc(task ? task.t : 'Just focus')) + '</div>';
  if (idle) {
    h += '<select id="task"><option value="0">Just focus (no task)</option>' + open().filter((t) => !t.inClass).slice(0, 60).map((t) => '<option value="' + t.id + '"' + (t.id === pickTid ? ' selected' : '') + '>' + esc(t.t) + '</option>').join('') + '</select>' +
      '<div class="pills">' + presets().map((x) => '<button class="pill' + (x.id === presetId() ? ' on' : '') + '" data-preset="' + esc(x.id) + '">' + esc(x.name) + ' ' + x.work + 'm</button>').join('') + '</div>' +
      '<div class="row"><button class="b" data-op="start">Start ' + p.work + ' min</button><button class="b sec" data-op="start5">5 min</button></div>';
  } else if (timer.status === 'ready') {
    h += '<div class="row"><button class="b" data-op="start">Start ' + LABEL[ph].toLowerCase() + '</button><button class="b mute" data-op="stop">Done for now</button></div>';
  } else {
    h += '<div class="row">' + (timer.status === 'running' ? '<button class="b" data-op="pause">Pause</button>' : '<button class="b" data-op="resume">Resume</button>') +
      '<button class="b sec" data-op="skip">' + (brk ? 'Skip break' : 'Finish') + '</button><button class="b mute" data-op="stop">Stop</button></div>' +
      (brk ? '' : '<div class="row"><button class="b sec" data-op="distracted">I got distracted</button><button class="b sec" data-op="add">+5 min</button></div>');
  }
  $('timer').innerHTML = h;
}

function renderBlock() {
  const b = m.focusBlock || {}, sites = (b.sites || []).length;
  const running = timer.status === 'running' && timer.phase === 'work';
  $('block').innerHTML = '<div class="blk"><div class="t"><b class="t">Block distractions</b><div class="s">' +
    (!sites ? 'Add sites on Triaj\'s Focus page.' : b.on ? (running ? 'Blocking ' + sites + ' site' + (sites === 1 ? '' : 's') + ' right now.' : sites + ' site' + (sites === 1 ? '' : 's') + ' blocked while you focus.') : 'Off. ' + sites + ' site' + (sites === 1 ? '' : 's') + ' on your list.') +
    '</div></div><button class="sw' + (b.on ? ' on' : '') + '" id="bsw" role="switch" aria-checked="' + !!b.on + '" aria-label="Block distracting sites during focus"' + (sites ? '' : ' disabled') + '></button></div>';
}

function renderToday() {
  const today = iso(new Date()), tm = new Date(); tm.setDate(tm.getDate() + 1);
  const tmr = iso(tm);
  const list = open().filter((t) => t.d && t.d <= tmr).sort((a, b) => (a.d < b.d ? -1 : 1));
  const goal = m.goal || 90, fm = m.focusToday || 0;
  $('today').innerHTML = '<div class="hd"><b class="t">Due soon</b><span class="s">Focus ' + fm + ' of ' + goal + ' min</span></div><div class="due">' +
    (list.length ? list.slice(0, 6).map((t) => {
      const when = t.d < today ? '<b class="err">overdue</b>' : t.d === today ? 'today' : 'tomorrow';
      return '<div><span><i class="' + (t.d <= today ? 'n' : 'o') + '"></i>' + esc(t.t) + '</span><span class="s">' + when + (t.inClass ? ', in class' : ', ~' + Math.round(Math.max(0, need(t) - (t.spent || 0)) / 6) / 10 + 'h') + '</span></div>';
    }).join('') : '<div><span class="s">' + (m.at ? 'Nothing due today or tomorrow.' : 'Open Triaj once and your tasks show up here.') + '</span></div>') + '</div>';
}

async function renderSync() {
  const cv = m.canvas || {}, host = cv.host || canvasHost;
  const onCanvas = tab && host && new URL(tab.url).hostname === host;
  let h;
  if (!host) h = '<b class="t">Canvas</b><div class="s" style="margin:3px 0 0">Not connected. In Triaj: More, then Sync.</div>';
  else {
    let perm = true;
    try { perm = await B.permissions.contains({ origins: ['https://' + host + '/*'] }); } catch (e) {}
    const s = cv.lastStatus || {};
    h = '<div class="hd"><b class="t">Canvas</b><span class="s">' + esc(host) + '</span></div><div class="s ' + (!perm || s.kind === 'err' ? 'err' : '') + '">' +
      (!perm ? 'Access is off. Use Sync from this tab on Canvas, or allow access in Triaj.' : s.kind === 'err' ? esc(s.text) : 'Synced ' + ago(cv.lastSync) + (s.text ? ': ' + esc(s.text) : '')) + '</div>' +
      '<div class="row">' + (onCanvas ? '<button class="b" data-op="tabsync"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Reading Canvas…' : 'Sync from this tab') + '</button>' : '<button class="b sec" data-op="sync"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Syncing…' : 'Sync now') + '</button>') + '</div>' +
      (tabMsg ? '<div class="s ' + (tabMsg.kind === 'err' ? 'err' : 'ok') + '" style="margin-top:6px">' + esc(tabMsg.text) + '</div>' : '');
  }
  $('sync').innerHTML = h;
}

function render() { theme(); renderTimer(); renderBlock(); renderToday(); renderSync(); }

document.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  if (b.id === 'open') { await send('open'); window.close(); return; }
  if (b.dataset.open) { await send('open', { hash: b.dataset.open }); window.close(); return; }
  if (b.id === 'bsw') { const on = !(m.focusBlock && m.focusBlock.on); await send('setBlock', { on }); m.focusBlock = Object.assign({}, m.focusBlock, { on }); renderBlock(); return; }
  if (b.dataset.preset) { timer.presetId = b.dataset.preset; if (m.timer) m.timer.presetId = b.dataset.preset; await send('preset', { id: b.dataset.preset }); renderTimer(); return; }
  const op = b.dataset.op;
  if (!op) return;
  if (op === 'sync') { busy = true; renderSync(); const r = await send('sync'); busy = false; tabMsg = r && r.opened ? { kind: 'ok', text: 'Opened Triaj. It syncs as it opens.' } : { kind: 'ok', text: 'Syncing in your open Triaj tab.' }; renderSync(); return; }
  if (op === 'tabsync') { busy = true; tabMsg = null; renderSync(); tabMsg = await send('tabSync', { tabId: tab.id }); busy = false; renderSync(); return; }
  let r;
  if (op === 'start') r = await send('timer', { op: 'start', tid: timer.status === 'idle' ? pickTid : undefined, presetId: timer.status === 'idle' ? presetId() : undefined });
  else if (op === 'start5') r = await send('timer', { op: 'start', tid: pickTid, minutes: 5 });
  else if (op === 'add') r = await send('timer', { op: 'add', minutes: 5 });
  else r = await send('timer', { op });
  if (r && r.status) { timer = r; render(); }
});
document.addEventListener('change', (e) => { if (e.target.id === 'task') { pickTid = +e.target.value || 0; renderTimer(); } });

B.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local') return;
  if (ch.mirror && ch.mirror.newValue) m = ch.mirror.newValue;
  if (ch.timer && ch.timer.newValue) timer = ch.timer.newValue;
  if (ch.mirror || ch.timer) render();
});
setInterval(() => {
  if (timer.status !== 'running') return;
  const s = left(), el = $('t'), bar = $('bar');
  if (el) el.textContent = fmt(s);
  if (bar) bar.style.width = Math.round((1 - s / (timer.total || 1)) * 100) + '%';
  if (s <= 0) send('timer', { op: 'tick' });
}, 1000);

(async () => {
  const d = await B.storage.local.get(['mirror', 'timer', 'canvasHost']);
  m = d.mirror || {};
  timer = d.timer || { status: 'idle', phase: 'work' };
  canvasHost = d.canvasHost || '';
  try { const [t] = await B.tabs.query({ active: true, currentWindow: true }); tab = t && t.url && /^https:/.test(t.url) ? t : null; } catch (e) {}
  render();
})();
