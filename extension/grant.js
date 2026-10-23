// Shows what the Triaj website asked for and lets you allow it with one click
// (the browser only shows its permission prompt after a click on an extension page).
const B = globalThis.browser || globalThis.chrome;
const p = new URLSearchParams(location.search);
const id = p.get('id');
let q = {};
try { q = JSON.parse(p.get('q') || '{}'); } catch (e) {}
const li = [];
(q.origins || []).forEach((o) => { const h = o.replace(/^https?:\/\//, '').replace(/\/\*$/, ''); li.push('read <b>' + h.replace(/</g, '&lt;') + '</b> with your sign-in, to sync it into your planner'); });
(q.permissions || []).forEach((x) => { if (x === 'downloads') li.push('save files into your <b>Downloads</b> folder'); });
document.getElementById('what').innerHTML = li.map((x) => '<li>' + x + '</li>').join('') || '<li>nothing (you can close this)</li>';
const finish = (v) => B.storage.local.set({ ['grant:' + id]: v }).then(() => window.close());
document.getElementById('ok').onclick = () => {
  B.permissions.request(q).then((ok) => finish(ok ? 'ok' : 'no'), () => finish('no'));
};
document.getElementById('no').onclick = () => finish('no');
