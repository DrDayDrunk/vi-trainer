// Storage on the phone (IndexedDB). Sentences live here; card progress will get its own store later,
// so importing sentences can never touch progress.
const wrap = req => new Promise((ok, no) => { req.onsuccess = () => ok(req.result); req.onerror = () => no(req.error); });
const finished = tx => new Promise((ok, no) => { tx.oncomplete = ok; tx.onerror = tx.onabort = () => no(tx.error || new Error('Storage failed.')); });

export function openDb(idb = indexedDB) {
  const r = idb.open('vitrainer', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('sentences', { keyPath: 'number' });
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
