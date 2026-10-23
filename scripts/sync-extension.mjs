// Copies the modules the companion shares with the website into extension/lib:
//   canvas-scan.js  reads Canvas (the companion runs it inside a Canvas tab)
//   timer-core.js   the focus timer (the companion runs it in the background)
//   sounds.js       timer sounds and focus noise
//   node scripts/sync-extension.mjs          copy
//   node scripts/sync-extension.mjs --check  fail if a copy is out of date (used by CI)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const FILES = ['canvas-scan.js', 'timer-core.js', 'sounds.js'];
const check = process.argv.includes('--check');
let stale = [];
for (const f of FILES) {
  const src = new URL('../web/app/lib/' + f, import.meta.url), dst = new URL('../extension/lib/' + f, import.meta.url);
  const a = readFileSync(src, 'utf8').replace(/\r\n/g, '\n');
  if (check) { if (!existsSync(dst) || readFileSync(dst, 'utf8').replace(/\r\n/g, '\n') !== a) stale.push(f); }
  else writeFileSync(dst, a);
}
if (check && stale.length) { console.error('Out of date in extension/lib: ' + stale.join(', ') + '. Run: node scripts/sync-extension.mjs'); process.exit(1); }
console.log(check ? 'extension is in sync' : 'copied ' + FILES.join(', ') + ' into extension/lib');
