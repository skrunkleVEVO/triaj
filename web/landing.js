// Triaj landing page: install buttons, the live "sort it" page, the week row, the room crossfade and section entrances.
import { installable, install, onChange, standalone } from './app/lib/install.js';

const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
document.documentElement.classList.add('js');

/* install */
const b1 = $('#install'), b2 = $('#install2');
const paint = () => { b1.hidden = !installable(); if (standalone()) $('#phone').hidden = true; };
onChange(paint); paint();
b1.onclick = b2.onclick = () => install();
$$('[data-open]').forEach((a) => a.addEventListener('click', () => { const d = document.getElementById(a.dataset.open); if (d) d.open = true; }));

/* companion browser tabs */
$$('.btabs button').forEach((b) => b.addEventListener('click', () => {
  $$('.btabs button').forEach((x) => x.setAttribute('aria-selected', x === b ? 'true' : 'false'));
  $$('.steps').forEach((s) => { s.hidden = s.dataset.b !== b.dataset.b; });
}));
if (/firefox/i.test(navigator.userAgent)) $('.btabs [data-b="firefox"]').click();

/* triage tabs: light one column of the page */
const TEXT = {
  now: 'Now is what needs you today: due soon and not started, or bigger than the time left. Triaj puts the one to start first at the top.',
  soon: 'Soon is the next few days. Big things get study blocks early, so Sunday night stays quiet. In-class quizzes sit on the class itself.',
  later: 'Later can wait, and Triaj says until when: a lab that opens Thursday, a midterm you start studying for on the 25th.'
};
const board = $('#board'), tabtext = $('#tabtext');
function light(c) {
  $$('.tabs button').forEach((x) => x.setAttribute('aria-selected', x.dataset.c === c ? 'true' : 'false'));
  tabtext.textContent = TEXT[c];
  board.classList.add('focus');
  $$('.col', board).forEach((col) => col.classList.toggle('lit', col.dataset.c === c));
}
$$('.tabs button').forEach((b) => b.addEventListener('click', () => light(b.dataset.c)));
$('.tabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const tabs = $$('.tabs button'), i = tabs.indexOf(document.activeElement);
  const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]; n.focus(); n.click();
});

/* the live thing: sort something that's due, the way Triaj does */
const form = $('#tryform'); form.hidden = false;
const DAY = 864e5, fmt = (d) => d.toLocaleDateString(undefined, { weekday: 'long' }), fmtD = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
function sortIt(name, due, hours) {
  // Same idea as the planner: hours of work against the study days left (about 3 h a day).
  const days = Math.max(due, 0.5), load = hours / (days * 3);
  const blocks = Math.max(1, Math.ceil(hours / 1.5)), per = hours / blocks;
  const len = per >= 1 ? (Math.round(per * 2) / 2) + ' h' : Math.round(per * 60) + ' min';
  const when = new Date(Date.now() + DAY * due);
  if (due <= 1 || load > 0.6) return { c: 'now', meta: (due === 0 ? 'due today' : 'due ' + (due === 1 ? 'tomorrow' : fmt(when))) + ' · ' + blocks + ' × ' + len,
    say: 'start today: ' + blocks + (blocks > 1 ? ' blocks' : ' block') + ' of ' + len + (due === 0 ? ', before it\'s due tonight.' : ', done before ' + (due === 1 ? 'tomorrow.' : fmt(when) + '.')) };
  if (due <= 5) { const start = new Date(Date.now() + DAY * Math.max(1, Math.floor(due / 2))); return { c: 'soon', meta: 'due ' + fmt(when) + ' · ' + blocks + ' blocks',
    say: blocks + ' blocks of ' + len + ', starting ' + fmt(start) + ', so ' + fmt(when) + ' is calm.' }; }
  const start = new Date(when - DAY * Math.min(7, Math.ceil(hours) + 2));
  return { c: 'later', meta: 'due ' + fmtD(when) + ' · from ' + fmtD(start), say: 'nothing to do yet. It starts on ' + fmtD(start) + ', ' + blocks + ' blocks before it\'s due.' };
}
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = ($('#tn').value.trim() || 'Something due').slice(0, 40);
  const r = sortIt(name, +$('#td').value, +$('#ts').value);
  $$('.it.new', board).forEach((x) => x.remove());
  const it = document.createElement('div'); it.className = 'it new';
  const b = document.createElement('b'); b.textContent = name;
  const s = document.createElement('span'); s.textContent = r.meta;
  it.append(b, s);
  $('.col[data-c="' + r.c + '"] h3', board).after(it);
  const v = $('#verdict'); v.innerHTML = ''; v.style.setProperty('--hl', 'var(--hl-' + r.c + ')');
  const tag = document.createElement('b'); tag.textContent = r.c[0].toUpperCase() + r.c.slice(1);
  v.append(tag, ' ' + name + ': ' + r.say);
  light(r.c);
});

/* the week row: arrows and progress */
const row = $('#wrow'), bar = $('#wbar');
const prog = () => { const max = row.scrollWidth - row.clientWidth; const f = max > 0 ? row.scrollLeft / max : 1; bar.style.width = (20 + f * 80) + '%'; };
row.addEventListener('scroll', prog, { passive: true }); addEventListener('resize', prog); prog();
const step = (d) => row.scrollBy({ left: d * 312, behavior: reduce ? 'auto' : 'smooth' });
$('#wprev').onclick = () => step(-1); $('#wnext').onclick = () => step(1);

/* signature: the reading room changes light, slowly */
const pics = $$('.room img');
if (!reduce && pics.length > 1) {
  let i = 0, t = null;
  const tick = () => { pics[i].classList.remove('on'); i = (i + 1) % pics.length; pics[i].classList.add('on'); };
  const go = () => { clearInterval(t); t = document.hidden ? null : setInterval(tick, 6000); };
  document.addEventListener('visibilitychange', go); go();
}

/* entrances: heading, then text, then picture, once */
$$('main>section, footer').forEach((sec) => $$('.rv', sec).forEach((el, k) => el.style.setProperty('--d', (k * 80) + 'ms')));
$$('.row li').forEach((el, k) => el.style.setProperty('--d', (k * 70) + 'ms'));
const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -8% 0px' });
$$('.rv, .row li').forEach((el) => io.observe(el));

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
