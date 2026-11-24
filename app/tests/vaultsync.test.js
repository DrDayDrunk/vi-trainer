// Sync, pack download and restore, end to end: the real storage code (in memory) against a fake GitHub.
// Needs the test-only helper fake-indexeddb (npm install). Skipped, not failed, when it is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';

let ready = true;
try { await import('fake-indexeddb/auto'); } catch { ready = false; }
const { openDb, loadDeck, saveDeck, loadSettings, saveSettings, loadSync, allNumbers, getSentence } = await import('../store.js');
const { syncNow, downloadPacks, versions, previewVersion, restoreVersion, edited, stamp } = await import('../vaultsync.js');
const { createVault, PROGRESS } = await import('../vault.js');
const { makeProgress, readProgress } = await import('../sync.js');
const { fakeGitHub, TOKEN } = await import('./fakegithub.js');
const { realDeck, E } = await import('./helpers.js');
const opts = { skip: !ready && 'fake-indexeddb not installed' };

const NOW = new Date(Date.UTC(2026, 10, 12, 9));
const S = o => ({ backupDays: 7, lastBackup: null, newPerDay: 10, retention: 0.9, startAt: null, settingsAt: null, ...o });
const SYNCED = s => ({ backupDays: s.backupDays, newPerDay: s.newPerDay, retention: s.retention, startAt: s.startAt });
const gone = () => new Promise(ok => { const r = indexedDB.deleteDatabase('vitrainer'); r.onsuccess = r.onerror = r.onblocked = ok; });
const put = (db, key, v) => new Promise(ok => { const tx = db.transaction('meta', 'readwrite'); tx.objectStore('meta').put(v, key); tx.oncomplete = ok; });
const vaultOf = g => createVault(TOKEN, g.fetch, { timeout: 300 });
const at = (d, h = 10) => new Date(Date.UTC(2026, 10, d, h));

// A phone: a fresh database holding the given deck and settings (null = nothing yet, like a wiped phone).
async function phone(deck, settings) {
  await gone(); const db = await openDb();
  if (deck) await put(db, 'deck', deck);
  if (settings) await saveSettings(db, settings);
  return db;
}
const grade = async (db, n, g, when) => { const d = E.review(await loadDeck(db), n, g, when); await saveDeck(db, d); return d; };
const vaultFile = g => readProgress(g.files[PROGRESS].text);
const text = (cards, o = {}) => JSON.stringify(makeProgress({ cards, settings: SYNCED(S()), settingsAt: null, revision: 1, ...o }, NOW));

test('the first sync of a phone with progress creates the vault file and changes nothing on the phone', opts, async () => {
  const g = fakeGitHub(), db = await phone(realDeck(), S());
  const before = await loadDeck(db);
  const r = await syncNow(db, vaultOf(g), NOW);
  assert.deepEqual([r.ahead, r.pushed, r.pulled, r.revision], ['phone', true, false, 1]);
  assert.deepEqual(await loadDeck(db), before);
  const v = vaultFile(g);
  assert.deepEqual(v.cards, before.cards); assert.equal(v.revision, 1);
  assert.deepEqual(await loadSync(db), { lastSync: NOW.toISOString(), revision: 1 });
  assert.ok(!g.files[PROGRESS].text.includes(TOKEN));
  db.close();
});

test('syncing again with nothing new writes nothing', opts, async () => {
  const g = fakeGitHub(), db = await phone(realDeck(), S());
  await syncNow(db, vaultOf(g), NOW);
  const n = g.writes().length;
  const r = await syncNow(db, vaultOf(g), NOW);
  assert.deepEqual([r.ahead, r.pushed, r.pulled, r.revision], ['same', false, false, 1]);
  assert.equal(g.writes().length, n);
  db.close();
});

test('an empty phone and an empty vault have nothing to sync', opts, async () => {
  const g = fakeGitHub(), db = await phone(null, null);
  const r = await syncNow(db, vaultOf(g), NOW);
  assert.equal(r.ahead, 'same'); assert.equal(g.writes().length, 0);
  assert.deepEqual(await loadDeck(db), { cards: {}, last: null });
  db.close();
});

test('wipe test: a wiped phone syncs and every card has the same state and due time as before', opts, async () => {
  const g = fakeGitHub(), mine = realDeck();
  let db = await phone(mine, S({ newPerDay: 15, settingsAt: NOW.toISOString() }));
  await syncNow(db, vaultOf(g), NOW); db.close();
  db = await phone(null, null);                                 // the wipe
  const writes = g.writes().length;
  const r = await syncNow(db, vaultOf(g), NOW);
  assert.deepEqual([r.ahead, r.pulled, r.pushed], ['vault', true, false]);
  assert.deepEqual((await loadDeck(db)).cards, mine.cards);
  assert.deepEqual(await loadSettings(db), S({ newPerDay: 15, settingsAt: NOW.toISOString() }));
  assert.equal(g.writes().length, writes);                       // an empty phone never writes to the vault
  db.close();
});

test('two devices: each keeps its own new reviews and the later review of a shared card wins', opts, async () => {
  const g = fakeGitHub(), v = vaultOf(g), start = realDeck();
  let db = await phone(start, S()); await syncNow(db, v, at(5)); db.close();                    // device A starts the vault
  db = await phone(null, null); await syncNow(db, v, at(6));                                      // device B joins
  const b = await grade(db, 2, 3, at(7)); await grade(db, 8, 3, at(7, 11));                       // B reviews card 2 and a new card 8
  await syncNow(db, v, at(7, 12)); db.close();
  db = await phone(start, S()); await grade(db, 9, 3, at(8));                                      // A (older copy) reviews a new card 9
  const r = await syncNow(db, v, at(8, 12));
  assert.equal(r.ahead, 'both');
  const a = await loadDeck(db);
  assert.deepEqual(a.cards[2], b.cards[2]);                                                        // B's later review of card 2 arrived
  assert.ok(a.cards[8] && a.cards[9]);                                                             // and both new cards are kept
  assert.deepEqual(vaultFile(g).cards, a.cards);                                                   // the vault holds the same
  assert.equal(vaultFile(g).revision, 3);
  db.close();
});

test('a phone with older copies of the vault\'s cards pulls and never writes', opts, async () => {
  const g = fakeGitHub(), mine = realDeck();
  g.put(PROGRESS, text(Object.fromEntries(Object.entries(mine.cards).map(([k, c]) => [k, { ...c, last_review: '2026-11-09T10:00:00.000Z', reps: c.reps + 1 }])), { revision: 6 }));
  const db = await phone(mine, S());
  const r = await syncNow(db, vaultOf(g), NOW);
  assert.deepEqual([r.ahead, r.revision, g.writes().length], ['vault', 6, 0]);
  assert.equal((await loadDeck(db)).cards[1].last_review, '2026-11-09T10:00:00.000Z');
  db.close();
});

test('a vault file that is not valid progress is refused and nothing changes anywhere', opts, async () => {
  const mine = realDeck(), good = JSON.parse(text(mine.cards));
  for (const bad of ['garbage', '', '{}', JSON.stringify({ ...good, cards: {}, card_count: 0 }), JSON.stringify({ ...good, revision: undefined }),
    JSON.stringify({ ...good, card_count: 99 }), JSON.stringify({ ...good, version: 9 })]) {
    const g = fakeGitHub(); g.put(PROGRESS, bad);
    const db = await phone(mine, S()), before = await loadDeck(db), n = g.writes().length;
    await assert.rejects(syncNow(db, vaultOf(g), NOW), e => /not usable|not a progress file|Nothing was changed/.test(e.message));
    assert.deepEqual(await loadDeck(db), before); assert.equal(g.writes().length, n); assert.equal(g.files[PROGRESS].text, bad);
    db.close();
  }
});

test('when the rules cannot decide it asks and changes nothing; answering applies the answer', opts, async () => {
  const mine = realDeck(), theirs = { ...mine.cards, 3: { ...mine.cards[3], stability: 99 } };
  const g = fakeGitHub(); g.put(PROGRESS, text(theirs, { revision: 4 }));
  let db = await phone(mine, S());
  const r = await syncNow(db, vaultOf(g), NOW);
  assert.equal(r.ask.length, 1); assert.equal(r.ask[0].number, 3);
  assert.deepEqual(await loadDeck(db), mine); assert.equal(g.writes().length, 0);
  const keepVault = await syncNow(db, vaultOf(g), NOW, 'vault');
  assert.equal((await loadDeck(db)).cards[3].stability, 99); assert.equal(keepVault.pushed, false); assert.equal(g.writes().length, 0);
  db.close();
  db = await phone(mine, S());
  const keepPhone = await syncNow(db, vaultOf(g), NOW, 'phone');
  assert.equal(keepPhone.pushed, true); assert.equal(keepPhone.revision, 5);
  assert.equal(vaultFile(g).cards[3].stability, mine.cards[3].stability);
  db.close();
});

test('if the vault changes while syncing, it reads again and merges again', opts, async () => {
  const g = fakeGitHub(), mine = realDeck(), other = { ...mine.cards, 6: E.review({ cards: {}, last: null }, 6, 3, at(9)).cards[6] };
  g.put(PROGRESS, text(mine.cards, { revision: 2 }));
  const db = await phone({ ...mine, cards: { ...mine.cards, 7: E.review({ cards: {}, last: null }, 7, 3, at(9)).cards[7] } }, S());
  let done = false;
  g.before = async (m, p) => { if (m === 'PUT' && !done) { done = true; g.put(PROGRESS, text(other, { revision: 3 })); } };   // another device pushes first
  const r = await syncNow(db, vaultOf(g), NOW);
  assert.equal(r.pushed, true);
  const v = vaultFile(g), d = await loadDeck(db);
  assert.deepEqual(Object.keys(v.cards).sort(), ['1', '2', '3', '4', '5', '6', '7']); assert.deepEqual(v.cards, d.cards);
  db.close();
});

test('a vault that keeps changing is reported, the phone keeps everything, and nothing is lost', opts, async () => {
  const g = fakeGitHub(), mine = realDeck(); g.put(PROGRESS, text(mine.cards, { revision: 2 }));
  const db = await phone({ ...mine, cards: { ...mine.cards, 7: E.review({ cards: {}, last: null }, 7, 3, at(9)).cards[7] } }, S());
  let n = 0;
  g.before = async (m) => { if (m === 'PUT') g.put(PROGRESS, text(mine.cards, { revision: 3 + ++n })); };
  await assert.rejects(syncNow(db, vaultOf(g), NOW), e => e.kind === 'conflict');
  assert.ok((await loadDeck(db)).cards[7]);
  db.close();
});

test('a grade saved while the sync is running is not lost', opts, async () => {
  const g = fakeGitHub(), mine = realDeck(), extra = E.review({ cards: {}, last: null }, 6, 3, at(9)).cards;
  g.put(PROGRESS, text({ ...mine.cards, ...extra }, { revision: 2 }));        // the vault has card 6, so the phone must pull
  const db = await phone(mine, S());
  let once = false;
  g.before = async (m, p) => { if (m === 'GET' && p.endsWith(PROGRESS) && !once) { once = true; await saveDeck(db, E.review(await loadDeck(db), 2, 3, at(11))); } };
  const r = await syncNow(db, vaultOf(g), NOW);
  const d = await loadDeck(db), v = vaultFile(g);
  assert.ok(d.cards[6]);
  assert.equal(d.cards[2].last_review, at(11).toISOString());                  // the grade made during the sync is still there
  assert.deepEqual(v.cards, d.cards);                                          // and it reached the vault
  db.close();
});

test('no connection: a plain error, and the phone is exactly as it was', opts, async () => {
  const g = fakeGitHub(); g.offline = true;
  const db = await phone(realDeck(), S()), before = await loadDeck(db);
  await assert.rejects(syncNow(db, vaultOf(g), NOW), e => e.kind === 'network');
  assert.deepEqual(await loadDeck(db), before); assert.equal(await loadSync(db), null);
  db.close();
});

test('settings: the later edit wins on either device, and a wiped phone takes the vault\'s', opts, async () => {
  const g = fakeGitHub(), v = vaultOf(g), cards = realDeck();
  let db = await phone(cards, S({ newPerDay: 20, settingsAt: at(5).toISOString() })); await syncNow(db, v, at(5)); db.close();
  db = await phone(cards, S({ newPerDay: 5, settingsAt: at(6).toISOString() }));                // edited later on the other device
  await syncNow(db, v, at(6, 12));
  assert.equal((await loadSettings(db)).newPerDay, 5); assert.equal(vaultFile(g).settings.newPerDay, 5); db.close();
  db = await phone(cards, S({ newPerDay: 30, settingsAt: at(4).toISOString() }));               // edited earlier: the vault's wins
  await syncNow(db, v, at(7));
  assert.equal((await loadSettings(db)).newPerDay, 5); db.close();
});

test('settings edits are stamped, and old unstamped non-default settings are stamped once', () => {
  const e = edited(S(), { newPerDay: 20 }, NOW);
  assert.equal(e.newPerDay, 20); assert.equal(e.settingsAt, NOW.toISOString());
  assert.deepEqual(stamp(S(), NOW), S());                                              // defaults stay unstamped
  assert.equal(stamp(S({ retention: 0.95 }), NOW).settingsAt, NOW.toISOString());
  assert.equal(stamp(S({ retention: 0.95, settingsAt: at(3).toISOString() }), NOW).settingsAt, at(3).toISOString());
  assert.deepEqual(stamp(S({ lastBackup: 'x' }), NOW), S({ lastBackup: 'x' }));          // only the synced settings count
});

// ---- downloading the pack

const AUDIO = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), Buffer.alloc(400, 7)]).toString('base64');
const bundle = (level, track) => {
  const base = (level - 1) * 1000 + (track - 1) * 50;
  return JSON.stringify({ format: 'vi-trainer-bundle', version: 1, level, track, count: 50, audio_type: 'audio/mp4',
    sentences: Array.from({ length: 50 }, (_, i) => ({ number: base + i + 1, level, track, en_text: 'English ' + (i + 1), vi_text: 'Hôm nay trời đẹp ' + (i + 1), en_audio: AUDIO, vi_audio: AUDIO })) });
};
const pack = (g, ...pairs) => pairs.forEach(([l, t]) => g.put('pack/level' + l + '-track' + String(t).padStart(2, '0') + '.json', bundle(l, t)));

test('downloaded bundles are checked and stored, progress is untouched, and progress is reported', opts, async () => {
  const g = fakeGitHub(); pack(g, [1, 1], [1, 2], [2, 1]);
  const mine = realDeck(), db = await phone(mine, S()), v = vaultOf(g), seen = [];
  const r = await downloadPacks(db, v, await v.listPack(), (i, n, name) => seen.push([i, n, name]));
  assert.deepEqual(r.done, ['level1-track01.json', 'level1-track02.json', 'level2-track01.json']); assert.deepEqual(r.failed, []);
  assert.deepEqual(seen.map(s => s[0]), [1, 2, 3]); assert.equal(seen[0][1], 3);
  assert.equal((await allNumbers(db)).length, 150); assert.equal((await getSentence(db, 1001)).vi_text, 'Hôm nay trời đẹp 1');
  assert.deepEqual(await loadDeck(db), mine);
  db.close();
});

test('a bad bundle is named and skipped; the good ones are still stored', opts, async () => {
  const g = fakeGitHub(); pack(g, [1, 1], [1, 3]);
  g.put('pack/level1-track02.json', JSON.stringify({ ...JSON.parse(bundle(1, 2)), count: 49 }));
  g.put('pack/level1-track04.json', bundle(1, 3));                                      // a file holding another track's sentences
  g.put('pack/level1-track05.json', 'not json');
  const db = await phone(null, null), v = vaultOf(g);
  const r = await downloadPacks(db, v, await v.listPack(), () => {});
  assert.deepEqual(r.done, ['level1-track01.json', 'level1-track03.json']);
  assert.deepEqual(r.failed.map(f => f.name), ['level1-track02.json', 'level1-track04.json', 'level1-track05.json']);
  assert.ok(r.failed.every(f => /Nothing was changed|does not match|could not be read/.test(f.why)));
  assert.equal((await allNumbers(db)).length, 100);
  db.close();
});

test('a refused token stops the download and lists what was not downloaded', opts, async () => {
  const g = fakeGitHub(); pack(g, [1, 1], [1, 2], [1, 3]);
  const db = await phone(null, null), v = vaultOf(g), files = await v.listPack();
  g.before = async () => { if (g.requests.filter(r => r.path.includes('/contents/pack/')).length >= 2) g.status = 401; };
  const r = await downloadPacks(db, v, files, () => {});
  assert.deepEqual(r.done, ['level1-track01.json']);
  assert.equal(r.stopped.kind, 'auth');
  assert.deepEqual(r.failed.map(f => f.name), ['level1-track02.json', 'level1-track03.json']);
  assert.equal((await allNumbers(db)).length, 50);
  db.close();
});

// ---- earlier versions

async function history3(g, v, db) {
  await syncNow(db, v, at(5));
  await grade(db, 9, 3, at(6)); await syncNow(db, v, at(6, 12));
  await grade(db, 10, 3, at(7)); await syncNow(db, v, at(7, 12));
}

test('earlier versions are listed with their date and can be previewed', opts, async () => {
  const g = fakeGitHub(), v = vaultOf(g), db = await phone(realDeck(), S());
  await history3(g, v, db);
  const list = await versions(v);
  assert.equal(list.length, 3);
  const p = await previewVersion(v, list[2].sha);
  assert.deepEqual([p.count, p.revision], [5, 1]);
  assert.equal((await previewVersion(v, list[0].sha)).count, 7);
  db.close();
});

test('restoring an earlier version: the phone and the vault both go back, and what was there is still in the history', opts, async () => {
  const g = fakeGitHub(), v = vaultOf(g), db = await phone(realDeck(), S());
  await history3(g, v, db);
  const oldest = (await versions(v))[2];
  await grade(db, 11, 3, at(8));                                        // a review not yet in the vault
  const r = await restoreVersion(db, v, oldest.sha, at(8, 12));
  const d = await loadDeck(db), f = vaultFile(g);
  assert.deepEqual(Object.keys(d.cards).sort((a, b) => a - b), ['1', '2', '3', '4', '5']);
  assert.deepEqual(f.cards, d.cards); assert.equal(f.revision, r.revision); assert.equal(r.revision, 5);
  const all = await Promise.all((await versions(v)).map(x => previewVersion(v, x.sha)));
  assert.ok(all.some(p => p.count === 8), 'the newest state, with the unsynced review, is still in the history');
  const again = await syncNow(db, v, at(9));                            // nothing is undone by the next sync
  assert.deepEqual([again.ahead, Object.keys((await loadDeck(db)).cards).length], ['same', 5]);
  db.close();
});

test('a restore that cannot save the current state first changes nothing', opts, async () => {
  const g = fakeGitHub(), v = vaultOf(g), mine = realDeck(), db = await phone(mine, S());
  await history3(g, v, db);
  const oldest = (await versions(v))[2], before = await loadDeck(db), vaultBefore = g.files[PROGRESS].text;
  g.offline = true;
  await assert.rejects(restoreVersion(db, v, oldest.sha, NOW), e => e.kind === 'network');
  assert.deepEqual(await loadDeck(db), before);
  g.offline = false;
  g.put(PROGRESS, text({ ...before.cards, 3: { ...before.cards[3], stability: 99 } }, { revision: 9 }));   // a question the rules cannot answer
  await assert.rejects(restoreVersion(db, v, oldest.sha, NOW), /decide|Sync/);
  assert.deepEqual(await loadDeck(db), before);
  db.close();
});

test('if the vault cannot be written during a restore, the phone is not changed either', opts, async () => {
  const g = fakeGitHub(), v = vaultOf(g), db = await phone(realDeck(), S());
  await history3(g, v, db);
  const oldest = (await versions(v))[2], before = await loadDeck(db), vaultBefore = g.files[PROGRESS].text;
  g.before = async m => { if (m === 'PUT') g.status = 503; };
  await assert.rejects(restoreVersion(db, v, oldest.sha, NOW), e => e.kind === 'server');
  assert.deepEqual(await loadDeck(db), before); assert.equal(g.files[PROGRESS].text, vaultBefore);
  db.close();
});

test('a restore of a damaged earlier version is refused and nothing changes', opts, async () => {
  const g = fakeGitHub(), v = vaultOf(g), db = await phone(realDeck(), S());
  await history3(g, v, db);
  const current = g.files[PROGRESS].text;
  g.put(PROGRESS, 'garbage'); const bad = (await versions(v))[0]; g.put(PROGRESS, current);   // an old commit that is not valid progress, with a good current file
  const before = await loadDeck(db);
  await assert.rejects(restoreVersion(db, v, bad.sha, NOW), /not usable|Nothing was changed/);
  assert.deepEqual(await loadDeck(db), before);
  db.close();
});
