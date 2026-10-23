// Talks to the Triaj companion extension, if this browser has it. The extension's content script
// relays these messages to its background worker, which can read Canvas and calendar sites with
// your sign-in (a normal web page is not allowed to) and save files into your Downloads folder.

const listeners = {};
const pending = new Map();
let seq = 0, info = null;
let readyResolve;
const readyP = new Promise((r) => { readyResolve = r; });

function emit(name, data) { (listeners[name] || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); }
export function on(name, fn) { (listeners[name] = listeners[name] || []).push(fn); }

window.addEventListener('message', (e) => {
  const m = e.data;
  if (e.source !== window || !m || m.src !== 'triaj-ext') return;
  if (m.type === 'ready') {
    const first = !info;
    info = m.info || { version: '?' };
    readyResolve(true);
    if (first) emit('ready', info);
  } else if (m.type === 'reply') {
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); clearTimeout(p.t); p.resolve(m.reply); }
  } else if (m.type === 'event') emit(m.name, m.data);
});
window.postMessage({ src: 'triaj-page', type: 'hello' }, location.origin);

export const available = () => !!info;
export const version = () => (info ? info.version : '');
// Resolves true once the companion answers, or false after ms (it usually answers within a few ms).
export function whenReady(ms) {
  if (info) return Promise.resolve(true);
  return Promise.race([readyP, new Promise((r) => setTimeout(() => r(false), ms === undefined ? 1200 : ms))]);
}

export function call(cmd, args, timeout) {
  if (!info) return Promise.resolve({ error: 'no-extension', noext: true });
  const id = ++seq;
  return new Promise((resolve) => {
    const t = setTimeout(() => { pending.delete(id); resolve({ error: 'The Triaj companion did not answer. Reload this page.' }); }, timeout || 120000);
    pending.set(id, { resolve, t });
    window.postMessage({ src: 'triaj-page', type: 'call', id, cmd, args: args || {} }, location.origin);
  });
}

function b64ToBuf(s) {
  const bin = atob(s || ''), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u.buffer;
}

// fetch() through the extension, with your cookies for that site. Returns a Response-like object.
// init.as = 'base64' fetches binary (PDFs); the default reads text.
export async function fetch(url, init) {
  init = init || {};
  const r = await call('fetch', {
    url: String(url), as: init.as || 'text',
    init: { method: init.method || 'GET', headers: init.headers || {}, body: init.body, credentials: init.credentials || 'include', cache: init.cache }
  });
  if (!r || r.error) {
    const e = new TypeError((r && r.error) || 'Failed to fetch');
    if (r && r.perm === false) e.perm = true;
    if (r && r.noext) e.noext = true;
    throw e;
  }
  const H = r.headers || {};
  return {
    ok: r.ok, status: r.status, url: r.url, redirected: r.redirected,
    headers: { get: (k) => (H[String(k).toLowerCase()] !== undefined ? H[String(k).toLowerCase()] : null) },
    text: async () => (init.as === 'base64' ? atob(r.body || '') : r.body),
    json: async () => JSON.parse(r.body),
    arrayBuffer: async () => (init.as === 'base64' ? b64ToBuf(r.body) : new TextEncoder().encode(r.body).buffer)
  };
}
