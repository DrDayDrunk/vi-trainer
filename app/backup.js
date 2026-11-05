// Backup file: card schedules and settings only. No sentence text or audio, so it is safe to keep in iCloud Drive.
// Pure logic: no screen, no storage. Every refusal ends with "Nothing was changed."
export const FORMAT = 'vi-trainer-backup';
export const VERSION = 1;
export const REMIND_CHOICES = [3, 7, 14, 30];
export const DEFAULT_DAYS = 7;

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const isDate = v => typeof v === 'string' && ISO.test(v) && !isNaN(Date.parse(v));
const isNum = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isInt = v => Number.isInteger(v) && v >= 0;
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const no = why => { throw new Error(why + ' Nothing was changed.'); };

export const makeBackup = (deck, backupDays, now) => ({
  format: FORMAT, version: VERSION, exported_at: now.toISOString(),
  card_count: Object.keys(deck.cards).length, settings: { backupDays }, cards: deck.cards,
});

const pad = n => String(n).padStart(2, '0');
export const backupName = d => 'vi-trainer-backup-' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '.json';

// A deck only ever holds cards that have been graded, so state is Learning, Review or Relearning (1-3) and last_review is set.
function cleanCard(n, c) {
  const ok = plain(c) && isDate(c.due) && isDate(c.last_review) && [1, 2, 3].includes(c.state)
    && ['stability', 'difficulty', 'elapsed_days', 'scheduled_days'].every(k => isNum(c[k]))
    && ['reps', 'lapses', 'learning_steps'].every(k => isInt(c[k]));
  if (!ok) no('This is not a valid backup: card ' + n + ' is damaged.');
  const { due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review } = c;
  return { due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, learning_steps, state, last_review };   // known fields only
}

// Returns { cards, backupDays, exported_at } or throws. backupDays is undefined when the file has no such setting.
export function readBackup(text) {
  let o;
  try { o = JSON.parse(text); } catch { no('This is not a valid backup: the file could not be read.'); }
  if (!plain(o) || o.format !== FORMAT || !Number.isInteger(o.version) || !isDate(o.exported_at) || !plain(o.cards)) no('This is not a backup file from this app.');
  if (o.version > VERSION) no('This backup was made by a newer version of the app. Update the app first.');
  if (o.version < 1) no('This is not a backup file from this app.');
  const keys = Object.keys(o.cards);
  if (!keys.length) no('This backup has no cards.');
  if (o.card_count !== keys.length) no('This backup is damaged: its card count does not match its cards.');
  const cards = {};
  for (const k of keys) {
    if (!/^[1-9]\d*$/.test(k) || +k > 3000) no('This is not a valid backup: "' + k + '" is not a sentence number.');
    cards[k] = cleanCard(k, o.cards[k]);
  }
  let backupDays;
  if (o.settings !== undefined) {
    if (!plain(o.settings)) no('This is not a valid backup: its settings are damaged.');
    backupDays = o.settings.backupDays;
    if (backupDays !== undefined && !REMIND_CHOICES.includes(backupDays)) no('This is not a valid backup: its reminder setting is damaged.');
  }
  return { cards, backupDays, exported_at: o.exported_at };
}

// Time of the most recent review in a set of cards (as written in the card), or null.
export function newest(cards) {
  let best = null;
  for (const c of Object.values(cards)) if (c && isDate(c.last_review) && (!best || Date.parse(c.last_review) > Date.parse(best))) best = c.last_review;
  return best;
}

// Why this backup may not replace the progress on the phone, or null if it may.
export function refusal(phone, backup) {
  const p = Object.keys(phone).length, b = Object.keys(backup).length;
  if (!b) return 'This backup has no cards. Nothing was changed.';
  if (!p) return null;
  if (b < p) return 'This backup has fewer cards (' + b + ') than this phone (' + p + '), so it would lose progress. Nothing was changed.';
  const nb = newest(backup), np = newest(phone);
  if (np && (!nb || Date.parse(nb) < Date.parse(np))) return 'This backup is older than the progress on this phone, so it would lose progress. Nothing was changed.';
  return null;
}

// A line to show on the home screen, or null when no reminder is due.
export function reminder({ backupDays, lastBackup }, cardCount, now) {
  if (!cardCount) return null;
  if (!lastBackup) return 'You have not backed up yet.';
  const days = Math.floor((now - Date.parse(lastBackup)) / 86400000);
  return days >= backupDays ? 'Your last backup was ' + days + ' days ago.' : null;
}
