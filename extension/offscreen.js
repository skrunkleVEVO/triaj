// Plays timer sounds and focus noise for the background worker (Chrome workers can't play audio).
import { playSound, startAmbient, stopAmbient } from './lib/sounds.js';
const B = globalThis.browser || globalThis.chrome;
B.runtime.onMessage.addListener((m, _s, reply) => {
  if (!m || m.target !== 'offscreen') return;
  if (m.cmd === 'play') playSound(m.sound, m.volume);
  else if (m.cmd === 'ambient') startAmbient(m.kind, m.volume);
  else if (m.cmd === 'stopAmbient') stopAmbient();
  reply({ ok: true });
});
