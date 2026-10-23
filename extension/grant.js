// Shows what the Triaj website asked for and lets you allow it with one click
// (the browser only shows its permission prompt after a click on an extension page).
const B = globalThis.browser || globalThis.chrome;
const p = new URLSearchParams(location.search);
const id = p.get('id'), why = p.get('why');
let q = {};
try { q = JSON.parse(p.get('q') || '{}'); } catch (e) {}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hosts = [...new Set((q.origins || []).map((o) => o.replace(/^https?:\/\/(\*\.)?/, '').replace(/\/\*$/, '')))];
const items = [];
if (why === 'block') items.push('Show a “back to focus” page instead of ' + hosts.map((h) => '<b>' + esc(h) + '</b>').join(', ') + ' while a focus round is running.');
else hosts.forEach((h) => items.push('Read <b>' + esc(h) + '</b> with your sign-in, to sync it into your planner.'));
(q.permissions || []).forEach((x) => { if (x === 'downloads') items.push('Save files into your <b>Downloads</b> folder.'); });
const ul = document.getElementById('what');
ul.innerHTML = items.length ? items.map((x) => '<li>' + x + '</li>').join('') : '<li>Nothing. You can close this window.</li>';
const finish = (v) => B.storage.local.set({ ['grant:' + id]: v }).then(() => window.close());
document.getElementById('ok').onclick = () => { B.permissions.request(q).then((ok) => finish(ok ? 'ok' : 'no'), () => finish('no')); };
document.getElementById('no').onclick = () => finish('no');
