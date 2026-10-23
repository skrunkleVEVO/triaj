// Starts Triaj: account first (or guest), then this account's local data, then the planner and its engine.
import * as P from './lib/platform.js';
import { session, showGate, mountAccount } from './lib/account.js';

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

let cloud = null, booted = false, gate = null;

// A planner made before signing in (guest mode) comes along into the account.
async function bringGuest(uid, online) {
  const flag = 'triaj:guest-moved:' + uid;
  if (!online || localStorage.getItem(flag)) return;
  const g = await P.readSpace('guest');
  const gp = g.plan, n = gp ? (gp.tasks || []).length + (gp.classes || []).length + (gp.routines || []).length : 0;
  if (!n) return;
  const cur = P.peek('plan');
  const has = cur && ((cur.tasks || []).length || (cur.classes || []).length);
  if (!has || confirm('This browser has a planner from before you signed in (' + (gp.tasks || []).length + ' tasks).\n\n' +
    'Use it in your account? That replaces what your account has now (' + ((cur && cur.tasks) || []).length + ' tasks).\n\nCancel keeps your account\'s planner.')) {
    await P.ext.storage.local.set({ plan: Object.assign({}, gp, { by: 'guest' }), dlog: g.dlog || {} });
  }
  localStorage.setItem(flag, '1');
}

async function run(user) {
  booted = true;
  if (gate) { gate.close(); gate = null; }
  session.user = user ? { uid: user.uid, email: user.email, displayName: user.displayName, photoURL: user.photoURL } : null;
  session.guest = !user;
  if (user) {
    localStorage.setItem('triaj:last-uid', user.uid);
    await P.init(user.uid);
    const fresh = !P.peek('plan');
    const online = cloud ? await cloud.startSync(user.uid) : false;
    if (fresh) await bringGuest(user.uid, online);
  } else await P.init('guest');
  mountAccount(cloud);
  const eng = await import('./lib/engine.js');
  await import('./app.js');
  eng.start();
}

(async () => {
  try { cloud = await import('./lib/cloud.js'); }
  catch (e) {
    // Firebase could not load (offline on a first visit, or blocked): open what this browser has.
    console.warn('Triaj: accounts unavailable', e);
    const last = localStorage.getItem('triaj:last-uid');
    return run(last ? { uid: last, email: '' } : null);
  }
  cloud.onUser(async (user) => {
    if (booted) {
      // Signed out, or switched account: start over cleanly.
      if (!user && session.user) { await P.wipe(session.user.uid); localStorage.removeItem('triaj:mode'); localStorage.removeItem('triaj:last-uid'); }
      if ((user && user.uid) !== (session.user && session.user.uid)) location.reload();
      return;
    }
    if (user) return run(user);
    if (localStorage.getItem('triaj:mode') === 'guest') return run(null);
    document.getElementById('view').innerHTML = '';
    gate = showGate(cloud, { onGuest: () => run(null) });
  });
})();
