// Reads everything Canvas has for you. Shared by the Triaj website and the companion extension:
// scripts/sync-extension.mjs copies this file to extension/lib/canvas-scan.js (CI checks they match).

/* ---------- Canvas scan ---------- */
// Self-contained on purpose: the website runs it (through the companion's fetch) AND the companion injects it into an open Canvas tab
// (so it may not use anything from this module). onProgress is optional and only works in the worker.
// fx: the fetch to use. The website passes the companion extension's fetch, which carries your Canvas sign-in.
//
// Sources, in order of trust:
//  1. /api/v1/planner/items: exactly what Canvas shows on your To-Do list and calendar: assignments,
//     quizzes (even locked ones), ungraded discussions and pages with to-do dates, peer reviews,
//     your own Canvas to-do notes, and course calendar events (exams).
//  2. /courses/:id/assignments: lock/unlock dates and undated or far-off assignments the To-Do feed leaves out.
//  3. /courses/:id/modules: required module items (readings, videos) with no to-do date.
//  4. Syllabus page, pages and files named syllabus/outline: for the AI date finder.
export async function scanCanvasCore(base, token, onProgress, fx) {
  const F = typeof fx === 'function' ? fx : fetch;
  const prog = typeof onProgress === 'function' ? onProgress : function () {};
  const HDR = { headers: { Accept: 'application/json+canvas-string-ids' }, credentials: 'include' };
  if (token) HDR.headers.Authorization = 'Bearer ' + token;
  async function api(url) {
    const out = [];
    let pages = 0;
    while (url && pages++ < 40) {
      const r = await F(url, HDR);
      const ct = r.headers.get('content-type') || '';
      if (r.status === 401 || (r.redirected && /login/.test(r.url)) || ct.indexOf('html') > -1) {
        const e = new Error('Not signed in to Canvas (' + r.status + ')'); e.auth = true; throw e;
      }
      if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
      const j = JSON.parse((await r.text()).replace(/^while\(1\);/, ''));
      if (!Array.isArray(j)) return j;
      out.push(...j);
      const m = (r.headers.get('Link') || '').match(/<([^>]+)>;\s*rel="next"/);
      url = m ? m[1] : null;
    }
    return out;
  }
  // For optional extras: a 403/404 (feature hidden for students) is not an error worth reporting.
  async function opt(url) { try { return await api(url); } catch (e) { if (e.auth) throw e; return null; } }
  const pad = (n) => String(n).padStart(2, '0');
  const ld = (s) => { if (!s) return ''; const d = new Date(s); return isNaN(d) ? '' : d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const lt = (s) => { if (!s || String(s).indexOf('T') < 0) return ''; const d = new Date(s); return isNaN(d) ? '' : pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const abs = (u) => (!u ? '' : /^https?:/i.test(u) ? u : base + u);
  const strip = (h) => (typeof DOMParser !== 'undefined' ? new DOMParser().parseFromString(String(h || ''), 'text/html').body.textContent : String(h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')).replace(/\s+/g, ' ').trim();
  const SYL = /syllab|outline|course info|course schedule|schedule of/i;

  prog('Finding your courses…');
  let courses = await api(base + '/api/v1/courses?enrollment_state=active&per_page=100');
  courses = courses.filter((c) => c && c.name && !c.access_restricted_by_date);
  const byId = {};
  courses.forEach((c) => { byId[String(c.id)] = c; });
  const cname = (cid) => (byId[cid] ? (byId[cid].course_code || byId[cid].name) : '');
  const items = [], events = [], syllabi = [], warnings = [];
  const index = {};
  const add = (it) => { if (index[it.uid]) return index[it.uid]; index[it.uid] = it; items.push(it); return it; };

  // 1. To-Do feed
  prog('Reading your Canvas To-Do list…');
  const s0 = new Date(); s0.setDate(s0.getDate() - 30);
  const e0 = new Date(); e0.setDate(e0.getDate() + 200);
  let planner = [], plannerOk = true;
  try {
    planner = await api(base + '/api/v1/planner/items?per_page=100&start_date=' + encodeURIComponent(s0.toISOString()) + '&end_date=' + encodeURIComponent(e0.toISOString()));
  } catch (e) { if (e.auth) throw e; plannerOk = false; warnings.push('To-Do list (' + e.message + ')'); }
  for (const p of planner) {
    const pl = p.plannable || {}, type = p.plannable_type;
    if (type === 'announcement') continue;
    const cid = p.course_id ? String(p.course_id) : '';
    if (cid && !byId[cid]) continue; // old or inactive course
    const date = p.plannable_date || pl.due_at || pl.todo_date || pl.start_at;
    if (type === 'calendar_event') {
      events.push({ uid: 'canvas:e:' + p.plannable_id, title: pl.title || 'Event', course: cname(cid), courseId: cid,
        start: pl.start_at || date, end: pl.end_at || pl.start_at || date, allDay: !!pl.all_day, url: abs(p.html_url), location: pl.location_name || '' });
      continue;
    }
    const sub = p.submissions || {};
    const finished = !!(sub.submitted || sub.excused || (sub.graded && !sub.missing) || (p.planner_override && p.planner_override.marked_complete));
    const aid = pl.assignment_id ? String(pl.assignment_id) : '';
    let uid, kind;
    if (type === 'assignment' || type === 'sub_assignment') { uid = 'canvas:a:' + p.plannable_id; kind = 'assignment'; }
    else if (type === 'quiz') { uid = aid ? 'canvas:a:' + aid : 'canvas:q:' + p.plannable_id; kind = 'quiz'; }
    else if (type === 'discussion_topic') { uid = aid ? 'canvas:a:' + aid : 'canvas:d:' + p.plannable_id; kind = 'discussion'; }
    else if (type === 'wiki_page') { uid = 'canvas:p:' + p.plannable_id; kind = 'page'; }
    else if (type === 'planner_note') { uid = 'canvas:n:' + p.plannable_id; kind = 'note'; }
    else if (type === 'assessment_request') { uid = 'canvas:r:' + p.plannable_id; kind = 'peer review'; }
    else { uid = 'canvas:' + type + ':' + p.plannable_id; kind = String(type || 'item'); }
    const title = pl.title || pl.name || 'Untitled';
    add({ title: kind === 'peer review' ? 'Peer review: ' + title : title, due: ld(date), time: lt(date), course: cname(cid), courseId: cid,
      uid, kind, url: abs(p.html_url), points: pl.points_possible, finished, from: 'To-Do list', graded: (pl.points_possible || 0) > 0 });
  }

  let done = 0;
  prog('Reading ' + courses.length + ' courses…');
  await Promise.all(courses.map(async (c) => {
    const cid = String(c.id), code = c.course_code || c.name;
    // 2. Assignments: lock info, plus anything the To-Do list leaves out.
    try {
      const as = await api(base + '/api/v1/courses/' + cid + '/assignments?per_page=100&include[]=submission');
      for (const a of as) {
        const s = a.submission;
        const fin = !!(s && (s.excused || s.submitted_at || ['submitted', 'graded', 'pending_review'].includes(s.workflow_state)));
        const t = a.submission_types || [];
        const kind = t.includes('online_quiz') || a.quiz_id || a.is_quiz_assignment ? 'quiz' : t.includes('discussion_topic') ? 'discussion' : 'assignment';
        const uid = 'canvas:a:' + a.id;
        const lock = { unlockAt: ld(a.unlock_at), unlockTime: lt(a.unlock_at), lockAt: ld(a.lock_at), locked: !!a.locked_for_user };
        if (index[uid]) {
          const it = index[uid];
          Object.assign(it, lock);
          it.kind = kind;
          if (!it.due && a.due_at) { it.due = ld(a.due_at); it.time = lt(a.due_at); }
          if (!it.url) it.url = a.html_url;
          it.finished = it.finished || fin;
          continue;
        }
        if (t.includes('none') && !a.due_at) continue; // pure placeholders (e.g. "Participation")
        add(Object.assign({ title: a.name, due: ld(a.due_at), time: lt(a.due_at), course: code, courseId: cid, uid, kind, url: a.html_url,
          points: a.points_possible, finished: fin, from: 'Assignments' }, lock));
      }
    } catch (e) { if (e.auth) throw e; warnings.push(code + ': assignments (' + e.message + ')'); }

    // 3. Module items (required readings etc.) and syllabus files that live in modules.
    const syl = { course: code, courseId: cid, name: c.name, text: '', from: [], files: [] };
    const fileIds = new Set();
    try {
      const ms = await api(base + '/api/v1/courses/' + cid + '/modules?include[]=items&include[]=content_details&per_page=50');
      const titles = new Set(items.filter((x) => x.courseId === cid).map((x) => x.title.toLowerCase().trim()));
      for (const m of ms) {
        for (const it of (m.items || [])) {
          if (it.type === 'File' && SYL.test(it.title) && it.content_id && !fileIds.has(String(it.content_id))) {
            fileIds.add(String(it.content_id));
            const f = await opt(base + '/api/v1/courses/' + cid + '/files/' + it.content_id);
            if (f && f.url) syl.files.push({ id: String(f.id), name: f.display_name || it.title, url: f.url, size: f.size || 0, type: f['content-type'] || '', page: abs('/courses/' + cid + '/files/' + f.id) });
          }
          if (['SubHeader', 'Assignment', 'Quiz', 'ExternalUrl'].includes(it.type)) continue;
          if (titles.has(String(it.title).toLowerCase().trim())) continue; // already on the To-Do list
          const cr = it.completion_requirement, cd = it.content_details || {};
          const uid = it.type === 'Discussion' && it.content_id ? 'canvas:d:' + it.content_id : 'canvas:module:' + it.id;
          if (index[uid]) continue;
          add({ title: it.title, due: ld(cd.due_at || cd.todo_date), time: lt(cd.due_at || cd.todo_date), course: code, courseId: cid, uid, kind: 'module-' + String(it.type).toLowerCase(),
            req: !!cr, finished: !!(cr && cr.completed), url: it.html_url, module: m.name, from: 'Modules',
            unlockAt: ld(m.unlock_at || cd.unlock_at), lockAt: ld(cd.lock_at), locked: !!(m.state === 'locked' || cd.locked_for_user) });
        }
      }
    } catch (e) { if (e.auth) throw e; if (!e.status || e.status >= 500) warnings.push(code + ': modules (' + e.message + ')'); }

    // 4. Syllabus text and outline files.
    const info = await opt(base + '/api/v1/courses/' + cid + '?include[]=syllabus_body');
    if (info && info.syllabus_body) {
      const t = strip(info.syllabus_body);
      if (t.length > 40) { syl.text += 'Syllabus page:\n' + t + '\n\n'; syl.from.push('Syllabus page'); }
    }
    const seenPages = new Set();
    for (const term of ['syllabus', 'outline']) {
      const ps = await opt(base + '/api/v1/courses/' + cid + '/pages?per_page=20&search_term=' + term);
      for (const pg of (ps || []).slice(0, 3)) {
        if (seenPages.has(pg.url)) continue;
        seenPages.add(pg.url);
        const full = await opt(base + '/api/v1/courses/' + cid + '/pages/' + encodeURIComponent(pg.url));
        const t = full && strip(full.body);
        if (t && t.length > 40) { syl.text += 'Page "' + pg.title + '":\n' + t + '\n\n'; syl.from.push('Page: ' + pg.title); }
      }
      const fs = await opt(base + '/api/v1/courses/' + cid + '/files?per_page=20&search_term=' + term);
      for (const f of (fs || [])) {
        if (fileIds.has(String(f.id))) continue;
        fileIds.add(String(f.id));
        syl.files.push({ id: String(f.id), name: f.display_name, url: f.url, size: f.size || 0, type: f['content-type'] || '', page: abs('/courses/' + cid + '/files/' + f.id) });
      }
    }
    syl.text = syl.text.slice(0, 24000);
    syllabi.push(syl);
    done++;
    prog('Read ' + done + ' of ' + courses.length + ' courses…');
  }));
  syllabi.sort((a, b) => (a.course < b.course ? -1 : 1));
  return { source: 'canvas', scannedAt: new Date().toISOString(), plannerOk,
    courses: courses.map((c) => ({ id: String(c.id), name: c.name, code: c.course_code || c.name })), items, events, syllabi, warnings };
}
