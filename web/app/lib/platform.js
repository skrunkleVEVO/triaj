// Stands in for the chrome.* extension APIs the planner was first written against, so the same
// code runs as a website:
//   storage      IndexedDB (one namespace per account), shared live between tabs, plan + download log
//                mirrored to your account by cloud.js
//   runtime      sendMessage goes to the engine (engine.js) running in this page
//   permissions  site access for Canvas / calendars / downloads is asked for by the companion extension
//   alarms       persisted timers; one tab at a time (the "leader") fires them
//   notifications  system notifications through the service worker (with action buttons where supported)
import * as bridge from './bridge.js';

export const APP_VERSION = '3.1.0';
export const ICON = new URL('../assets/icon-192.png', location.href).href;
export const CLOUD_KEYS = ['plan', 'dlog'];
const TAB = 'tab:' + Math.random().toString(36).slice(2);

let ns = 'guest';
const cache = new Map();
const changeL = [];
let bc = null, cloud = null;
const clone = (v) => (v === undefined ? undefined : structuredClone(v));

/* ---------------- IndexedDB key/value ---------------- */
let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open('triaj', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }).catch((e) => { console.warn('IndexedDB unavailable, keeping data in memory only', e); return null; });
  return dbp;
}
async function idbPut(key, value) {
  const d = await db(); if (!d) return;
  const tx = d.transaction('kv', 'readwrite');
  if (value === undefined) tx.objectStore('kv').delete(ns + '/' + key); else tx.objectStore('kv').put(value, ns + '/' + key);
}
async function idbAll(space) {
  const d = await db(); if (!d) return {};
  return new Promise((res) => {
    const out = {}, range = IDBKeyRange.bound(space + '/', space + '/￿');
    const req = d.transaction('kv').objectStore('kv').openCursor(range);
    req.onsuccess = () => { const c = req.result; if (!c) return res(out); out[String(c.key).slice(space.length + 1)] = c.value; c.continue(); };
    req.onerror = () => res(out);
  });
}
export async function wipe(space) {
  const d = await db(); if (!d) return;
  await new Promise((res) => {
    const tx = d.transaction('kv', 'readwrite');
    tx.objectStore('kv').delete(IDBKeyRange.bound(space + '/', space + '/￿'));
    tx.oncomplete = res; tx.onerror = res;
  });
}
export const readSpace = idbAll;

/* ---------------- storage ---------------- */
function emit(changes) {
  setTimeout(() => changeL.forEach((fn) => { try { fn(changes, 'local'); } catch (e) { console.error(e); } }), 0);
}
// Write locally (cache now, disk soon), tell the other tabs, and hand synced keys to the cloud.
function put(obj, fromCloud) {
  const changes = {};
  Object.keys(obj).forEach((k) => {
    const v = clone(obj[k]);
    changes[k] = { oldValue: cache.get(k), newValue: v };
    if (v === undefined) cache.delete(k); else cache.set(k, v);
    idbPut(k, v);
  });
  if (bc) try { bc.postMessage({ from: TAB, set: obj }); } catch (e) {}
  emit(changes);
  if (cloud && !fromCloud) Object.keys(obj).forEach((k) => { if (CLOUD_KEYS.includes(k)) cloud.push(k, cache.get(k)); });
}
const storage = {
  local: {
    async get(keys) {
      const list = keys == null ? [...cache.keys()] : Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
      const out = {};
      list.forEach((k) => { if (cache.has(k)) out[k] = clone(cache.get(k)); });
      return out;
    },
    async set(obj) { put(obj); },
    async remove(keys) { const o = {}; [].concat(keys).forEach((k) => { o[k] = undefined; }); put(o); }
  },
  onChanged: { addListener: (fn) => changeL.push(fn) }
};
// A change that arrived from your account (another device). Not pushed back up.
export function applyRemote(key, value) { put({ [key]: value }, true); }
export function peek(key) { return clone(cache.get(key)); }
export function setCloud(c) { cloud = c; }
export const tabId = TAB;

export async function init(space) {
  ns = space;
  cache.clear();
  const all = await idbAll(ns);
  Object.keys(all).forEach((k) => cache.set(k, all[k]));
  if ('BroadcastChannel' in window) {
    bc = new BroadcastChannel('triaj:' + ns);
    bc.onmessage = (e) => {
      const m = e.data; if (!m || m.from === TAB || !m.set) return;
      const changes = {};
      Object.keys(m.set).forEach((k) => {
        changes[k] = { oldValue: cache.get(k), newValue: clone(m.set[k]) };
        if (m.set[k] === undefined) cache.delete(k); else cache.set(k, clone(m.set[k]));
      });
      emit(changes);
    };
  }
  startLeader();
}
export const namespace = () => ns;

/* ---------------- runtime ---------------- */
let handler = null;
const runtime = {
  sendMessage: (m) => (handler ? Promise.resolve().then(() => handler(m)) : Promise.resolve(null)),
  getManifest: () => ({ version: APP_VERSION }),
  setHandler: (fn) => { handler = fn; }
};

/* ---------------- permissions ---------------- */
// AI providers allow calls straight from a web page; everything else goes through the companion.
const OPEN = [/^https:\/\/generativelanguage\.googleapis\.com\//, /^https:\/\/api\.anthropic\.com\//];
const isOpen = (q) => !(q.permissions || []).length && (q.origins || []).every((o) => OPEN.some((re) => re.test(o)));
const permL = { added: [], removed: [] };
bridge.on('perm', (d) => (permL[d && d.removed ? 'removed' : 'added']).forEach((fn) => fn(d)));
bridge.on('ready', () => permL.added.forEach((fn) => fn({})));
export function needCompanion(why) { window.dispatchEvent(new CustomEvent('triaj:companion', { detail: why || '' })); }
const permissions = {
  async contains(q) {
    if (isOpen(q)) return true;
    const r = await bridge.call('perm.contains', q);
    return !!(r && r.ok);
  },
  async request(q) {
    if (isOpen(q)) return true;
    if (!bridge.available()) { needCompanion('permission'); return false; }
    const r = await bridge.call('perm.request', q, 15 * 60000);
    return !!(r && r.ok);
  },
  async remove(q) { if (isOpen(q)) return true; const r = await bridge.call('perm.remove', q); return !!(r && r.ok); },
  onAdded: { addListener: (fn) => permL.added.push(fn) },
  onRemoved: { addListener: (fn) => permL.removed.push(fn) }
};

/* ---------------- downloads ---------------- */
const downloads = {
  show: (id) => bridge.call('dl.show', { id }),
  removeFile: (id) => bridge.call('dl.remove', { id }),
  erase: () => Promise.resolve()
};

/* ---------------- alarms ---------------- */
const alarmL = [];
let leader = false, firing = false;
function startLeader() {
  const go = () => { leader = true; tick(); };
  if (navigator.locks && navigator.locks.request) navigator.locks.request('triaj-leader:' + ns, () => { go(); return new Promise(() => {}); });
  else go();
  // A worker's clock is not slowed down when this tab is in the background, so timers end on time.
  try {
    const w = new Worker(URL.createObjectURL(new Blob(['setInterval(function(){postMessage(0)},1000)'], { type: 'text/javascript' })));
    w.onmessage = tick;
  } catch (e) { setInterval(tick, 1000); }
}
export const isLeader = () => leader;
async function tick() {
  if (!leader || firing) return;
  const now = Date.now(), A = clone(cache.get('alarms')) || {};
  const due = Object.values(A).filter((a) => a.when <= now);
  if (!due.length) return;
  firing = true;
  due.forEach((a) => {
    if (a.period) { const p = a.period * 60000; let w = a.when; while (w <= now) w += p; A[a.name] = Object.assign({}, a, { when: w }); }
    else delete A[a.name];
  });
  put({ alarms: A });
  for (const a of due) for (const fn of alarmL) { try { await fn({ name: a.name }); } catch (e) { console.error(e); } }
  firing = false;
}
const alarms = {
  create(name, o) {
    const A = clone(cache.get('alarms')) || {};
    const when = o.when || Date.now() + (o.delayInMinutes !== undefined ? o.delayInMinutes : o.periodInMinutes || 0) * 60000;
    A[name] = { name, when, period: o.periodInMinutes || 0 };
    put({ alarms: A });
    return Promise.resolve();
  },
  clear(name) {
    const A = clone(cache.get('alarms')) || {};
    const had = !!A[name];
    if (had) { delete A[name]; put({ alarms: A }); }
    return Promise.resolve(had);
  },
  onAlarm: { addListener: (fn) => alarmL.push(fn) }
};

/* ---------------- notifications ---------------- */
const nL = { click: [], button: [] };
async function reg() { try { return navigator.serviceWorker ? await navigator.serviceWorker.getRegistration() : null; } catch (e) { return null; } }
if (navigator.serviceWorker) navigator.serviceWorker.addEventListener('message', (e) => {
  const m = e.data; if (!m || m.type !== 'notification') return;
  if (m.action !== undefined && m.action !== '') nL.button.forEach((fn) => fn(m.id, +m.action));
  else nL.click.forEach((fn) => fn(m.id));
});
const notifications = {
  // Must be called from a click so the browser shows its prompt.
  ask() { try { if ('Notification' in window && Notification.permission === 'default') return Notification.requestPermission(); } catch (e) {} return Promise.resolve(); },
  async create(id, o) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const opts = { body: o.message, icon: ICON, badge: ICON, tag: id, silent: !!o.silent, requireInteraction: o.priority === 2, data: { id } };
    const r = await reg();
    if (r) {
      if (o.buttons) opts.actions = o.buttons.map((b, i) => ({ action: String(i), title: b.title }));
      try { await r.showNotification(o.title, opts); return; } catch (e) {}
    }
    try { const n = new Notification(o.title, opts); n.onclick = () => { window.focus(); n.close(); nL.click.forEach((fn) => fn(id)); }; } catch (e) {}
  },
  async clear(id) { const r = await reg(); if (r) try { (await r.getNotifications({ tag: id })).forEach((n) => n.close()); } catch (e) {} },
  onClicked: { addListener: (fn) => nL.click.push(fn) },
  onButtonClicked: { addListener: (fn) => nL.button.push(fn) }
};

/* ---------------- badge (installed app icon) ---------------- */
const action = {
  async setBadge(n) {
    try { if (n && navigator.setAppBadge) await navigator.setAppBadge(n); else if (navigator.clearAppBadge) await navigator.clearAppBadge(); } catch (e) {}
  }
};

export const ext = { storage, runtime, permissions, downloads, alarms, notifications, action };
