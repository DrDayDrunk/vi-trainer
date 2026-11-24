// Storage on the phone (IndexedDB). Sentences and card progress live in separate stores,
// so importing sentences can never touch progress.
import { refusal, cleanSettings, DEFAULT_DAYS } from './backup.js';
import { sameCard } from './sync.js';
const wrap = req => new Promise((ok, no) => { req.onsuccess = () => ok(req.result); req.onerror = () => no(req.error); });
const finished = tx => new Promise((ok, no) => { tx.oncomplete = ok; tx.onerror = tx.onabort = () => no(tx.error || new Error('Storage failed.')); });

export function openDb(idb = indexedDB) {
  const r = idb.open('vitrainer', 2);
  r.onupgradeneeded = e => {                       // each step only adds; nothing already saved is touched
    if (e.oldVersion < 1) r.result.createObjectStore('sentences', { keyPath: 'number' });
    if (e.oldVersion < 2) r.result.createObjectStore('meta');
  };
  return wrap(r);
}

// All 50 sentences go in one transaction: either all are saved or none are.
export async function savePack(db, sentences) {
  const tx = db.transaction('sentences', 'readwrite');
  sentences.forEach(s => tx.objectStore('sentences').put(s));
  await finished(tx);
}

export const getSentence = (db, n) => wrap(db.transaction('sentences').objectStore('sentences').get(n));
export const allNumbers = async db => (await wrap(db.transaction('sentences').objectStore('sentences').getAllKeys())).sort((a, b) => a - b);

// Progress. A phone that has none yet gets an empty deck; progress that exists but cannot be read is an error,
// so the app can stop instead of starting from empty and saving over it.
export async function loadDeck(db) {
  const d = await wrap(db.transaction('meta').objectStore('meta').get('deck'));
  if (d === undefined) return { cards: {}, last: null };
  if (!d || typeof d !== 'object' || !d.cards || typeof d.cards !== 'object' || Array.isArray(d.cards)) throw new Error('Your saved progress could not be read.');
  return d;
}

// Each grade or undo changes the number of cards by at most one. A save that changes it by more is refused.
export function saveDeck(db, deck) {
  return new Promise((ok, no) => {
    const tx = db.transaction('meta', 'readwrite'), store = tx.objectStore('meta'), old = store.get('deck');
    old.onsuccess = () => {
      const before = old.result && old.result.cards ? Object.keys(old.result.cards).length : 0;
      if (Math.abs(Object.keys(deck.cards).length - before) > 1) { tx.abort(); return no(new Error('Refused to save: it would lose progress.')); }
      store.put(deck, 'deck');
    };
    tx.oncomplete = ok;
    tx.onabort = tx.onerror = () => no(tx.error || new Error('Saving progress failed.'));
  });
}

// Settings (not progress). Anything missing or unreadable falls back to the defaults, one setting at a time.
export async function loadSettings(db) {
  return cleanSettings(await wrap(db.transaction('meta').objectStore('meta').get('settings')));
}
export async function saveSettings(db, settings) {
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put(settings, 'settings');
  await finished(tx);
}

// Restore a whole deck from a backup that has already been validated. The rules are checked again here, inside the
// same transaction that writes, against what is really stored: an empty, smaller or older backup is refused, and
// progress that cannot be read is never replaced. Cards and settings are written together or not at all.
// `more` holds the backup's other settings (daily limit, retention, start sentence); the ones it does not have stay as they are.
export function replaceDeck(db, cards, backupDays, now, more = {}) {
  return new Promise((ok, no) => {
    const tx = db.transaction('meta', 'readwrite'), store = tx.objectStore('meta'), d = store.get('deck'), s = store.get('settings');
    const stop = e => { tx.abort(); no(e); };
    tx.oncomplete = ok;
    tx.onabort = tx.onerror = () => no(tx.error || new Error('Restoring failed. Nothing was changed.'));
    s.onsuccess = () => {      // requests finish in order, so the deck has been read by now
      let why = null;
      if (d.result !== undefined && (!d.result || typeof d.result !== 'object' || !d.result.cards || typeof d.result.cards !== 'object' || Array.isArray(d.result.cards)))
        why = 'Your saved progress could not be read, so it was not replaced. Nothing was changed.';
      else why = refusal(d.result ? d.result.cards : {}, cards);
      if (why) return stop(new Error(why));
      const old = s.result && typeof s.result === 'object' ? s.result : {};
      store.put({ cards, last: null }, 'deck');
      const have = Object.fromEntries(Object.entries(more).filter(([, v]) => v !== undefined));
      store.put({ ...old, backupDays: backupDays || old.backupDays || DEFAULT_DAYS, lastBackup: now.toISOString(), ...have }, 'settings');
    };
  });
}

// ---- vault sync (ticket 10)

const readable = d => d === undefined || (d && typeof d === 'object' && d.cards && typeof d.cards === 'object' && !Array.isArray(d.cards));
const SYNCED = ['backupDays', 'newPerDay', 'retention', 'startAt'];
const retry = () => Object.assign(new Error('The progress on this phone changed while syncing. Nothing was changed.'), { retry: true });

// Write the result of a sync merge ({ cards, settings, settingsAt }). The rules are checked again here, inside the same
// transaction that writes, against what is really stored: every card on the phone must still be in the merged cards and
// no older than the phone's copy. If not (for example a grade was saved while the sync was running) nothing is written
// and the error has retry = true. Today's record, the backup date and everything else stored is left alone.
// Resolves with how many cards were added or changed.
export function mergeInto(db, merged, now) {
  return new Promise((ok, no) => {
    const tx = db.transaction('meta', 'readwrite'), store = tx.objectStore('meta'), d = store.get('deck'), s = store.get('settings');
    let changed = 0;
    const stop = e => { tx.abort(); no(e); };
    tx.oncomplete = () => ok(changed);
    tx.onabort = tx.onerror = () => no(tx.error || new Error('Sync could not save. Nothing was changed.'));
    s.onsuccess = () => {
      const old = d.result;
      if (!readable(old)) return stop(new Error('Your saved progress could not be read, so sync did not replace it. Nothing was changed.'));
      const have = old ? old.cards : {};
      for (const [n, c] of Object.entries(have)) {
        const m = merged.cards[n];
        if (!m || !(Date.parse(m.last_review) >= Date.parse(c.last_review))) return stop(retry());
      }
      changed = Object.keys(merged.cards).filter(n => !have[n] || !sameCard(have[n], merged.cards[n])).length;
      const n = old && old.last && old.last.n;
      const keepUndo = n && have[n] && merged.cards[n] && sameCard(have[n], merged.cards[n]);
      store.put({ ...(old || {}), cards: merged.cards, last: keepUndo ? old.last : null }, 'deck');
      const o = s.result && typeof s.result === 'object' ? s.result : {};
      store.put(cleanSettings({ ...o, ...Object.fromEntries(SYNCED.map(k => [k, merged.settings[k]])), settingsAt: merged.settingsAt }), 'settings');
    };
  });
}

// Put an earlier version of the progress on this phone, on purpose. This is the one write that may go back in time, so
// it is only used after the person has confirmed it, and only after the current progress has been saved to the vault.
// It still refuses an empty set of cards and progress that cannot be read. Today's record is kept; undo is dropped.
export function restoreDeck(db, cards, settings, settingsAt) {
  return new Promise((ok, no) => {
    const tx = db.transaction('meta', 'readwrite'), store = tx.objectStore('meta'), d = store.get('deck'), s = store.get('settings');
    const stop = e => { tx.abort(); no(e); };
    tx.oncomplete = ok;
    tx.onabort = tx.onerror = () => no(tx.error || new Error('Restoring failed. Nothing was changed.'));
    s.onsuccess = () => {
      if (!Object.keys(cards).length) return stop(new Error('That version has no cards, so it was not restored. Nothing was changed.'));
      if (!readable(d.result)) return stop(new Error('Your saved progress could not be read, so it was not replaced. Nothing was changed.'));
      store.put({ ...(d.result || {}), cards, last: null }, 'deck');
      const o = s.result && typeof s.result === 'object' ? s.result : {};
      store.put(cleanSettings({ ...o, ...Object.fromEntries(SYNCED.map(k => [k, settings[k]])), settingsAt }), 'settings');
    };
  });
}

// The vault token lives only here, on this phone. It is in no backup and no progress file.
export async function loadToken(db) {
  const v = await wrap(db.transaction('meta').objectStore('meta').get('vault'));
  return v && typeof v.token === 'string' && v.token ? v.token : null;
}
export async function saveToken(db, token) {
  const tx = db.transaction('meta', 'readwrite');
  if (token) tx.objectStore('meta').put({ token }, 'vault'); else tx.objectStore('meta').delete('vault');
  await finished(tx);
}

// When this phone last synced, and the vault revision it saw then. Shown on screen only.
export const loadSync = async db => (await wrap(db.transaction('meta').objectStore('meta').get('sync'))) || null;
export async function saveSync(db, info) {
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put(info, 'sync');
  await finished(tx);
}
