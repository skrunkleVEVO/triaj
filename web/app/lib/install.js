// "Install Triaj": uses the browser's own install prompt where there is one (Chrome, Edge, Samsung
// Internet, Android), and shows the steps where there isn't (iPhone/iPad Safari, Firefox).
// Used by the app and the landing page.
let deferred = null;
const L = [];
const emit = () => L.forEach((fn) => { try { fn(); } catch (e) {} });
export const onChange = (fn) => L.push(fn);

export const standalone = () => { try { return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; } catch (e) { return false; } };
const ua = navigator.userAgent;
const isIOS = () => /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = () => /android/i.test(ua);
const touch = () => { try { return matchMedia('(pointer:coarse)').matches; } catch (e) { return false; } };

addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; emit(); });
addEventListener('appinstalled', () => { deferred = null; emit(); });

// Worth offering: the browser can install it, or it's a phone/tablet where the steps help.
export const installable = () => !standalone() && (!!deferred || isIOS() || isAndroid() || touch());

const STYLE = '.tjm{position:fixed;inset:0;z-index:99;background:rgba(8,12,28,.55);display:flex;align-items:flex-end;justify-content:center;font:15px/1.5 "Atkinson",system-ui,sans-serif}' +
  '.tjm>div{background:#fff;color:#15224a;width:100%;max-width:440px;border-radius:16px 16px 0 0;padding:22px 20px calc(20px + env(safe-area-inset-bottom,0px))}' +
  '@media (min-width:600px){.tjm{align-items:center}.tjm>div{border-radius:16px}}' +
  '@media (prefers-color-scheme:dark){.tjm>div{background:#121a33;color:#e8ecf8}}' +
  '.tjm h2{font:800 21px/1.2 "Archivo",system-ui,sans-serif;font-stretch:92%;margin:0 0 12px}.tjm ol{margin:0 0 16px;padding-left:22px}.tjm li{margin:6px 0}' +
  '.tjm button{font:700 15px "Archivo",system-ui,sans-serif;width:100%;padding:12px;border:0;border-radius:10px;background:#15224a;color:#fff;cursor:pointer}' +
  '@media (prefers-color-scheme:dark){.tjm button{background:#9db4ff;color:#0c1430}}.tjm .ic{display:inline-block;vertical-align:-3px}';
const SHARE = '<svg class="ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="Share"><path d="M12 15V3M8 7l4-4 4 4"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>';
const DOTS = '<b aria-label="menu">⋮</b>';

function steps() {
  if (isIOS()) {
    const notSafari = /crios|fxios|edgios/i.test(ua);
    return { title: 'Add Triaj to your Home Screen', list: [
      notSafari ? 'Tap the Share button ' + SHARE + ' (in Chrome it\'s at the top right, next to the address).' : 'Tap the Share button ' + SHARE + ' at the bottom of Safari.',
      'Scroll down and tap <b>Add to Home Screen</b>.', 'Tap <b>Add</b>. Triaj opens full screen from its icon.'] };
  }
  if (/firefox/i.test(ua)) return { title: 'Install Triaj', list: ['Open the Firefox menu ' + DOTS + '.', 'Tap <b>Install</b> (or <b>Add to Home screen</b>).', 'Confirm, and open Triaj from its new icon.'] };
  if (/samsungbrowser/i.test(ua)) return { title: 'Install Triaj', list: ['Open the menu <b>≡</b> at the bottom.', 'Tap <b>Add page to</b>, then <b>Home screen</b>.'] };
  if (isAndroid() || touch()) return { title: 'Install Triaj', list: ['Open the browser menu ' + DOTS + ' at the top right.', 'Tap <b>Install app</b> (or <b>Add to Home screen</b>, then <b>Install</b>).', 'Open Triaj from its new icon.'] };
  return { title: 'Install Triaj', list: ['Click the install icon at the right end of the address bar (a screen with a down arrow).', 'Or open the browser menu and choose <b>Install Triaj</b> / <b>Apps → Install this site as an app</b>.'] };
}

export async function install() {
  if (deferred) {
    const d = deferred;
    d.prompt();
    const r = await d.userChoice.catch(() => ({}));
    deferred = null; emit();
    return r.outcome || 'dismissed';
  }
  if (!document.getElementById('tjm-style')) { const st = document.createElement('style'); st.id = 'tjm-style'; st.textContent = STYLE; document.head.appendChild(st); }
  const s = steps(), m = document.createElement('div');
  m.className = 'tjm';
  m.innerHTML = '<div role="dialog" aria-modal="true" aria-label="' + s.title + '"><h2>' + s.title + '</h2><ol>' + s.list.map((x) => '<li>' + x + '</li>').join('') + '</ol><button type="button">Got it</button></div>';
  const close = () => m.remove();
  m.addEventListener('click', (e) => { if (e.target === m || e.target.tagName === 'BUTTON') close(); });
  document.body.appendChild(m);
  m.querySelector('button').focus();
  return 'instructions';
}
