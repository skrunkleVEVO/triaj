// Triaj Companion: what a website can't do on its own.
//   timer      runs the focus timer in the background: toolbar countdown, notifications with buttons,
//              sounds, Alt+Shift+F, and it keeps going with Triaj closed
//   blocking   sends distracting sites to a "back to focus" page while a focus round runs
//   fetch      reads Canvas / private calendar feeds with your sign-in (only sites you allowed)
//   perm.*     asks for and checks that access (a small window shows the browser's prompt)
//   dl.*       saves files into Downloads (course files, backup files)
//   tabSync    reads Canvas from the tab you're on (toolbar popup), then hands it to the website
// The planner itself lives on the website and in your account. The website sends this a small
// "mirror" (open tasks, timer settings, block list, theme) so the popup works with Triaj closed.
import { scanCanvasCore } from './lib/canvas-scan.js';
import { createTimer, leftSec } from './lib/timer-core.js';

const B = globalThis.browser || globalThis.chrome;
const SITE = 'https://skrunklevevo.github.io/triaj/app/';
const ICON = 'icons/icon128.png';

/* ---------------- website tabs (to send them events) ---------------- */
async function siteTabs() { return (await B.storage.local.get('siteTabs')).siteTabs || []; }
async function addSiteTab(id) { const t = await siteTabs(); if (id >= 0 && !t.includes(id)) await B.storage.local.set({ siteTabs: t.concat(id).slice(-20) }); }
async function broadcast(name, data) {
  const keep = [];
  for (const id of await siteTabs()) {
    try { await B.tabs.sendMessage(id, { triajEvent: name, data }); keep.push(id); } catch (e) {}
  }
  await B.storage.local.set({ siteTabs: keep });
  return keep.length;
}
async function mirror() { return (await B.storage.local.get('mirror')).mirror || {}; }
async function siteUrl() { return (await mirror()).site || (await B.storage.local.get('site')).site || SITE; }
async function openSite(hash) {
  for (const id of await siteTabs()) {
    try {
      const t = await B.tabs.update(id, { active: true });
      await B.windows.update(t.windowId, { focused: true });
      if (hash) await B.tabs.sendMessage(id, { triajEvent: 'go', data: { hash } }).catch(() => {});
      return;
    } catch (e) {}
  }
  await B.tabs.create({ url: (await siteUrl()) + (hash ? '#' + hash : '') });
}
B.permissions.onAdded.addListener((p) => broadcast('perm', p));
B.permissions.onRemoved.addListener((p) => broadcast('perm', Object.assign({ removed: true }, p)));

/* ---------------- sound (Chrome: offscreen page; Firefox: right here) ---------------- */
let creating = null, sounds = null;
async function audio(msg) {
  if (!B.offscreen) {
    sounds = sounds || await import('./lib/sounds.js');
    if (msg.cmd === 'play') sounds.playSound(msg.sound, msg.volume);
    else if (msg.cmd === 'ambient') sounds.startAmbient(msg.kind, msg.volume);
    else sounds.stopAmbient();
    return;
  }
  const ctx = await B.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (!ctx.length) {
    if (msg.cmd === 'stopAmbient') return;
    if (!creating) creating = B.offscreen.createDocument({ url: 'offscreen.html', reasons: ['AUDIO_PLAYBACK'], justification: 'Focus timer sounds and background noise' }).catch(() => {}).finally(() => { creating = null; });
    await creating;
  }
  const send = () => B.runtime.sendMessage(Object.assign({ target: 'offscreen' }, msg));
  try { await send(); } catch (e) { await new Promise((r) => setTimeout(r, 250)); try { await send(); } catch (e2) {} }
}

/* ---------------- notifications ---------------- */
async function notify(id, o) {
  const base = { type: 'basic', iconUrl: ICON, title: o.title, message: o.message || '' };
  try { await B.notifications.create(id, Object.assign({}, base, o.buttons ? { buttons: o.buttons } : {}, o.priority ? { priority: o.priority } : {}, o.silent ? { silent: true } : {})); }
  catch (e) { try { await B.notifications.create(id, base); } catch (e2) {} } // Firefox: no buttons
}

/* ---------------- toolbar badge ---------------- */
async function badge(t) {
  const m = await mirror();
  let text = '', color = '#15224A';
  if (!m.timer || m.timer.badge !== false) {
    if (t.status === 'running') { text = Math.ceil(leftSec(t) / 60) + 'm'; color = t.phase === 'work' ? '#E0393E' : '#1F9D84'; }
    else if (t.status === 'paused') { text = 'II'; color = '#6B7280'; }
    else if (t.status === 'ready') { text = '▶'; color = '#E9A100'; }
  }
  await B.action.setBadgeText({ text });
  await B.action.setBadgeBackgroundColor({ color });
  try { await B.action.setBadgeTextColor({ color: '#ffffff' }); } catch (e) {}
}

/* ---------------- focus timer ---------------- */
async function queueFocus(e) {
  const q = (await B.storage.local.get('focusQueue')).focusQueue || [];
  q.push(e);
  await B.storage.local.set({ focusQueue: q.slice(-500) });
  await broadcast('focus');
}
const timer = createTimer({
  getTimer: async () => (await B.storage.local.get('timer')).timer,
  async saveTimer(t, badgeOnly) {
    if (!badgeOnly) { await B.storage.local.set({ timer: t }); broadcast('timer', t); await applyBlocking(t); }
    await badge(t);
  },
  async plan() { const m = await mirror(); return { timer: m.timer, sound: m.sound, tasks: m.tasks || [] }; },
  logFocus: queueFocus,
  alarms: { create: (n, i) => B.alarms.create(n, i), clear: (n) => B.alarms.clear(n) },
  notify,
  clearNotify: (id) => B.notifications.clear(id),
  play: (sound, volume) => audio({ cmd: 'play', sound, volume }),
  ambient: (kind, volume) => audio({ cmd: 'ambient', kind, volume }),
  ambientOff: () => audio({ cmd: 'stopAmbient' })
});

/* ---------------- site blocking during focus ---------------- */
const normHost = (s) => String(s || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').replace(/[/:?#].*$/, '');
async function blockList() {
  const b = (await mirror()).focusBlock || {};
  return b.on ? [...new Set((b.sites || []).map(normHost).filter((h) => h.indexOf('.') > 0))].slice(0, 200) : [];
}
const originsFor = (h) => ['https://' + h + '/*', 'https://*.' + h + '/*'];
async function applyBlocking(t) {
  if (!B.declarativeNetRequest) return;
  t = t || (await B.storage.local.get('timer')).timer || {};
  const focusing = t.status === 'running' && t.phase === 'work';
  const { passes = {}, blockingOn = false } = await B.storage.local.get(['passes', 'blockingOn']);
  const now = Date.now();
  const hosts = focusing ? (await blockList()).filter((h) => !(passes[h] > now)) : [];
  const rules = [], seen = [];
  for (const [i, h] of hosts.entries()) {
    const perm = await B.permissions.contains({ origins: originsFor(h) }).catch(() => false);
    if (perm) seen.push(h);
    rules.push({ id: i + 1, priority: 1, condition: { requestDomains: [h], resourceTypes: ['main_frame'] },
      action: perm ? { type: 'redirect', redirect: { extensionPath: '/blocked.html?h=' + encodeURIComponent(h) } } : { type: 'block' } });
  }
  const old = await B.declarativeNetRequest.getDynamicRules();
  await B.declarativeNetRequest.updateDynamicRules({ removeRuleIds: old.map((r) => r.id), addRules: rules });
  // When focus starts, tabs already open on a blocked site switch over too (sites Triaj may see).
  if (hosts.length && !blockingOn) {
    for (const h of seen) {
      try {
        for (const tab of await B.tabs.query({ url: originsFor(h) })) {
          await B.tabs.update(tab.id, { url: B.runtime.getURL('blocked.html?h=' + encodeURIComponent(h) + '&u=' + encodeURIComponent(tab.url || '')) });
        }
      } catch (e) {}
    }
  }
  await B.storage.local.set({ blockingOn: hosts.length > 0 });
}
async function takePass(h, minutes) {
  const { passes = {} } = await B.storage.local.get('passes');
  const now = Date.now();
  Object.keys(passes).forEach((k) => { if (passes[k] < now) delete passes[k]; });
  passes[normHost(h)] = now + minutes * 60000;
  await B.storage.local.set({ passes });
  B.alarms.create('pass-end', { when: now + minutes * 60000 + 500 });
  await applyBlocking();
}

/* ---------------- fetch with your sign-in ---------------- */
function b64(buf) {
  const u = new Uint8Array(buf); let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
async function doFetch(a) {
  let origin;
  try { origin = new URL(a.url).origin; } catch (e) { return { error: 'Not a valid link' }; }
  if (!/^https:/.test(origin)) return { error: 'Only https:// sites can be read' };
  if (!(await B.permissions.contains({ origins: [origin + '/*'] }))) return { error: 'Triaj is not allowed to read ' + new URL(a.url).hostname + ' yet', perm: false };
  const i = a.init || {};
  let r;
  try { r = await fetch(a.url, { method: i.method || 'GET', headers: i.headers || {}, body: i.body, credentials: i.credentials || 'include', cache: i.cache || 'default', redirect: 'follow' }); }
  catch (e) { return { error: 'Could not reach ' + new URL(a.url).hostname + ': ' + ((e && e.message) || e) }; }
  const headers = {};
  r.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  const body = a.as === 'base64' ? b64(await r.arrayBuffer()) : await r.text();
  return { ok: r.ok, status: r.status, url: r.url, redirected: r.redirected, headers, body };
}

/* ---------------- permissions (asked in a small window) ---------------- */
let gseq = 0;
async function requestPerm(q, why) {
  if (await B.permissions.contains(q)) return { ok: true };
  const id = Date.now() + '-' + (++gseq);
  const url = B.runtime.getURL('grant.html') + '?id=' + encodeURIComponent(id) + '&why=' + encodeURIComponent(why || '') + '&q=' + encodeURIComponent(JSON.stringify(q));
  let win;
  try { win = await B.windows.create({ url, type: 'popup', width: 440, height: 560, focused: true }); }
  catch (e) { await B.tabs.create({ url }); }
  // Poll with API calls: they also keep this worker awake while you decide.
  const until = Date.now() + 10 * 60000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 700));
    const key = 'grant:' + id, g = (await B.storage.local.get(key))[key];
    if (g) { await B.storage.local.remove(key); return { ok: g === 'ok' && await B.permissions.contains(q) }; }
    if (win) { try { await B.windows.get(win.id); } catch (e) { return { ok: await B.permissions.contains(q) }; } }
  }
  return { ok: false };
}

/* ---------------- downloads ---------------- */
const ERR = { FILE_ACCESS_DENIED: 'the browser could not write to your Downloads folder', FILE_NO_SPACE: 'disk is full', FILE_NAME_TOO_LONG: 'file name too long',
  NETWORK_FAILED: 'network error', NETWORK_TIMEOUT: 'network timed out', SERVER_UNAUTHORIZED: 'Canvas refused (sign in again)', SERVER_FORBIDDEN: 'Canvas refused access',
  SERVER_BAD_CONTENT: 'file not available', USER_CANCELED: 'cancelled' };
// Wait (up to ~25 s) for a download to finish so real failures are reported; big files keep going in the browser's list.
function waitFor(id) {
  return new Promise((resolve) => {
    const done = (state, err) => { B.downloads.onChanged.removeListener(on); clearTimeout(t); resolve({ state, err }); };
    const on = (d) => {
      if (d.id !== id || !d.state) return;
      if (d.state.current === 'complete') done('complete');
      else if (d.state.current === 'interrupted') done('interrupted', d.error && d.error.current);
    };
    B.downloads.onChanged.addListener(on);
    const t = setTimeout(() => done('slow'), 25000);
    B.downloads.search({ id }).then((r) => { if (r[0] && r[0].state === 'complete') done('complete'); if (r[0] && r[0].state === 'interrupted') done('interrupted', r[0].error); });
  });
}
async function downloadOne(a) {
  if (!(await B.permissions.contains({ permissions: ['downloads'] }))) return { ok: false, err: 'saving files is not allowed yet', perm: false };
  let url = a.url;
  // Firefox can't download data: links; its background page can make a blob: link instead.
  if (/^data:/.test(url) && typeof URL.createObjectURL === 'function' && typeof ServiceWorkerGlobalScope === 'undefined') {
    url = URL.createObjectURL(await (await fetch(url)).blob());
  }
  try {
    const id = await B.downloads.download({ url, filename: a.path, conflictAction: 'overwrite', saveAs: false });
    const w = await waitFor(id);
    return w.state === 'interrupted' ? { ok: false, err: ERR[w.err] || w.err || 'interrupted' } : { ok: true, id };
  } catch (e) { return { ok: false, err: (e && e.message) || String(e) }; }
}

/* ---------------- "Sync from this tab" ---------------- */
async function tabSync(tabId) {
  let origin = '';
  try { const t = await B.tabs.get(tabId); origin = new URL(t.url).origin; } catch (e) {}
  if (!origin) return { kind: 'err', text: 'Could not read this tab. Reload the Canvas page, then click the icon again.' };
  let data = null;
  try {
    const res = await B.scripting.executeScript({ target: { tabId }, func: scanCanvasCore, args: [origin, ''] });
    data = res && res[0] && res[0].result;
  } catch (e) {
    return { kind: 'err', text: 'Could not read that tab: ' + ((e && e.message) || e) + '. Reload the Canvas page, then click the icon again.' };
  }
  if (!data || !Array.isArray(data.items)) return { kind: 'err', text: 'That tab did not give Canvas data. Make sure you are signed in, reload the page and try again.' };
  await B.storage.local.set({ pendingScan: { data, at: Date.now(), host: new URL(origin).hostname } });
  const n = await broadcast('scan', { at: Date.now() });
  if (!n) await openSite('sync');
  return { kind: 'ok', text: 'Read ' + data.items.length + ' items from ' + data.courses.length + ' courses. Triaj is adding them now.' };
}

/* ---------------- messages ---------------- */
async function handle(m, sender) {
  const a = m.args || {};
  switch (m.cmd) {
    case 'hello': if (sender.tab) await addSiteTab(sender.tab.id); return { version: B.runtime.getManifest().version };
    case 'fetch': return doFetch(a);
    case 'perm.contains': return { ok: await B.permissions.contains(a) };
    case 'perm.request': return requestPerm(a);
    case 'perm.remove': try { return { ok: await B.permissions.remove(a) }; } catch (e) { return { ok: false }; }
    case 'dl.one': return downloadOne(a);
    case 'dl.show': try { await B.downloads.show(a.id); return { ok: true }; } catch (e) { return { ok: false }; }
    case 'dl.remove': try { await B.downloads.removeFile(a.id); } catch (e) {} try { await B.downloads.erase({ id: a.id }); } catch (e) {} return { ok: true };
    case 'config': {
      if (sender.tab) await addSiteTab(sender.tab.id);
      const o = {};
      if (a.canvasHost !== undefined) o.canvasHost = a.canvasHost;
      if (a.site) o.site = a.site;
      await B.storage.local.set(o);
      return { ok: true };
    }
    case 'mirror': {
      if (sender.tab) await addSiteTab(sender.tab.id);
      await B.storage.local.set({ mirror: a });
      await applyBlocking();
      await badge(await timer.get());
      return { ok: true };
    }
    case 'scan.take': {
      const d = (await B.storage.local.get('pendingScan')).pendingScan;
      if (!d) return { data: null };
      await B.storage.local.remove('pendingScan');
      return Date.now() - d.at < 3600e3 ? d : { data: null };
    }
    case 'focus.take': {
      const list = (await B.storage.local.get('focusQueue')).focusQueue || [];
      await B.storage.local.remove('focusQueue');
      return { list };
    }
    case 'timer': return timer.op(a);
    case 'block.perm': {
      const hosts = await blockList();
      if (!hosts.length) return { ok: true };
      const r = await requestPerm({ origins: hosts.flatMap(originsFor) }, 'block');
      await applyBlocking();
      return r;
    }
    case 'block.pass': await takePass(a.h, +a.minutes || 5); return { ok: true };
    case 'block.state': {
      const t = await timer.get(), mm = await mirror();
      const task = (mm.tasks || []).find((x) => x.id === t.tid);
      return { timer: t, task: task ? task.t : '', on: (await blockList()).includes(normHost(a.h)), vars: mm.vars || null };
    }
    // From the toolbar popup.
    case 'tabSync': return tabSync(a.tabId);
    case 'open': await openSite(a.hash); return { ok: true };
    case 'sync': { const n = await broadcast('syncNow'); if (!n) await openSite('sync'); return { ok: true, opened: !n }; }
    case 'preset': {
      const mm = await mirror();
      if (mm.timer) { mm.timer.presetId = a.id; await B.storage.local.set({ mirror: mm }); }
      await broadcast('preset', { id: a.id });
      return { ok: true };
    }
    case 'setBlock': {
      const mm = await mirror();
      mm.focusBlock = Object.assign({ sites: [] }, mm.focusBlock || {}, { on: !!a.on });
      await B.storage.local.set({ mirror: mm });
      await broadcast('setBlock', { on: !!a.on });
      await applyBlocking();
      return { ok: true };
    }
  }
  return { error: 'Unknown request: ' + m.cmd };
}
B.runtime.onMessage.addListener((m, sender, reply) => {
  if (!m || !m.triaj || sender.id !== B.runtime.id) return;
  handle(m, sender).then(reply, (e) => reply({ error: String((e && e.message) || e) }));
  return true;
});

B.alarms.onAlarm.addListener(async (a) => {
  if (await timer.onAlarm(a.name)) return;
  if (a.name === 'pass-end') await applyBlocking();
});
if (B.notifications.onButtonClicked) B.notifications.onButtonClicked.addListener((id, idx) => { B.notifications.clear(id); if (id === 'timer') timer.onButton(idx); });
B.notifications.onClicked.addListener((id) => { B.notifications.clear(id); openSite(id === 'timer' || id === 'refocus' ? 'focus' : 'now'); });
B.commands.onCommand.addListener((c) => {
  if (c === 'toggle-timer') timer.op({ op: 'toggle' });
  else if (c === 'open-triaj') openSite();
});
B.runtime.onInstalled.addListener(async (d) => { await applyBlocking(); await badge(await timer.get()); if (d.reason === 'install') openSite('sync'); });
B.runtime.onStartup.addListener(async () => { await applyBlocking(); await badge(await timer.get()); });
