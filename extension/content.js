// Runs on the Triaj website only. Passes the page's requests to the companion's background worker
// and its answers (and events) back. The page talks to it with window.postMessage (see web/app/lib/bridge.js).
(() => {
  const B = globalThis.browser || globalThis.chrome;
  const info = { version: B.runtime.getManifest().version };
  const post = (m) => window.postMessage(Object.assign({ src: 'triaj-ext' }, m), location.origin);
  const announce = () => post({ type: 'ready', info });

  window.addEventListener('message', async (e) => {
    const m = e.data;
    if (e.source !== window || !m || m.src !== 'triaj-page') return;
    if (m.type === 'hello') return announce();
    if (m.type !== 'call') return;
    let reply;
    try { reply = await B.runtime.sendMessage({ triaj: 1, cmd: m.cmd, args: m.args }); }
    catch (err) { reply = { error: 'The Triaj companion was updated or restarted. Reload this page.' }; }
    post({ type: 'reply', id: m.id, reply: reply === undefined ? null : reply });
  });
  B.runtime.onMessage.addListener((m) => { if (m && m.triajEvent) post({ type: 'event', name: m.triajEvent, data: m.data || null }); });
  B.runtime.sendMessage({ triaj: 1, cmd: 'hello' }).catch(() => {});
  announce();
})();
