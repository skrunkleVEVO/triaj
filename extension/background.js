// Triaj Companion: the few things a website can't do on its own.
//   fetch      read Canvas / private calendar feeds with your sign-in (only sites you allowed)
//   perm.*     ask for and check that access (a small window shows the browser's prompt)
//   dl.*       save files into Downloads (course files, backup files)
//   tabSync    read Canvas from the tab you're on (toolbar button), then hand it to the website
// Everything else (planner, timer, schedule, account and sync) lives on the website.
import { scanCanvasCore } from './lib/canvas-scan.js';

const B = globalThis.browser || globalThis.chrome;
const SITE = 'https://skrunklevevo.github.io/triaj/app/';

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
async function siteUrl() { return (await B.storage.local.get('site')).site || SITE; }
async function openSite(hash) {
  for (const id of await siteTabs()) {
    try { const t = await B.tabs.update(id, { active: true }); await B.windows.update(t.windowId, { focused: true }); return; } catch (e) {}
  }
  await B.tabs.create({ url: (await siteUrl()) + (hash ? '#' + hash : '') });
}
B.permissions.onAdded.addListener((p) => broadcast('perm', p));
B.permissions.onRemoved.addListener((p) => broadcast('perm', Object.assign({ removed: true }, p)));

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
async function requestPerm(q) {
  if (await B.permissions.contains(q)) return { ok: true };
  const id = Date.now() + '-' + (++gseq);
  const url = B.runtime.getURL('grant.html') + '?id=' + encodeURIComponent(id) + '&q=' + encodeURIComponent(JSON.stringify(q));
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
  await B.storage.local.set({ tabSync: { running: true, at: Date.now() } });
  let data = null;
  try {
    const res = await B.scripting.executeScript({ target: { tabId }, func: scanCanvasCore, args: [origin, ''] });
    data = res && res[0] && res[0].result;
  } catch (e) {
    await B.storage.local.set({ tabSync: { running: false } });
    return { kind: 'err', text: 'Could not read that tab: ' + ((e && e.message) || e) + '. Reload the Canvas page, then click the icon again.' };
  }
  await B.storage.local.set({ tabSync: { running: false } });
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
    case 'scan.take': {
      const d = (await B.storage.local.get('pendingScan')).pendingScan;
      if (!d) return { data: null };
      await B.storage.local.remove('pendingScan');
      return Date.now() - d.at < 3600e3 ? d : { data: null };
    }
    // From the toolbar popup.
    case 'tabSync': return tabSync(a.tabId);
    case 'open': await openSite(a.hash); return { ok: true };
  }
  return { error: 'Unknown request: ' + m.cmd };
}
B.runtime.onMessage.addListener((m, sender, reply) => {
  if (!m || !m.triaj || sender.id !== B.runtime.id) return;
  handle(m, sender).then(reply, (e) => reply({ error: String((e && e.message) || e) }));
  return true;
});
B.commands.onCommand.addListener((c) => { if (c === 'open-triaj') openSite(); });
B.runtime.onInstalled.addListener((d) => { if (d.reason === 'install') openSite('sync'); });
