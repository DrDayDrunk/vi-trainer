// Sync, pack download and restore: ties the vault client, the merge rules and the phone's storage together.
// Nothing here is shown on a screen. Every refusal leaves the phone and the vault as they were.
import { merge, makeProgress, readProgress } from './sync.js';
import { validatePack } from './pack.js';
import { DEFAULTS, newest } from './backup.js';
import { loadDeck, loadSettings, mergeInto, restoreDeck, saveSync, savePack } from './store.js';
import { VaultError } from './vault.js';

const KEYS = ['backupDays', 'newPerDay', 'retention', 'startAt'];       // the settings that travel with the progress
const pick = s => Object.fromEntries(KEYS.map(k => [k, s[k]]));

// A settings edit is stamped with its time, so the latest edit wins on every device.
export const edited = (s, patch, now) => ({ ...s, ...patch, settingsAt: now.toISOString() });
// Settings changed before sync existed have no time yet: stamp them once, so a second device does not have to ask.
export const stamp = (s, now) => s.settingsAt || KEYS.every(k => s[k] === DEFAULTS[k]) ? s : { ...s, settingsAt: now.toISOString() };

// Merge the phone with the vault. Returns { ahead, pushed, pulled, changed, revision }, or { ask } when the rules cannot
// decide (nothing is changed then; call again with prefer = 'phone' or 'vault'). A phone with no cards only pulls.
export async function syncNow(db, vault, now, prefer = null, tries = 2) {
  const deck = await loadDeck(db), s = await loadSettings(db);
  const mine = { cards: deck.cards, settings: pick(s), settingsAt: s.settingsAt, revision: 0 };
  const remote = await vault.readProgress();                              // null: the vault has no progress yet
  const theirs = remote ? readProgress(remote.text) : { cards: {}, settings: mine.settings, settingsAt: null, revision: 0 };   // a file that is not valid progress stops here
  const r = merge(mine, theirs, prefer);
  if (r.ask) return { ask: r.ask };
  let changed = 0;
  try { if (r.pull) changed = await mergeInto(db, r, now); }
  catch (e) { if (e.retry && tries > 1) return syncNow(db, vault, now, prefer, tries - 1); throw e; }      // the phone changed while we were talking
  if (r.push) {
    try { await vault.writeProgress(JSON.stringify(makeProgress(r, now)), remote && remote.sha); }
    catch (e) { if (e.kind === 'conflict' && tries > 1) return syncNow(db, vault, now, prefer, tries - 1); throw e; }   // the vault changed while we were talking
  }
  await saveSync(db, { lastSync: now.toISOString(), revision: r.revision });
  return { ahead: r.ahead, pushed: r.push, pulled: r.pull, changed, revision: r.revision };
}

// Download, check and store the listed bundles one at a time. A bad bundle is named and skipped. If the vault itself stops
// answering (sign-in, connection, limits) the rest are listed as not downloaded. Progress is never touched.
export async function downloadPacks(db, vault, files, onProgress = () => {}) {
  const done = [], failed = [];
  let stopped = null;
  for (const [i, f] of files.entries()) {
    if (stopped) { failed.push({ name: f.name, why: 'Not downloaded.' }); continue; }
    onProgress(i + 1, files.length, f.name);
    try {
      let json;
      const text = await vault.readPack(f.name);
      try { json = JSON.parse(text); } catch { throw new Error('This file could not be read. Nothing was changed.'); }
      if (json && (json.level !== f.level || json.track !== f.track)) throw new Error('Its contents do not match its name. Nothing was changed.');
      await savePack(db, validatePack(json));
      done.push(f.name);
    } catch (e) {
      if (e instanceof VaultError && e.kind !== 'missing' && e.kind !== 'conflict') stopped = e;
      failed.push({ name: f.name, why: e.message });
    }
  }
  return { done, failed, stopped };
}

export const versions = vault => vault.history();

export async function previewVersion(vault, sha) {
  const p = readProgress(await vault.readProgressAt(sha));
  return { count: Object.keys(p.cards).length, revision: p.revision, newest: newest(p.cards) };
}

// Put an earlier version of the progress on this phone and in the vault. The current progress is saved to the vault first,
// so it stays in the history and the restore can itself be undone. The vault is written before the phone: if anything
// fails before the phone is changed, nothing is lost.
export async function restoreVersion(db, vault, sha, now) {
  const r = await syncNow(db, vault, now);
  if (r.ask) throw new Error('Sync needs your decision first, so nothing was restored. Tap Sync, choose, then restore. Nothing was changed.');
  const old = readProgress(await vault.readProgressAt(sha));
  const cur = await vault.readProgress();
  const revision = (cur ? readProgress(cur.text).revision : 0) + 1;
  await vault.writeProgress(JSON.stringify(makeProgress({ cards: old.cards, settings: old.settings, settingsAt: now.toISOString(), revision }, now)), cur && cur.sha);
  await restoreDeck(db, old.cards, old.settings, now.toISOString());
  await saveSync(db, { lastSync: now.toISOString(), revision });
  return { count: Object.keys(old.cards).length, revision };
}
