// Shown instead of a blocked site while a focus round runs.
const B = globalThis.browser || globalThis.chrome;
const p = new URLSearchParams(location.search);
const host = p.get('h') || '';
// Only ever send you back to the site that was blocked.
let orig = 'https://' + host + '/';
try { const u = new URL(p.get('u') || ''); if (u.protocol === 'https:' && (u.hostname === host || u.hostname.endsWith('.' + host))) orig = u.href; } catch (e) {}
const $ = (id) => document.getElementById(id);
const send = (cmd, args) => B.runtime.sendMessage({ triaj: 1, cmd, args: args || {} });
const fmt = (s) => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
$('site').textContent = host;
let t = null;

function paint() {
  if (!t) return;
  const running = t.status === 'running' && t.phase === 'work';
  if (!running) {
    $('head').textContent = t.status === 'running' ? 'You\'re on a break. Go ahead.' : 'Focus round is over.';
    $('clock').textContent = '';
    $('on').textContent = '';
    $('pass').textContent = 'Open ' + host;
    return;
  }
  $('clock').textContent = fmt(Math.max(0, Math.round((t.endAt - Date.now()) / 1000)));
}
async function load() {
  const r = await send('block.state', { h: host }).catch(() => null);
  if (!r) return;
  t = r.timer;
  if (r.vars) ['bg', 'card', 'ink', 'mute', 'line', 'soft', 'pri', 'onpri', 'now', 'later'].forEach((k) => { if (r.vars[k]) document.documentElement.style.setProperty('--' + k, r.vars[k]); });
  $('on').textContent = r.task ? 'You\'re working on ' + r.task + '.' : 'Left in this focus round.';
  document.title = (t.status === 'running' && t.phase === 'work' ? fmt(Math.max(0, Math.round((t.endAt - Date.now()) / 1000))) + ' · ' : '') + 'Back to focus';
  paint();
}
$('back').onclick = () => { if (history.length > 1) history.back(); else send('open', { hash: 'focus' }).then(() => window.close()); };
$('pass').onclick = async () => {
  if (t && t.status === 'running' && t.phase === 'work') await send('block.pass', { h: host, minutes: 5 });
  location.href = orig;
};
setInterval(paint, 1000);
setInterval(load, 15000);
load();
