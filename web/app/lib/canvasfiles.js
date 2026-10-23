// Find every downloadable file in a Canvas course (or behind one assignment) and download
// a selection into tidy folders with the browser's downloader (through the Triaj companion):
// Downloads/Canvas/<course>/<group>/<file>
import { ext } from './platform.js';
import * as bridge from './bridge.js';

const FILE_LINK = /\/(?:api\/v1\/)?(?:courses\/(\d+)\/)?files\/(\d+)(?=[\/?#"'\s]|$)/g;

// fx: the fetch to use (the companion's, which carries your Canvas sign-in).
export function makeApi(base, token, fx) {
  const F = fx || fetch;
  const HDR = { headers: { Accept: 'application/json+canvas-string-ids' }, credentials: 'include' };
  if (token) HDR.headers.Authorization = 'Bearer ' + token;
  async function api(path) {
    let url = /^https?:/.test(path) ? path : base + path;
    const out = [];
    let n = 0;
    while (url && n++ < 40) {
      let r;
      try { r = await F(url, HDR); }
      catch (e) { throw new Error(e && e.noext ? 'this needs the Triaj companion extension in this browser (More → Sync shows how to add it)' : 'could not reach Canvas. Check your internet connection, or open More → Sync and press Connect again so Triaj has permission'); }
      const ct = r.headers.get('content-type') || '';
      if (r.status === 401 || ct.indexOf('html') > -1) { const e = new Error('Not signed in to Canvas'); e.auth = true; throw e; }
      if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
      const j = JSON.parse((await r.text()).replace(/^while\(1\);/, ''));
      if (!Array.isArray(j)) return j;
      out.push(...j);
      const m = (r.headers.get('Link') || '').match(/<([^>]+)>;\s*rel="next"/);
      url = m ? m[1] : null;
    }
    return out;
  }
  api.opt = async (p) => { try { return await api(p); } catch (e) { if (e.auth) throw e; return null; } };
  api.base = base;
  return api;
}

async function pool(list, n, fn) {
  let i = 0;
  const run = async () => { while (i < list.length) { const k = i++; await fn(list[k], k); } };
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, run));
}

export function linkedFileIds(html) {
  const ids = [];
  String(html || '').replace(FILE_LINK, (m, c, id) => { if (ids.indexOf(id) < 0) ids.push(id); return m; });
  return ids;
}

export function fileType(name, ct) {
  const n = String(name || '').toLowerCase(), c = String(ct || '');
  if (/\.pdf$/.test(n) || /pdf/.test(c)) return 'pdf';
  if (/\.(pptx?|key|odp)$/.test(n) || /presentation/.test(c)) return 'slides';
  if (/\.(docx?|odt|rtf|txt|md|tex)$/.test(n) || /word|text\//.test(c)) return 'doc';
  if (/\.(xlsx?|csv|ods|mat|m|py|ipynb|c|cpp|java|zip)$/.test(n)) return 'data';
  if (/\.(png|jpe?g|gif|svg|webp)$/.test(n) || /image\//.test(c)) return 'image';
  if (/\.(mp4|mov|mp3|m4a|wav)$/.test(n) || /video|audio/.test(c)) return 'media';
  return 'other';
}

// Resolve file ids to metadata (name, size, download url, updated time). Locked files are kept but flagged.
async function resolveFiles(api, cid, refs, prog) {
  const out = new Map();
  let done = 0;
  await pool(refs, 6, async (ref) => {
    if (out.has(ref.id)) return;
    let f = await api.opt('/api/v1/courses/' + cid + '/files/' + ref.id);
    if (!f) f = await api.opt('/api/v1/files/' + ref.id);
    done++;
    if (prog && done % 5 === 0) prog('Checking files… ' + done + ' of ' + refs.length);
    if (!f || !f.id) { out.set(ref.id, { id: ref.id, name: ref.label || ('file ' + ref.id), missing: true, group: ref.group, from: ref.from }); return; }
    out.set(ref.id, {
      id: String(f.id), name: f.display_name || f.filename || ('file ' + ref.id), size: f.size || 0, ct: f['content-type'] || '',
      url: f.url || '', updated: f.updated_at || f.modified_at || '', locked: !!f.locked_for_user || !f.url,
      type: fileType(f.display_name, f['content-type']), group: ref.group, from: ref.from, page: api.base + '/courses/' + cid + '/files/' + f.id
    });
  });
  return out;
}

// Everything downloadable in one course, grouped by module (then syllabus, then other course files).
export async function listCourseFiles(api, cid, prog) {
  prog = prog || function () {};
  const refs = [], links = [], seen = new Set(), order = [];
  const addRef = (id, group, from) => { if (seen.has(id)) return; seen.add(id); refs.push({ id, group, from }); if (order.indexOf(group) < 0) order.push(group); };

  prog('Reading modules…');
  const ms = await api.opt('/api/v1/courses/' + cid + '/modules?include[]=items&include[]=content_details&per_page=50') || [];
  const jobs = [];
  ms.forEach((m, mi) => {
    const g = m.name || ('Module ' + (mi + 1));
    if (order.indexOf(g) < 0) order.push(g);
    (m.items || []).forEach((it) => {
      if (it.type === 'File' && it.content_id) addRef(String(it.content_id), g, 'Module file');
      else if (it.type === 'Page' && it.page_url) jobs.push({ g, from: 'Page: ' + it.title, path: '/api/v1/courses/' + cid + '/pages/' + encodeURIComponent(it.page_url), field: 'body' });
      else if (it.type === 'Assignment' && it.content_id) jobs.push({ g, from: 'Assignment: ' + it.title, path: '/api/v1/courses/' + cid + '/assignments/' + it.content_id, field: 'description' });
      else if (it.type === 'Discussion' && it.content_id) jobs.push({ g, from: 'Discussion: ' + it.title, path: '/api/v1/courses/' + cid + '/discussion_topics/' + it.content_id, field: 'message', att: true });
      else if (it.type === 'Quiz' && it.content_id) jobs.push({ g, from: 'Quiz: ' + it.title, path: '/api/v1/courses/' + cid + '/quizzes/' + it.content_id, field: 'description' });
      else if (it.type === 'ExternalUrl' && it.external_url) links.push({ group: g, name: it.title, url: it.external_url });
    });
  });
  let n = 0;
  await pool(jobs, 6, async (j) => {
    const o = await api.opt(j.path);
    n++;
    if (n % 4 === 0 || n === jobs.length) prog('Looking inside pages and assignments… ' + n + ' of ' + jobs.length);
    if (!o) return;
    linkedFileIds(o[j.field]).forEach((id) => addRef(id, j.g, j.from));
    if (j.att) (o.attachments || []).forEach((a) => a.id && addRef(String(a.id), j.g, j.from));
  });

  prog('Reading the syllabus…');
  const info = await api.opt('/api/v1/courses/' + cid + '?include[]=syllabus_body');
  if (info) linkedFileIds(info.syllabus_body).forEach((id) => addRef(id, 'Syllabus', 'Syllabus page'));

  prog('Reading course files…');
  const folders = await api.opt('/api/v1/courses/' + cid + '/folders?per_page=100');
  const fmap = {};
  (folders || []).forEach((f) => { fmap[String(f.id)] = String(f.full_name || f.name || '').replace(/^course files\/?/, ''); });
  const all = await api.opt('/api/v1/courses/' + cid + '/files?per_page=100&sort=updated_at&order=desc');
  const direct = new Map();
  (all || []).forEach((f) => {
    const id = String(f.id);
    direct.set(id, f);
    const fold = fmap[String(f.folder_id)];
    addRef(id, fold ? 'Files: ' + fold : 'Other course files', 'Course files');
  });

  // Files listed directly already carry their metadata; only look up the rest.
  const need = refs.filter((r) => !direct.has(r.id));
  const meta = await resolveFiles(api, cid, need, prog);
  direct.forEach((f, id) => meta.set(id, {
    id, name: f.display_name, size: f.size || 0, ct: f['content-type'] || '', url: f.url || '', updated: f.updated_at || '',
    locked: !!f.locked_for_user || !f.url, type: fileType(f.display_name, f['content-type']), page: api.base + '/courses/' + cid + '/files/' + id
  }));
  const groups = order.map((g) => ({
    name: g,
    files: refs.filter((r) => r.group === g).map((r) => Object.assign({}, meta.get(r.id), { group: g, from: r.from })).filter((f) => f && f.name),
    links: links.filter((l) => l.group === g)
  })).filter((g) => g.files.length || g.links.length);
  return { groups, modulesOk: ms.length > 0, filesOk: !!all };
}

// The files that belong to one assignment/quiz/discussion/page: linked in its instructions,
// attached to it, and sitting in the same module.
export async function listItemFiles(api, cid, kind, id, prog) {
  prog = prog || function () {};
  prog('Reading the instructions…');
  let title = '', html = '', att = [], contentId = id, modType = 'Assignment';
  if (kind === 'assignments') {
    const a = await api('/api/v1/courses/' + cid + '/assignments/' + id);
    title = a.name; html = a.description || '';
    if (a.quiz_id) { const q = await api.opt('/api/v1/courses/' + cid + '/quizzes/' + a.quiz_id); if (q && q.description) html += q.description; }
    if (a.discussion_topic) { att = a.discussion_topic.attachments || []; html += a.discussion_topic.message || ''; }
  } else if (kind === 'quizzes') {
    const q = await api('/api/v1/courses/' + cid + '/quizzes/' + id); title = q.title; html = q.description || ''; modType = 'Quiz';
  } else if (kind === 'discussion_topics') {
    const d = await api('/api/v1/courses/' + cid + '/discussion_topics/' + id); title = d.title; html = d.message || ''; att = d.attachments || []; modType = 'Discussion';
  } else if (kind === 'pages') {
    const p = await api('/api/v1/courses/' + cid + '/pages/' + encodeURIComponent(id)); title = p.title; html = p.body || ''; modType = 'Page'; contentId = p.url;
  }
  const refs = [], seen = new Set();
  const add = (fid, group, from) => { if (!seen.has(fid)) { seen.add(fid); refs.push({ id: fid, group, from }); } };
  linkedFileIds(html).forEach((fid) => add(fid, 'linked', 'Linked in the instructions'));
  att.forEach((a) => a.id && add(String(a.id), 'linked', 'Attached'));

  prog('Checking its module…');
  let moduleName = '';
  const ms = await api.opt('/api/v1/courses/' + cid + '/modules?include[]=items&per_page=50') || [];
  const mod = ms.find((m) => (m.items || []).some((it) => it.type === modType && (String(it.content_id) === String(contentId) || it.page_url === contentId)));
  const pageJobs = [];
  if (mod) {
    moduleName = mod.name;
    (mod.items || []).forEach((it) => {
      if (it.type === 'File' && it.content_id) add(String(it.content_id), 'module', 'In module "' + mod.name + '"');
      if (it.type === 'Page' && it.page_url && it.page_url !== contentId) pageJobs.push(it);
    });
    await pool(pageJobs, 4, async (it) => {
      const p = await api.opt('/api/v1/courses/' + cid + '/pages/' + encodeURIComponent(it.page_url));
      if (p) linkedFileIds(p.body).forEach((fid) => add(fid, 'module', 'Page "' + it.title + '" in the same module'));
    });
  }
  const meta = await resolveFiles(api, cid, refs, prog);
  const files = refs.map((r) => Object.assign({}, meta.get(r.id), { group: r.group, from: r.from })).filter((f) => f && f.name);
  return { title, html, files, moduleName };
}

/* ---------------- downloading ---------------- */
export function cleanName(s, max) {
  return String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').replace(/^[ .]+|[ .]+$/g, '').slice(0, max || 80) || 'untitled';
}

export async function hasDownloads() {
  try { return await ext.permissions.contains({ permissions: ['downloads'] }); } catch (e) { return false; }
}

// items: [{url, path, key, updated}] ; onProgress(doneCount, total, item, result)
// The companion saves each file and waits for it to finish, so real failures are reported, not just "started".
export async function downloadAll(items, onProgress) {
  const res = { ok: [], failed: [], ids: [] };
  let n = 0;
  await pool(items, 3, async (it) => {
    let r;
    const a = await bridge.call('dl.one', { url: it.url, path: it.path }, 200000);
    if (a && a.ok) { res.ids.push(a.id); r = { ok: true, id: a.id }; }
    else r = { ok: false, err: (a && a.noext) ? 'needs the Triaj companion extension' : (a && (a.err || a.error)) || 'failed' };
    (r.ok ? res.ok : res.failed).push(Object.assign({}, it, r));
    n++;
    if (onProgress) onProgress(n, items.length, it, r);
  });
  return res;
}

export function blobUrl(text, type) { return URL.createObjectURL(new Blob([text], { type: type || 'text/html' })); }
// For files the companion saves: it cannot open this page's blob: links.
export function dataUrl(text, type) { return 'data:' + (type || 'text/html') + ';charset=utf-8,' + encodeURIComponent(text); }

export function instructionsPage(title, course, html, base) {
  const fixed = String(html || '').replace(/(href|src)="\//g, '$1="' + base + '/');
  return '<!doctype html><html><head><meta charset="utf-8"><title>' + title.replace(/</g, '&lt;') + '</title>' +
    '<style>body{font-family:system-ui,sans-serif;max-width:800px;margin:30px auto;padding:0 16px;line-height:1.5;color:#222}img{max-width:100%}h1{font-size:22px}.m{color:#777;font-size:13px}</style></head><body>' +
    '<h1>' + title.replace(/</g, '&lt;') + '</h1><div class="m">' + course.replace(/</g, '&lt;') + ' · saved ' + new Date().toLocaleString() + ' by Triaj</div><hr>' + fixed + '</body></html>';
}
