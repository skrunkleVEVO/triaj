// Synthesized sounds (no audio files needed). Used by the offscreen audio page and for previews.

export const SOUNDS = {
  chime: 'Chime', bell: 'Bell', marimba: 'Marimba', gong: 'Gong', digital: 'Digital beeps',
  rise: 'Rising tones', nudge: 'Soft nudge', tick: 'Woodblock', none: 'Silent'
};
export const AMBIENT = { none: 'None', brown: 'Brown noise (deep)', pink: 'Pink noise (rain-like)', white: 'White noise', cafe: 'Low hum + soft noise' };

let ctx = null;
function ac() {
  if (!ctx) ctx = new (self.AudioContext || self.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function note(a, out, freq, t0, dur, type, peak, attack) {
  const o = a.createOscillator(), g = a.createGain();
  o.type = type || 'sine';
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + (attack || 0.015));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g); g.connect(out);
  o.start(t0); o.stop(t0 + dur + 0.05);
}

export function playSound(name, volume) {
  if (!name || name === 'none') return 0;
  const a = ac(), out = a.createGain(), t = a.currentTime + 0.03;
  out.gain.value = Math.max(0, Math.min(1, volume === undefined ? 0.7 : volume));
  out.connect(a.destination);
  let len = 1;
  switch (name) {
    case 'chime':
      [[660, 0], [880, 0.14], [1320, 0.28]].forEach((n) => note(a, out, n[0], t + n[1], 0.9, 'sine', 0.3));
      len = 1.3; break;
    case 'bell':
      [1, 2.01, 2.76, 5.4].forEach((h, i) => note(a, out, 523 * h, t, 2.4 / (i + 1), 'sine', 0.3 / (i + 1), 0.005));
      len = 2.5; break;
    case 'marimba':
      [523, 659, 784, 1047].forEach((f, i) => note(a, out, f, t + i * 0.12, 0.45, 'triangle', 0.35, 0.005));
      len = 1; break;
    case 'gong':
      [110, 165.5, 221, 293].forEach((f, i) => note(a, out, f, t, 4 - i * 0.6, 'sine', 0.35 / (i + 1), 0.04));
      len = 4; break;
    case 'digital':
      for (let i = 0; i < 3; i++) note(a, out, 1000, t + i * 0.22, 0.12, 'square', 0.12, 0.003);
      len = 0.8; break;
    case 'rise':
      [392, 494, 587, 784].forEach((f, i) => note(a, out, f, t + i * 0.18, 0.6, 'sine', 0.28));
      len = 1.4; break;
    case 'nudge':
      note(a, out, 740, t, 0.5, 'sine', 0.2, 0.03); note(a, out, 554, t + 0.22, 0.7, 'sine', 0.18, 0.03);
      len = 1; break;
    case 'tick':
      note(a, out, 1800, t, 0.06, 'triangle', 0.4, 0.002); note(a, out, 1200, t + 0.15, 0.06, 'triangle', 0.3, 0.002);
      len = 0.4; break;
  }
  return len;
}

let amb = null;
function noiseBuffer(a, kind) {
  const len = a.sampleRate * 4, buf = a.createBuffer(2, len, a.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let last = 0, b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
      else if (kind === 'pink' || kind === 'cafe') {
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
      } else d[i] = w * 0.5;
    }
  }
  return buf;
}
export function startAmbient(kind, volume) {
  stopAmbient();
  if (!kind || kind === 'none') return;
  const a = ac(), g = a.createGain(), src = a.createBufferSource();
  src.buffer = noiseBuffer(a, kind);
  src.loop = true;
  g.gain.setValueAtTime(0.0001, a.currentTime);
  g.gain.exponentialRampToValueAtTime(Math.max(0.001, volume || 0.25), a.currentTime + 1.5);
  let node = src;
  if (kind === 'cafe') {
    const lp = a.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900; src.connect(lp); node = lp;
    const hum = a.createOscillator(), hg = a.createGain(); hum.frequency.value = 110; hg.gain.value = 0.04; hum.connect(hg); hg.connect(g); hum.start();
    amb = { src, g, hum };
  } else amb = { src, g };
  node.connect(g); g.connect(a.destination);
  src.start();
}
export function setAmbientVolume(v) { if (amb) amb.g.gain.setTargetAtTime(Math.max(0.001, v), ac().currentTime, 0.2); }
export function stopAmbient() {
  if (!amb) return;
  const a = ac(), x = amb; amb = null;
  x.g.gain.setTargetAtTime(0.0001, a.currentTime, 0.3);
  setTimeout(() => { try { x.src.stop(); if (x.hum) x.hum.stop(); } catch (e) {} }, 1200);
}
export function ambientPlaying() { return !!amb; }
