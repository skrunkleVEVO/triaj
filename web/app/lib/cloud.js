// Your Triaj account: Firebase sign-in, and the planner mirrored to Firestore so every browser you
// sign in on has the same data.
//
// Layout: users/{uid}/data/{part}~{chunk}. The plan is split by top-level field (tasks, classes, cfg…)
// so a change only uploads the part that changed; big parts are chunked under Firestore's 1 MiB doc limit.
// Each part carries a hash. This browser remembers the hash it last agreed on with the server, which
// tells "I changed it" apart from "another device changed it" (see reconcile()).
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  createUserWithEmailAndPassword, signInWithEmailAndPassword, sendPasswordResetEmail, updateProfile, signOut as fbSignOut
} from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js';
import { initializeFirestore, collection, doc, onSnapshot, writeBatch, serverTimestamp } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js';
import * as P from './platform.js';

export const firebaseConfig = {
  apiKey: 'AIzaSyDceZvrcCSrpCwwOLXj1a3aK3WiFkvfXtM',
  authDomain: 'triaj-planner-21678.firebaseapp.com',
  projectId: 'triaj-planner-21678',
  storageBucket: 'triaj-planner-21678.firebasestorage.app',
  messagingSenderId: '1037619068478',
  appId: '1:1037619068478:web:6604d0f9e1d42262811b6f'
};
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
const db = initializeFirestore(app, { ignoreUndefinedProperties: true });

/* ---------------- sign-in ---------------- */
export const onUser = (fn) => onAuthStateChanged(auth, fn);
export async function signInGoogle() {
  const pr = new GoogleAuthProvider();
  pr.setCustomParameters({ prompt: 'select_account' });
  try { return await signInWithPopup(auth, pr); }
  catch (e) {
    // Some phones and in-app browsers block popups: fall back to a full-page redirect.
    if (e && /popup-blocked|operation-not-supported|cancelled-popup/.test(e.code || '')) return signInWithRedirect(auth, pr);
    throw e;
  }
}
getRedirectResult(auth).catch(() => {});
export const signInEmail = (email, pw) => signInWithEmailAndPassword(auth, email, pw);
export async function signUpEmail(email, pw, name) {
  const c = await createUserWithEmailAndPassword(auth, email, pw);
  if (name) await updateProfile(c.user, { displayName: name }).catch(() => {});
  return c;
}
export const resetPassword = (email) => sendPasswordResetEmail(auth, email);
export async function signOut() { await flush(); if (unsub) unsub(); unsub = null; col = null; await fbSignOut(auth); }

export function authError(e) {
  const c = (e && e.code) || '';
  const M = {
    'auth/invalid-email': 'That email address doesn\'t look right.',
    'auth/missing-password': 'Enter your password.',
    'auth/weak-password': 'Use at least 6 characters for the password.',
    'auth/email-already-in-use': 'There\'s already an account with that email. Sign in instead.',
    'auth/invalid-credential': 'Wrong email or password.',
    'auth/wrong-password': 'Wrong email or password.',
    'auth/user-not-found': 'No account with that email. Create one instead.',
    'auth/too-many-requests': 'Too many tries. Wait a minute and try again.',
    'auth/popup-closed-by-user': 'The sign-in window was closed.',
    'auth/network-request-failed': 'No connection. Check your internet and try again.',
    'auth/unauthorized-domain': 'Sign-in isn\'t allowed on this address yet.'
  };
  return M[c] || (e && e.message) || String(e);
}

/* ---------------- sync ---------------- */
const CHUNK = 800000; // characters per document, safely under the 1 MiB limit
const NOSYNC = new Set(['rev', 'by']); // change on every save; meaningless across devices
let col = null, meta = {}, remote = {}, first = true, unsub = null;
const timers = {}, inflight = {};
const statusL = [];
export let status = { state: 'off', at: 0, err: '' };
function setStatus(state, err) { status = { state, at: Date.now(), err: err || '' }; statusL.forEach((fn) => fn(status)); }
export const onStatus = (fn) => { statusL.push(fn); fn(status); };

function hash(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36) + '.' + s.length; }
// name -> JSON text, for one storage key
function partsOf(key, value) {
  const out = {};
  if (value === undefined || value === null) return out;
  if (key === 'plan') Object.keys(value).forEach((p) => { if (!NOSYNC.has(p) && value[p] !== undefined) out['plan.' + p] = JSON.stringify(value[p]); });
  else out[key] = JSON.stringify(value);
  return out;
}
const keyOf = (name) => name.split('.')[0];
function saveMeta() { P.ext.storage.local.set({ cloudMeta: meta }); }

// Server docs -> { name: { h, json, n, t, by } }, skipping any part whose chunks don't all match.
function assemble(docs) {
  const by = {};
  docs.forEach((d) => { const x = d.data(); if (x && x.p) (by[x.p] = by[x.p] || []).push(x); });
  const out = {};
  Object.keys(by).forEach((name) => {
    const list = by[name], head = list.find((x) => x.i === 0);
    if (!head) return;
    const parts = list.filter((x) => x.h === head.h).sort((a, b) => a.i - b.i);
    if (parts.length !== head.n) return;
    out[name] = { h: head.h, json: parts.map((x) => x.v).join(''), n: head.n, t: head.t || 0, by: head.by, docs: list.length };
  });
  return out;
}

// Decide, part by part, whether this browser or the server has the newer copy.
//   local == server               nothing to do
//   only the server changed       take it       (local still equals what we last agreed on)
//   only this browser changed     upload it     (server still equals what we last agreed on)
//   never synced here             take the server's copy
//   both changed                  the newer edit wins
function reconcile() {
  const local = {};
  P.CLOUD_KEYS.forEach((k) => Object.assign(local, partsOf(k, P.peek(k))));
  const names = new Set(Object.keys(local).concat(Object.keys(remote)));
  const take = {}, give = new Set();
  names.forEach((name) => {
    if (inflight[name]) return;
    const L = local[name], R = remote[name], S = meta[name], lh = L !== undefined ? hash(L) : undefined;
    if (R && R.h === lh) { meta[name] = lh; return; }
    if (!R) { if (L !== undefined && lh !== S) give.add(keyOf(name)); return; }
    if (S === undefined || lh === S || L === undefined) { take[name] = R; return; }
    if (R.h === S) { give.add(keyOf(name)); return; }
    const lt = (meta.__t && meta.__t[name]) || 0;
    if (lt > R.t) give.add(keyOf(name)); else take[name] = R;
  });
  // Apply what the server has, one storage key at a time.
  P.CLOUD_KEYS.forEach((k) => {
    const mine = Object.keys(take).filter((n) => keyOf(n) === k);
    if (!mine.length) return;
    let v;
    if (k === 'plan') {
      v = Object.assign({}, P.peek('plan') || {});
      mine.forEach((n) => { v[n.slice(5)] = JSON.parse(take[n].json); });
      v.rev = (v.rev || 0) + 1; v.by = 'cloud';
    } else v = JSON.parse(take[mine[0]].json);
    mine.forEach((n) => { meta[n] = take[n].h; });
    P.applyRemote(k, v);
  });
  saveMeta();
  give.forEach((k) => push(k));
}

function schedule(key) {
  meta.__t = meta.__t || {};
  const ps = partsOf(key, P.peek(key));
  Object.keys(ps).forEach((n) => { if (hash(ps[n]) !== meta[n]) meta.__t[n] = Date.now(); }); // when each part was last edited here
  clearTimeout(timers[key]);
  timers[key] = setTimeout(() => push(key), 1200);
  if (status.state !== 'offline') setStatus('pending');
}
async function push(key) {
  clearTimeout(timers[key]); delete timers[key];
  if (!col) return;
  const ps = partsOf(key, P.peek(key)), batch = writeBatch(db), sent = [];
  Object.keys(ps).forEach((name) => {
    const json = ps[name], h = hash(json);
    if (remote[name] && remote[name].h === h) { meta[name] = h; return; }
    const chunks = [];
    for (let i = 0; i < json.length || i === 0; i += CHUNK) chunks.push(json.slice(i, i + CHUNK));
    const t = (meta.__t && meta.__t[name]) || Date.now();
    chunks.forEach((v, i) => batch.set(doc(col, name + '~' + i), { p: name, i, n: chunks.length, h, v, by: P.tabId, t, at: serverTimestamp() }));
    for (let i = chunks.length; i < ((remote[name] && remote[name].docs) || 0); i++) batch.delete(doc(col, name + '~' + i));
    inflight[name] = h; sent.push({ name, h, n: chunks.length, t });
  });
  if (!sent.length) { saveMeta(); if (!Object.keys(timers).length && !Object.keys(inflight).length) setStatus('synced'); return; }
  setStatus(navigator.onLine === false ? 'offline' : 'saving');
  try {
    await batch.commit();
    sent.forEach((x) => { meta[x.name] = x.h; remote[x.name] = { h: x.h, n: x.n, t: x.t, docs: x.n }; if (inflight[x.name] === x.h) delete inflight[x.name]; });
    saveMeta();
    if (!Object.keys(timers).length && !Object.keys(inflight).length) setStatus('synced');
  } catch (e) {
    sent.forEach((x) => { delete inflight[x.name]; });
    console.warn('Triaj: could not save to your account', e);
    setStatus('error', (e && e.message) || String(e));
  }
}
// Send anything still waiting (before signing out or leaving the page).
export async function flush() { await Promise.all(Object.keys(timers).map((k) => push(k))); }
addEventListener('pagehide', () => { Object.keys(timers).forEach((k) => push(k)); });
document.addEventListener('visibilitychange', () => { if (document.hidden) Object.keys(timers).forEach((k) => push(k)); });
addEventListener('offline', () => setStatus('offline'));
addEventListener('online', () => setStatus(Object.keys(timers).length ? 'pending' : 'synced'));

// Start mirroring this account. Resolves once the server's copy has been merged in (true),
// or after a few seconds without a connection (false; it keeps trying in the background).
export function startSync(uid) {
  col = collection(db, 'users', uid, 'data');
  meta = P.peek('cloudMeta') || {};
  P.setCloud({ push: schedule });
  setStatus('connecting');
  return new Promise((resolve) => {
    const t = setTimeout(() => { setStatus('offline'); resolve(false); }, 7000);
    unsub = onSnapshot(col, { includeMetadataChanges: true }, (snap) => {
      if (snap.metadata.fromCache || snap.metadata.hasPendingWrites) return;
      remote = assemble(snap.docs);
      reconcile();
      if (first) { first = false; clearTimeout(t); if (!Object.keys(timers).length && !Object.keys(inflight).length) setStatus('synced'); resolve(true); }
    }, (e) => { console.warn('Triaj: sync stopped', e); setStatus('error', e.message); clearTimeout(t); resolve(false); });
  });
}
// Does the account already hold a planner? (Known after startSync resolves true.)
export const remoteHasPlan = () => Object.keys(remote).some((n) => n.indexOf('plan.') === 0);
