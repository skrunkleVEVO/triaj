// Sign-in screen, the account button in the header, and the "add the companion" help.
// Kept apart from the planner itself: app.js only reads `session` and uses companionHelp().
import * as bridge from './bridge.js';

export const session = { user: null, guest: false };
export const COMPANION_ZIP = '../triaj-companion.zip';
export const COMPANION_HELP = '../#companion';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Phones and tablets can't run desktop extensions; there the help says so instead of offering a download.
export const isPhone = () => { try { return matchMedia('(pointer:coarse)').matches && Math.min(screen.width, screen.height) < 820; } catch (e) { return false; } };

export function companionHelp(forCanvas) {
  if (isPhone()) {
    return forCanvas ? '<div class="cpanel"><h3>Canvas syncs from your computer</h3><div class="s">Phones can\'t run browser extensions, so Canvas sync happens on a computer that has the Triaj companion. ' +
      'Everything it finds shows up here on its own' + (session.user ? '.' : ' once you sign in on both.') + '</div></div>' : '';
  }
  return '<div class="cpanel"><h3>Sync needs the Triaj companion</h3><div class="s">Browsers don\'t let a website read Canvas with your sign-in, so a small extension does that one job, only on sites you allow. It also saves course files into Downloads. Everything else in Triaj works without it.</div>' +
    '<div class="btnrow"><a class="btn sm sec" href="' + COMPANION_HELP + '" target="_blank" rel="noopener">See how it works</a><a class="btn sm mute" href="' + COMPANION_ZIP + '" download>Download</a></div>' +
    '<div class="s" style="margin-top:8px">For Chrome, Edge, Brave, Opera, Vivaldi and Firefox. Reload this page after installing it.</div></div>';
}

/* ---------------- modal helper ---------------- */
function sheet(html, opts) {
  opts = opts || {};
  const wrap = document.createElement('div');
  wrap.className = 'sheetwrap' + (opts.full ? ' full' : '');
  wrap.innerHTML = '<div class="sheet" role="dialog" aria-modal="true">' + (opts.full ? '' : '<button class="x sheetx" aria-label="Close">×</button>') + html + '</div>';
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape' && !opts.full) close(); };
  if (!opts.full) wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('.sheetx')) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(wrap);
  return { el: wrap, close };
}

/* ---------------- sign-in screen ---------------- */
const GOOGLE = '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';

// cloud: the cloud.js module. canGuest: offer "try without an account". Resolves when signed in or guest chosen.
export function showGate(cloud, o) {
  o = o || {};
  let mode = 'in';
  const s = sheet('<div class="gate">' +
    '<img class="glogo" src="../assets/icon-192.png" alt="" width="64" height="64">' +
    '<h1>Triaj</h1><p class="gsub">Your semester, triaged.</p>' +
    '<button class="gbtn" id="g-google">' + GOOGLE + '<span>Continue with Google</span></button>' +
    '<div class="gor"><span>or with email</span></div>' +
    '<form id="g-form" novalidate><input id="g-name" placeholder="Your name (optional)" autocomplete="name" hidden>' +
    '<input id="g-email" type="email" placeholder="Email" autocomplete="email" required><input id="g-pw" type="password" placeholder="Password" autocomplete="current-password" required>' +
    '<button class="btn" id="g-submit" type="submit">Sign in</button></form>' +
    '<div class="glinks"><a href="#" id="g-mode">New here? Create an account</a><a href="#" id="g-forgot">Forgot password?</a></div>' +
    '<div class="gmsg" id="g-msg" role="status"></div>' +
    (o.canGuest !== false ? '<button class="btn mute" id="g-guest">Try it without an account</button><div class="s gnote">Without an account your planner stays in this browser only. You can sign in later and bring it along.</div>' : '') +
    '<a class="gback" href="../">← What is Triaj?</a></div>', { full: !o.closable });
  const $ = (id) => s.el.querySelector('#' + id);
  const msg = (t, bad) => { $('g-msg').textContent = t || ''; $('g-msg').className = 'gmsg' + (bad ? ' bad' : ''); };
  const busy = (b) => s.el.querySelectorAll('button').forEach((x) => { x.disabled = b; });
  const run = async (fn) => { busy(true); msg('One moment…'); try { await fn(); msg(''); } catch (e) { msg(cloud.authError(e), true); } busy(false); };
  $('g-google').onclick = () => run(() => cloud.signInGoogle());
  $('g-form').onsubmit = (e) => {
    e.preventDefault();
    const em = $('g-email').value.trim(), pw = $('g-pw').value;
    run(() => (mode === 'up' ? cloud.signUpEmail(em, pw, $('g-name').value.trim()) : cloud.signInEmail(em, pw)));
  };
  $('g-mode').onclick = (e) => {
    e.preventDefault(); mode = mode === 'in' ? 'up' : 'in';
    $('g-name').hidden = mode === 'in';
    $('g-submit').textContent = mode === 'up' ? 'Create account' : 'Sign in';
    $('g-pw').setAttribute('autocomplete', mode === 'up' ? 'new-password' : 'current-password');
    $('g-mode').textContent = mode === 'up' ? 'Have an account? Sign in' : 'New here? Create an account';
    msg('');
  };
  $('g-forgot').onclick = (e) => {
    e.preventDefault();
    const em = $('g-email').value.trim();
    if (!em) return msg('Type your email above first, then press "Forgot password?" again.', true);
    run(async () => { await cloud.resetPassword(em); }).then(() => msg('Check your inbox for a link to set a new password.'));
  };
  if ($('g-guest')) $('g-guest').onclick = () => { localStorage.setItem('triaj:mode', 'guest'); s.close(); if (o.onGuest) o.onGuest(); };
  return s;
}

/* ---------------- header button + account sheet ---------------- */
const SYNC_TEXT = { off: 'Not syncing', connecting: 'Connecting…', pending: 'Saving soon…', saving: 'Saving…', synced: 'All changes saved', offline: 'Offline: changes are kept here and sent when you\'re back', error: 'Could not save' };
const SYNC_ICON = { synced: '☁', pending: '⋯', saving: '⋯', connecting: '⋯', offline: '⚠', error: '⚠', off: '' };

export function mountAccount(cloud) {
  const btn = document.getElementById('acct');
  if (!btn) return;
  let st = { state: 'off' };
  const paint = () => {
    const u = session.user;
    const initial = u ? (u.displayName || u.email || '?').trim().charAt(0).toUpperCase() : '';
    btn.innerHTML = u ? (u.photoURL ? '<img src="' + esc(u.photoURL) + '" alt="" referrerpolicy="no-referrer">' : '<b>' + esc(initial) + '</b>') + '<i class="cst ' + st.state + '">' + (SYNC_ICON[st.state] || '') + '</i>' : '<span>Sign in</span>';
    btn.title = u ? (u.email || 'Account') + ' · ' + (SYNC_TEXT[st.state] || '') : 'Sign in to sync across devices';
    btn.className = u ? 'acct on' : 'acct';
  };
  if (cloud && session.user) cloud.onStatus((x) => { st = x; paint(); });
  paint();
  btn.onclick = () => openAccount(cloud, st);
  window.addEventListener('triaj:signin', () => { if (!session.user) showGate(cloud, { closable: true, canGuest: false }); });
  window.addEventListener('triaj:companion', () => { const s = sheet(companionHelp(false) || '<div class="cpanel"><h3>Needs a computer</h3><div class="s">This part of Triaj runs through the companion extension, which phones can\'t install. Do it once on a computer; the results sync here.</div></div>'); s.el.querySelector('.sheet').classList.add('narrow'); });
}

function openAccount(cloud, st) {
  const u = session.user;
  const comp = bridge.available()
    ? '<div class="arow"><span>🧩 Companion</span><b>Connected · v' + esc(bridge.version()) + '</b></div>'
    : '<div class="arow"><span>🧩 Companion</span><b>' + (isPhone() ? 'Not available on phones' : '<a class="lnk" href="' + COMPANION_HELP + '" target="_blank" rel="noopener">Not installed: how to add it</a>') + '</b></div>';
  if (!u) {
    const s = sheet('<h2>Using Triaj without an account</h2><div class="s" style="margin-bottom:12px">Your planner is saved in this browser only. Sign in to keep it in your account and open it on your phone, laptop or any other browser. What you have now comes along.</div>' +
      comp + '<button class="btn" id="a-in" style="margin-top:14px">Sign in or create an account</button>');
    s.el.querySelector('.sheet').classList.add('narrow');
    s.el.querySelector('#a-in').onclick = () => { s.close(); showGate(cloud, { closable: true, canGuest: false }); };
    return;
  }
  const s = sheet('<div class="ahead">' + (u.photoURL ? '<img src="' + esc(u.photoURL) + '" alt="" referrerpolicy="no-referrer">' : '<b>' + esc((u.displayName || u.email || '?').charAt(0).toUpperCase()) + '</b>') +
    '<div><h2>' + esc(u.displayName || 'Your account') + '</h2><div class="s">' + esc(u.email || '') + '</div></div></div>' +
    '<div class="arow"><span>☁ Sync</span><b id="a-sync">' + esc(SYNC_TEXT[st.state] || '') + (st.err ? ': ' + esc(st.err) : '') + '</b></div>' + comp +
    '<div class="s" style="margin:12px 0">Your planner, settings and keys are stored in your account and only you can read them. Sign in with the same account anywhere to pick up where you left off.</div>' +
    '<button class="btn mute" id="a-out">Sign out</button><div class="s" style="margin-top:6px">Signing out removes this account\'s copy from this browser. It stays safe in your account.</div>');
  s.el.querySelector('.sheet').classList.add('narrow');
  s.el.querySelector('#a-out').onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = 'Signing out…';
    if (cloud) await cloud.signOut(); else location.reload();
  };
}
