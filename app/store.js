// Storage on the phone (IndexedDB). Sentences and card progress live in separate stores,
// so importing sentences can never touch progress.
import { refusal, cleanSettings, DEFAULT_DAYS } from './backup.js';
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
