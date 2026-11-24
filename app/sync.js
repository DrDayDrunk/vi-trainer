// Sync merge: pure logic, no screen, no storage, no network. Given the phone's progress and the vault's progress it returns
// the merged progress and which side needs updating, or a question when the rules cannot decide. Every refusal ends with "Nothing was changed."
// Progress = { cards, settings: { backupDays, newPerDay, retention, startAt }, settingsAt (ISO time of the last settings edit, or null), revision }.
import { readBackup, makeBackup, isDate, DEFAULTS } from './backup.js';

const CARD = ['due', 'stability', 'difficulty', 'elapsed_days', 'scheduled_days', 'reps', 'lapses', 'learning_steps', 'state', 'last_review'];
const SET = ['backupDays', 'newPerDay', 'retention', 'startAt'];
export const sameCard = (a, b) => CARD.every(k => a[k] === b[k]);
const sameCards = (a, b) => { const k = Object.keys(a); return k.length === Object.keys(b).length && k.every(n => b[n] && sameCard(a[n], b[n])); };
const sameSettings = (a, b) => SET.every(k => a[k] === b[k]);
const stamp = s => s === null ? -Infinity : Date.parse(s);
const time = c => Date.parse(c.last_review);

// `prefer` ('phone' or 'vault') answers the questions of an earlier call that returned { ask }.
export function merge(phone, vault, prefer = null) {
  let cards, settings, settingsAt;
  if (!Object.keys(phone.cards).length) {          // a phone with no progress only ever pulls
    ({ cards, settings, settingsAt } = vault);
  } else {
    const ask = [];
    cards = {};
    for (const n of new Set([...Object.keys(phone.cards), ...Object.keys(vault.cards)])) {
      const p = phone.cards[n], v = vault.cards[n];
      if (!p || !v) cards[n] = p || v;
      else if (time(p) !== time(v)) cards[n] = time(p) > time(v) ? p : v;       // the later review wins
      else if (sameCard(p, v)) cards[n] = v;
      else if (prefer) cards[n] = prefer === 'phone' ? p : v;
      else ask.push({ kind: 'card', number: +n, phone: p, vault: v });
    }
    if (stamp(phone.settingsAt) !== stamp(vault.settingsAt)) ({ settings, settingsAt } = stamp(phone.settingsAt) > stamp(vault.settingsAt) ? phone : vault);   // the later edit wins
    else if (sameSettings(phone.settings, vault.settings)) ({ settings, settingsAt } = vault);
    else if (prefer) ({ settings, settingsAt } = prefer === 'phone' ? phone : vault);
    else ask.push({ kind: 'settings', phone: phone.settings, vault: vault.settings });
    if (ask.length) return { ask: ask.sort((a, b) => (a.number || 0) - (b.number || 0)) };
  }
  for (const side of [phone, vault]) for (const [n, c] of Object.entries(side.cards))       // last line of defence: never lose a card or go back in time
    if (!cards[n] || time(cards[n]) < time(c)) throw new Error('Sync refused: it would lose progress. Nothing was changed.');
  const push = !sameCards(cards, vault.cards) || !sameSettings(settings, vault.settings);
  const pull = !sameCards(cards, phone.cards) || !sameSettings(settings, phone.settings);
  return { ahead: push && pull ? 'both' : push ? 'phone' : pull ? 'vault' : 'same', push, pull, cards, settings, settingsAt, revision: push ? vault.revision + 1 : vault.revision };
}

// The progress file is the backup file (so it still works as a backup) plus a revision, the time it was written and the time settings last changed.
export function makeProgress(p, now) {
  const { backupDays, ...more } = p.settings;
  return { ...makeBackup({ cards: p.cards }, backupDays, now, more), revision: p.revision, changed_at: now.toISOString(), settings_at: p.settingsAt };
}

export function readProgress(text) {
  let b;
  try { b = readBackup(text); } catch (e) { throw new Error('The progress file is not usable. ' + e.message); }
  const o = JSON.parse(text);
  if (!Number.isInteger(o.revision) || o.revision < 0 || !isDate(o.changed_at) || !(o.settings_at === null || isDate(o.settings_at)))
    throw new Error('This is not a progress file: its revision or dates are missing or damaged. Nothing was changed.');
  const { cards, exported_at, ...got } = b;
  return { cards, settings: { ...DEFAULTS, ...got }, settingsAt: o.settings_at, revision: o.revision };
}
