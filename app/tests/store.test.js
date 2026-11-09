// Needs the test-only helper fake-indexeddb (npm install). Skipped, not failed, when it is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';

let ready = true;
try { await import('fake-indexeddb/auto'); } catch { ready = false; }
const { openDb, savePack, getSentence, allNumbers, loadDeck, saveDeck, replaceDeck, loadSettings, saveSettings } = await import('../store.js');
const { realDeck, E } = await import('./helpers.js');
const opts = { skip: !ready && 'fake-indexeddb not installed' };
const S = o => ({ backupDays: 7, lastBackup: null, newPerDay: 10, retention: 0.9, startAt: null, ...o });   // every setting, with defaults

const gone = () => new Promise(ok => { const r = indexedDB.deleteDatabase('vitrainer'); r.onsuccess = r.onerror = r.onblocked = ok; });
const sentence = n => ({ number: n, level: 1, track: 1, en_text: 'e' + n, vi_text: 'v' + n, en_audio: new ArrayBuffer(8), vi_audio: new ArrayBuffer(8) });
// Puts progress straight into storage (the way a restore from a backup will later), bypassing the one-card-at-a-time guard.
const seed = (db, deck) => new Promise(ok => { const tx = db.transaction('meta', 'readwrite'); tx.objectStore('meta').put(deck, 'deck'); tx.oncomplete = ok; });
const deckOf = n => ({ cards: Object.fromEntries(Array.from({ length: n }, (_, i) => [i + 1, { state: 2, due: '2026-11-01T09:00:00.000Z' }])), last: null });

test('a first-time phone has an empty deck', opts, async () => {
  await gone(); const db = await openDb();
  assert.deepEqual(await loadDeck(db), { cards: {}, last: null });
  db.close();
});

test('a saved deck comes back exactly, including the undo information', opts, async () => {
  await gone(); const db = await openDb();
  const d = { ...deckOf(1), last: { n: 1, prev: null } };
  await saveDeck(db, d); db.close();
  const again = await openDb();                                 // reopened, as after closing the app
  assert.deepEqual(await loadDeck(again), d);
  again.close();
});

test('upgrading the storage keeps sentences that were already imported', opts, async () => {
  await gone();
  const v1 = await new Promise((ok, no) => {                    // the storage exactly as stage 1 made it
    const r = indexedDB.open('vitrainer', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('sentences', { keyPath: 'number' });
    r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
  });
  await new Promise(ok => { const tx = v1.transaction('sentences', 'readwrite'); [1, 2, 3].forEach(n => tx.objectStore('sentences').put(sentence(n))); tx.oncomplete = ok; });
  v1.close();
  const db = await openDb();
  assert.deepEqual(await allNumbers(db), [1, 2, 3]);
  assert.equal((await getSentence(db, 2)).vi_text, 'v2');
  assert.deepEqual(await loadDeck(db), { cards: {}, last: null });
  db.close();
});

test('importing sentences never touches saved progress', opts, async () => {
  await gone(); const db = await openDb();
  await seed(db, deckOf(5));
  await savePack(db, [1, 2, 3].map(sentence));
  assert.equal(Object.keys((await loadDeck(db)).cards).length, 5);
  db.close();
});

test('saving a deck that suddenly has far fewer cards is refused and the old one stays', opts, async () => {
  await gone(); const db = await openDb();
  await seed(db, deckOf(5));
  await assert.rejects(saveDeck(db, { cards: {}, last: null }));
  await assert.rejects(saveDeck(db, deckOf(3)));
  assert.equal(Object.keys((await loadDeck(db)).cards).length, 5);
  await saveDeck(db, deckOf(4));                                // one card fewer is an undo: allowed
  await saveDeck(db, deckOf(5));
  db.close();
});

test('saving one new card at a time works, the way studying grows a deck', opts, async () => {
  await gone(); const db = await openDb();
  for (const n of [1, 2, 3]) await saveDeck(db, deckOf(n));
  assert.equal(Object.keys((await loadDeck(db)).cards).length, 3);
  await assert.rejects(saveDeck(db, deckOf(6)));                // jumping by three is refused
  db.close();
});

test('progress that cannot be read is refused, never replaced by an empty deck', opts, async () => {
  await gone(); const db = await openDb();
  await new Promise(ok => { const tx = db.transaction('meta', 'readwrite'); tx.objectStore('meta').put('garbage', 'deck'); tx.oncomplete = ok; });
  await assert.rejects(loadDeck(db), /could not be read/);
  db.close();
});

// ---- restoring a whole deck from a backup (ticket 08)
const NOW = new Date(2026, 10, 3, 14, 5);
const one = d => E.review({ cards: {}, last: null }, 1, 3, new Date(2026, 10, d, 10)).cards;

test('settings start at their defaults and come back as saved', opts, async () => {
  await gone(); const db = await openDb();
  assert.deepEqual(await loadSettings(db), S());
  await saveSettings(db, S({ backupDays: 14, lastBackup: NOW.toISOString(), newPerDay: 20, retention: 0.95, startAt: 60 }));
  assert.deepEqual(await loadSettings(db), S({ backupDays: 14, lastBackup: NOW.toISOString(), newPerDay: 20, retention: 0.95, startAt: 60 }));
  db.close();
});

test('wipe test: the progress of a wiped phone comes back from the backup with every card and due time the same', opts, async () => {
  await gone(); let db = await openDb();
  const d = realDeck();
  for (let n = 1; n <= 5; n++) await saveDeck(db, { cards: Object.fromEntries(Object.entries(d.cards).filter(([k]) => +k <= n)), last: null });
  const before = await loadDeck(db); db.close();
  await gone(); db = await openDb();                            // the wipe
  assert.deepEqual(await loadDeck(db), { cards: {}, last: null });
  await replaceDeck(db, before.cards, 14, NOW);
  const after = await loadDeck(db);
  assert.deepEqual(after.cards, d.cards);                       // same state and same due time, card by card
  assert.equal(after.last, null);                               // undo information is not restored
  assert.deepEqual(await loadSettings(db), S({ backupDays: 14, lastBackup: NOW.toISOString() }));
  db.close();
});

test('restoring leaves the imported sentences alone, whichever came first', opts, async () => {
  await gone(); const db = await openDb();
  await savePack(db, [1, 2, 3].map(sentence));
  await replaceDeck(db, one(3), undefined, NOW);
  assert.deepEqual(await allNumbers(db), [1, 2, 3]);
  assert.equal(Object.keys((await loadDeck(db)).cards).length, 1);
  assert.equal((await loadSettings(db)).backupDays, 7);        // a backup with no settings keeps the phone's
  db.close();
});

test('a restore that would lose progress is refused inside storage and nothing changes', opts, async () => {
  await gone(); const db = await openDb();
  const mine = realDeck(); await seed(db, mine);
  await saveSettings(db, S({ backupDays: 3 }));
  const fewer = { 1: mine.cards[1] }, empty = {};
  const older = Object.fromEntries(Object.entries(mine.cards).map(([k, c]) => [k, { ...c, last_review: '2026-10-01T10:00:00.000Z' }]));
  for (const bad of [empty, fewer, older]) {
    await assert.rejects(replaceDeck(db, bad, 30, NOW), /Nothing was changed/);
    assert.deepEqual(await loadDeck(db), mine);
    assert.deepEqual(await loadSettings(db), S({ backupDays: 3 }));
  }
  db.close();
});

test('a restore with more cards and newer reviews replaces the deck in one step', opts, async () => {
  await gone(); const db = await openDb();
  await seed(db, { cards: one(1), last: { n: 1, prev: null } });
  const bigger = realDeck().cards;
  await replaceDeck(db, bigger, 30, NOW);
  assert.deepEqual(await loadDeck(db), { cards: bigger, last: null });
  db.close();
});

test('a restore never goes over progress that cannot be read', opts, async () => {
  await gone(); const db = await openDb();
  await new Promise(ok => { const tx = db.transaction('meta', 'readwrite'); tx.objectStore('meta').put('garbage', 'deck'); tx.oncomplete = ok; });
  await assert.rejects(replaceDeck(db, one(3), 7, NOW), /could not be read/);
  await assert.rejects(loadDeck(db), /could not be read/);      // still there, untouched
  db.close();
});

// ---- ticket 05: daily plan settings

test('settings that are missing, unreadable or out of range fall back to the defaults, one by one', opts, async () => {
  await gone(); const db = await openDb();
  const put = v => new Promise(ok => { const tx = db.transaction('meta', 'readwrite'); tx.objectStore('meta').put(v, 'settings'); tx.oncomplete = ok; });
  for (const bad of ['garbage', null, [], 5]) { await put(bad); assert.deepEqual(await loadSettings(db), S()); }
  await put({ backupDays: 14, newPerDay: 12, retention: 0.5, startAt: 0 });          // only the good one survives
  assert.deepEqual(await loadSettings(db), S({ backupDays: 14 }));
  await put({ backupDays: 7, newPerDay: 0, retention: 0.8, startAt: 3000 });          // 0 new a day is a real choice
  assert.deepEqual(await loadSettings(db), S({ newPerDay: 0, retention: 0.8, startAt: 3000 }));
  db.close();
});

test('settings from an older version of the app (no plan settings) load with the defaults', opts, async () => {
  await gone(); const db = await openDb();
  await saveSettings(db, { backupDays: 30, lastBackup: NOW.toISOString() });
  assert.deepEqual(await loadSettings(db), S({ backupDays: 30, lastBackup: NOW.toISOString() }));
  db.close();
});

test('a restore writes the backup\'s plan settings together with the cards; settings it does not have stay as they are', opts, async () => {
  await gone(); const db = await openDb();
  await saveSettings(db, S({ newPerDay: 5, retention: 0.8, startAt: 7 }));
  await replaceDeck(db, one(3), 14, NOW, { newPerDay: 20, retention: undefined, startAt: undefined });
  assert.deepEqual(await loadSettings(db), S({ backupDays: 14, lastBackup: NOW.toISOString(), newPerDay: 20, retention: 0.8, startAt: 7 }));
  await replaceDeck(db, realDeck().cards, 14, NOW, { startAt: null, retention: 0.95 });      // null means "never set": it is a value
  assert.deepEqual(await loadSettings(db), S({ backupDays: 14, lastBackup: NOW.toISOString(), newPerDay: 20, retention: 0.95, startAt: null }));
  db.close();
});

test('a refused restore changes none of the plan settings', opts, async () => {
  await gone(); const db = await openDb();
  const mine = realDeck(); await seed(db, mine);
  await saveSettings(db, S({ newPerDay: 5, startAt: 7 }));
  await assert.rejects(replaceDeck(db, { 1: mine.cards[1] }, 30, NOW, { newPerDay: 30, retention: 0.95, startAt: 99 }), /Nothing was changed/);
  assert.deepEqual(await loadSettings(db), S({ newPerDay: 5, startAt: 7 }));
  db.close();
});

test('today\'s record (introduced sentences, learn more) is saved with the grade and survives closing the app', opts, async () => {
  await gone(); let db = await openDb();
  const d = E.learnMore(E.review({ cards: {}, last: null }, 1, 3, NOW), NOW);
  await saveDeck(db, d); db.close();
  db = await openDb();
  const back = await loadDeck(db);
  assert.deepEqual(back, d);
  assert.deepEqual(back.today.intro, [1]); assert.equal(back.today.extra, 5);
  db.close();
});
