// Backup file: what export writes, what import accepts, and when import refuses to replace progress.
import test from 'node:test';
import assert from 'node:assert/strict';
import { E, realDeck } from './helpers.js';
import { makeBackup, backupName, readBackup, newest, refusal, reminder, cleanSettings, DEFAULTS } from '../backup.js';

const NOW = new Date(2026, 10, 3, 14, 5);
const deck = realDeck();
const text = (o = makeBackup(deck, 7, NOW)) => JSON.stringify(o);
const withCards = f => { const o = JSON.parse(text()); f(o); return text(o); };
const refused = (t, re) => assert.throws(() => readBackup(t), e => /Nothing was changed\.$/.test(e.message) && (!re || re.test(e.message)));

test('the file holds only schedules and settings: no sentence text, no audio, no undo information', () => {
  const b = makeBackup(deck, 14, NOW);
  assert.deepEqual(Object.keys(b).sort(), ['card_count', 'cards', 'exported_at', 'format', 'settings', 'version']);
  assert.equal(b.format, 'vi-trainer-backup'); assert.equal(b.version, 1);
  assert.equal(b.card_count, 5); assert.equal(b.exported_at, NOW.toISOString());
  assert.deepEqual(b.settings, { backupDays: 14 });
  assert.deepEqual(b.cards, deck.cards);
  assert.doesNotMatch(text(b), /en_text|vi_text|_audio|"last"/);
});

test('the file name carries the local date', () => {
  assert.equal(backupName(NOW), 'vi-trainer-backup-2026-11-03.json');
  assert.equal(backupName(new Date(2026, 0, 9, 23, 59)), 'vi-trainer-backup-2026-01-09.json');
});

test('a backup read back gives every card exactly as it was, due times included', () => {
  const got = readBackup(text());
  assert.deepEqual(got.cards, deck.cards);
  assert.equal(got.backupDays, 7);
  assert.equal(got.exported_at, NOW.toISOString());
  assert.deepEqual(Object.values(got.cards).map(c => c.state).sort(), [1, 1, 2, 2, 3]);      // learning x2, review x2, relearning
});

test('a file that cannot be read is refused', () => {
  refused('', /could not be read/); refused('{"format":', /could not be read/); refused('not json at all', /could not be read/);
  for (const v of ['[]', '42', 'null', '"x"']) refused(v, /not a backup/);
});

test('a file that is not a backup, or is from another version, is refused', () => {
  refused(withCards(o => { o.format = 'vi-trainer-bundle'; }), /not a backup/);
  refused(withCards(o => { delete o.format; }), /not a backup/);
  refused(withCards(o => { o.version = 2; }), /newer version/);
  refused(withCards(o => { delete o.version; }), /not a backup/);
  refused(withCards(o => { o.exported_at = 'yesterday'; }), /not a backup/);
});

test('a damaged or truncated file is refused', () => {
  refused(withCards(o => { delete o.cards['3']; }), /card count/);                 // card_count says 5
  refused(withCards(o => { o.card_count = 6; }), /card count/);
  refused(withCards(o => { delete o.cards; }), /not a backup/);
  refused(withCards(o => { o.cards = []; }), /not a backup/);
  refused(withCards(o => { o.cards = {}; o.card_count = 0; }), /no cards/);
});

test('bad sentence numbers are refused', () => {
  for (const k of ['0', '3001', 'abc', '1.5', '01', '-1', '']) {
    refused(withCards(o => { o.cards[k] = o.cards['5']; delete o.cards['5']; }), /sentence number/);
  }
});

test('every kind of bad card is refused', () => {
  const bad = [['state', 0], ['state', 4], ['state', '2'], ['state', null], ['due', 'tomorrow'], ['due', 5], ['due', null],
    ['last_review', null], ['last_review', 'x'], ['stability', -1], ['stability', '1'], ['difficulty', null], ['reps', 1.5],
    ['lapses', -1], ['elapsed_days', 'a'], ['scheduled_days', null], ['learning_steps', 0.5]];
  for (const [field, value] of bad) refused(withCards(o => { o.cards['2'][field] = value; }), /card 2/);
  refused(withCards(o => { delete o.cards['2'].due; }), /card 2/);
  refused(withCards(o => { o.cards['2'] = 'x'; }), /card 2/);
  refused(withCards(o => { o.cards['2'] = null; }), /card 2/);
});

test('bad settings are refused; missing or unknown settings are fine', () => {
  refused(withCards(o => { o.settings.backupDays = 5; }), /setting/);
  refused(withCards(o => { o.settings = []; }), /setting/);
  assert.equal(readBackup(withCards(o => { delete o.settings; })).backupDays, undefined);
  assert.equal(readBackup(withCards(o => { o.settings = { backupDays: 30, colour: 'red' }; })).backupDays, 30);
});

test('unknown extra fields are ignored and not carried into the phone', () => {
  const got = readBackup(withCards(o => { o.extra = 1; o.cards['2'].junk = 'x'; }));
  assert.deepEqual(got.cards, deck.cards);
  assert.equal('extra' in got, false);
});

test('newest review of a set of cards', () => {
  assert.equal(newest({}), null);
  assert.equal(newest(deck.cards), new Date(2026, 10, 6, 10).toISOString());      // card 1, 3 days later
});

test('import refuses to replace progress with empty or older data', () => {
  const t = (d, h = 0) => ({ ...E.review({ cards: {}, last: null }, 1, 3, new Date(2026, 10, d, 10 + h)).cards });
  const one = t(3), later = { ...t(4), 2: t(4)[1] }, older = { ...t(1), 2: t(1)[1] };
  assert.equal(refusal({}, one), null);                                   // empty phone: restore
  assert.match(refusal(one, {}), /no cards/);                             // empty backup: never
  assert.match(refusal({}, {}), /no cards/);
  assert.match(refusal(later, one), /fewer cards/);                       // backup has fewer
  assert.match(refusal(one, older), /older/);                             // newest review older (same or more cards)
  assert.equal(refusal(one, one), null);                                  // same: allowed (the screen asks to confirm)
  assert.equal(refusal(one, later), null);                                // more cards and newer: allowed
  for (const m of [refusal(later, one), refusal(one, older), refusal(one, {})]) assert.match(m, /Nothing was changed\.$/);
});

test('the backup reminder', () => {
  const day = 86400000, s = (days, last) => ({ backupDays: days, lastBackup: last });
  const last = new Date(NOW.getTime() - 6 * day).toISOString();
  assert.equal(reminder(s(7, null), 0, NOW), null);                       // nothing to protect yet
  assert.match(reminder(s(7, null), 5, NOW), /not backed up yet/);        // progress but never backed up
  assert.equal(reminder(s(7, last), 5, NOW), null);                       // 6 days, limit 7
  assert.match(reminder(s(7, last), 5, new Date(NOW.getTime() + day)), /7 days ago/);
  assert.match(reminder(s(3, last), 5, NOW), /6 days ago/);
  assert.equal(reminder(s(7, new Date(NOW.getTime() + day).toISOString()), 5, NOW), null);   // clock moved back: no nag
});

// ---- ticket 05: the plan settings travel in the backup

test('the daily limit, target retention and starting sentence go into the backup and come back', () => {
  const b = makeBackup(deck, 7, NOW, { newPerDay: 20, retention: 0.85, startAt: 60 });
  assert.deepEqual(b.settings, { backupDays: 7, newPerDay: 20, retention: 0.85, startAt: 60 });
  const got = readBackup(text(b));
  assert.deepEqual([got.backupDays, got.newPerDay, got.retention, got.startAt], [7, 20, 0.85, 60]);
  assert.doesNotMatch(text(b), /\"today\"|\"intro\"/);                      // today's list is not part of the file
});

test('a start sentence of null (never set) is a value; a backup from before ticket 05 has none of these settings', () => {
  assert.equal(readBackup(text(makeBackup(deck, 7, NOW, { startAt: null }))).startAt, null);
  const old = readBackup(text());                                          // settings: { backupDays } only
  assert.deepEqual([old.newPerDay, old.retention, old.startAt], [undefined, undefined, undefined]);
  assert.equal(readBackup(withCards(o => { delete o.settings; })).newPerDay, undefined);
});

test('bad daily limit, retention or start sentence in a backup are refused', () => {
  const bad = [['newPerDay', 12], ['newPerDay', -5], ['newPerDay', '10'], ['newPerDay', 1.5], ['newPerDay', null],
    ['retention', 0.5], ['retention', '0.9'], ['retention', 1], ['retention', 0], ['retention', null],
    ['startAt', 0], ['startAt', 3001], ['startAt', 1.5], ['startAt', '5'], ['startAt', -1]];
  for (const [k, v] of bad) refused(withCards(o => { o.settings[k] = v; }), /setting/);
});

test('every good daily limit and retention choice is accepted', () => {
  for (const n of [0, 5, 10, 15, 20, 30]) assert.equal(readBackup(text(makeBackup(deck, 7, NOW, { newPerDay: n }))).newPerDay, n);
  for (const r of [0.8, 0.85, 0.9, 0.95]) assert.equal(readBackup(text(makeBackup(deck, 7, NOW, { retention: r }))).retention, r);
  for (const a of [1, 60, 3000]) assert.equal(readBackup(text(makeBackup(deck, 7, NOW, { startAt: a }))).startAt, a);
});

test('settings are cleaned one by one: good values kept, anything else replaced by the default', () => {
  assert.deepEqual(cleanSettings(undefined), { ...DEFAULTS, lastBackup: null });
  assert.deepEqual(cleanSettings({ backupDays: 14, lastBackup: 'x', newPerDay: 15, retention: 0.95, startAt: 100 }),
    { backupDays: 14, lastBackup: 'x', newPerDay: 15, retention: 0.95, startAt: 100 });
  assert.deepEqual(cleanSettings({ backupDays: 5, newPerDay: 99, retention: 2, startAt: 'a' }), { ...DEFAULTS, lastBackup: null });
  assert.deepEqual(DEFAULTS, { backupDays: 7, newPerDay: 10, retention: 0.9, startAt: null });
});
