// Copies the Canvas reader the website uses into the companion extension (it runs it in a Canvas tab).
//   node scripts/sync-extension.mjs          copy
//   node scripts/sync-extension.mjs --check  fail if the copy is out of date (used by CI)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const src = new URL('../web/app/lib/canvas-scan.js', import.meta.url);
const dst = new URL('../extension/lib/canvas-scan.js', import.meta.url);
const a = readFileSync(src, 'utf8');
if (process.argv.includes('--check')) {
  if (!existsSync(dst) || readFileSync(dst, 'utf8') !== a) { console.error('extension/lib/canvas-scan.js is out of date. Run: node scripts/sync-extension.mjs'); process.exit(1); }
  console.log('extension is in sync');
} else { writeFileSync(dst, a); console.log('copied canvas-scan.js into the extension'); }
