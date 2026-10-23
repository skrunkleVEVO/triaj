// Toolbar popup: open Triaj, and "Sync from this tab" when you're on Canvas.
const B = globalThis.browser || globalThis.chrome;
const $ = (id) => document.getElementById(id);
const send = (cmd, args) => B.runtime.sendMessage({ triaj: 1, cmd, args: args || {} });
const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

$('open').onclick = async () => { await send('open'); window.close(); };

(async () => {
  const { canvasHost } = await B.storage.local.get('canvasHost');
  let tab = null;
  try { [tab] = await B.tabs.query({ active: true, currentWindow: true }); } catch (e) {}
  let host = '';
  try { host = tab && tab.url ? new URL(tab.url).hostname : ''; } catch (e) {}
  const onCanvas = host && (host === canvasHost || /(^|\.)instructure\.com$|canvas/i.test(host));
  if (!onCanvas) {
    let perm = true;
    if (canvasHost) try { perm = await B.permissions.contains({ origins: ['https://' + canvasHost + '/*'] }); } catch (e) {}
    $('tab').innerHTML = canvasHost
      ? '<b>Canvas · ' + esc(canvasHost) + '</b><div class="s ' + (perm ? 'ok' : 'err') + '" style="margin-top:4px">' + (perm ? '✓ Triaj can sync it' : '🔑 Access is off. Open Triaj → More → Sync → Allow access, or open Canvas and click this icon.') + '</div>'
      : '<b>Canvas not connected yet</b><div class="s" style="margin-top:4px">Open Triaj → More → Sync and enter your Canvas address.</div>';
    return;
  }
  $('tab').innerHTML = '<b>You\'re on Canvas</b><div class="s" style="margin-top:4px">Read your courses from this tab and send them to Triaj. Works even when site access is switched off.</div><button class="b" id="ts">Sync from this tab</button><div class="s" id="tsm" style="margin-top:6px"></div>';
  $('ts').onclick = async () => {
    $('ts').disabled = true; $('ts').textContent = 'Reading Canvas… (10–30 seconds)';
    const r = await send('tabSync', { tabId: tab.id });
    $('ts').disabled = false; $('ts').textContent = 'Sync from this tab';
    $('tsm').className = 's ' + (r && r.kind === 'ok' ? 'ok' : 'err');
    $('tsm').textContent = (r && r.text) || 'Something went wrong.';
  };
})();
