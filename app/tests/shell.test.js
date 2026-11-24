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
for (const f of ['engine.js', 'pack.js', 'store.js', 'backup.js', 'session.js', 'sync.js', 'vault.js', 'vaultsync.js']) for (const m of read(f).matchAll(/from '\.\/([^']+)'/g)) loaded.add(m[1]);

test('every file the page loads is saved for offline use', () => {
  assert.deepEqual([...loaded].filter(f => !listed.includes(f)), []);
});
test('every file in the offline list exists', () => {
  assert.deepEqual(listed.filter(f => !existsSync(new URL('../' + f, import.meta.url))), []);
});
test('the app loads nothing from the internet', () => {
  for (const f of ['index.html', 'style.css', 'app.js', 'sw.js', 'engine.js', 'pack.js', 'store.js', 'backup.js', 'session.js', 'sync.js', 'vaultsync.js'])
    assert.doesNotMatch(read(f), /https?:\/\/(?!www\.w3\.org)/, f);
});

// The vault client is the one place that may use the network, and it may only talk to GitHub's API.
test('only the vault client names a web address, and only GitHub\'s API', () => {
  const hosts = [...read('vault.js').matchAll(/https?:\/\/[^/'"`\s)]+/g)].map(m => m[0]);
  assert.deepEqual([...new Set(hosts)], ['https://api.github.com']);
  assert.equal([...read('vault.js').matchAll(/\bfetch\b/g)].length > 0, true);
  for (const f of ['app.js', 'vaultsync.js', 'store.js', 'sync.js', 'sw.js']) assert.doesNotMatch(read(f).replace(/fetch\(e\.request\)/g, ''), /\bfetch\(/, f + ' must not call fetch itself');
});

// A version shown on Home that does not match the saved copies would be worse than none.
test('the version shown on Home is the version of the offline copy', () => {
  const shown = read('app.js').match(/const APP_VERSION = (\d+);/)[1], cached = read('sw.js').match(/vi-trainer-app-v(\d+)/)[1];
  assert.equal(shown, cached);
});

// The vault code may not write cards or sentences itself: progress changes only through syncNow and restoreVersion
// (which re-check the rules inside the write), and sentences only through downloadPacks.
test('the vault code in app.js cannot write progress or sentences directly', () => {
  const app = read('app.js'), dash = '-'.repeat(64);
  const a = app.indexOf('// ' + dash + ' vault'), b = app.indexOf('// ' + dash + ' end of vault');
  assert.ok(a >= 0 && b > a, 'vault section markers not found');
  assert.doesNotMatch(app.slice(a, b), /saveDeck|replaceDeck|savePack|mergeInto|restoreDeck|E\.review|E\.undo|E\.learnMore|saveSettings/);
});

// The token must never be written anywhere but its own place in storage.
test('the token is only ever handled by the vault client and its own storage functions', () => {
  for (const f of ['backup.js', 'sync.js', 'vaultsync.js', 'engine.js', 'session.js'])
    assert.doesNotMatch(read(f), /token/i, f + ' must not know about the token');
  assert.doesNotMatch(read('app.js'), /localStorage\.setItem\([^)]*token/i);
});

// Read-along must never change progress: its section of app.js may not save, replace, grade or undo anything.
test('the read-along code cannot touch card progress', () => {
  const app = read('app.js'), dash = '-'.repeat(64);
  const a = app.indexOf('// ' + dash + ' read-along'), b = app.indexOf('// ' + dash + ' end of read-along');
  assert.ok(a >= 0 && b > a, 'read-along section markers not found');
  assert.doesNotMatch(app.slice(a, b), /saveDeck|replaceDeck|savePack|saveSettings|E\.review|E\.undo|deck\s*=[^=]/);
});

// A mistyped element name would only show up on the phone, so check them all here.
test('every element app.js looks up exists in index.html', () => {
  const ids = new Set([...read('index.html').matchAll(/ id="([^"]+)"/g)].map(m => m[1]));
  const used = [...read('app.js').matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(used)].filter(id => !ids.has(id)), []);
});

// The hands-free builder must never change progress either: its section of app.js may not save, replace, grade or undo anything.
test('the hands-free code cannot touch card progress', () => {
  const app = read('app.js'), dash = '-'.repeat(64);
  const a = app.indexOf('// ' + dash + ' hands-free'), b = app.indexOf('// ' + dash + ' end of hands-free');
  assert.ok(a >= 0 && b > a, 'hands-free section markers not found');
  assert.doesNotMatch(app.slice(a, b), /saveDeck|replaceDeck|savePack|saveSettings|E\.review|E\.undo|E\.learnMore|deck\s*=[^=]/);
});
