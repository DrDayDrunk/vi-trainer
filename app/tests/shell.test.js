// Offline safety: every file the page loads must be in the service worker's list, and every listed file must exist.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const read = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const listed = [...read('sw.js').match(/const FILES = \[([\s\S]*?)\];/)[1].matchAll(/'\.\/([^']*)'/g)].map(m => m[1]).filter(Boolean);
const loaded = new Set();
for (const m of read('index.html').matchAll(/(?:src|href)="([^"#]+)"/g)) if (!/^https?:/.test(m[1])) loaded.add(m[1]);
for (const m of read('style.css').matchAll(/url\(([^)]+)\)/g)) loaded.add(m[1]);
for (const f of ['app.js']) for (const m of read(f).matchAll(/from '\.\/([^']+)'/g)) loaded.add(m[1]);
for (const f of ['engine.js', 'pack.js', 'store.js']) for (const m of read(f).matchAll(/from '\.\/([^']+)'/g)) loaded.add(m[1]);

test('every file the page loads is saved for offline use', () => {
  assert.deepEqual([...loaded].filter(f => !listed.includes(f)), []);
});
test('every file in the offline list exists', () => {
  assert.deepEqual(listed.filter(f => !existsSync(new URL('../' + f, import.meta.url))), []);
});
test('the app loads nothing from the internet', () => {
  for (const f of ['index.html', 'style.css', 'app.js', 'sw.js', 'engine.js', 'pack.js', 'store.js'])
    assert.doesNotMatch(read(f), /https?:\/\/(?!www\.w3\.org)/, f);
});
