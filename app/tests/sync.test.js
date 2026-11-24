// Sync merge tests (ticket 10, stage 1). Pure logic: no storage, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { merge, makeProgress, readProgress } from '../sync.js';
import { readBackup } from '../backup.js';
import { realDeck } from './helpers.js';

const T0 = Date.UTC(2026, 10, 1, 10), DAY = 86400000, NOW = new Date(Date.UTC(2026, 10, 12, 8));
const iso = ms => new Date(ms).toISOString();
const card = (last, o = {}) => ({ due: iso(last + DAY), stability: 5, difficulty: 5, elapsed_days: 0, scheduled_days: 1, reps: 1, lapses: 0, learning_steps: 0, state: 2, last_review: iso(last), ...o });
const S = { backupDays: 7, newPerDay: 10, retention: 0.9, startAt: null };
const side = (cards, o = {}) => ({ cards, settings: { ...S }, settingsAt: null, revision: 3, ...o });
const copy = x => JSON.parse(JSON.stringify(x));

test('identical sides: nothing to push or pull, revision unchanged', () => {
  const a = { 1: card(T0), 2: card(T0 + DAY) };
  const r = merge(side(copy(a)), side(copy(a), { revision: 7 }));
  assert.equal(r.ahead, 'same');
  assert.equal(r.push, false); assert.equal(r.pull, false);
  assert.equal(r.revision, 7);
  assert.deepEqual(r.cards, a);
});

test('phone has cards the vault lacks: push, and the revision goes up by one', () => {
  const r = merge(side({ 1: card(T0), 2: card(T0) }), side({ 1: card(T0) }, { revision: 7 }));
  assert.equal(r.ahead, 'phone'); assert.equal(r.push, true); assert.equal(r.pull, false);
  assert.equal(r.revision, 8);
  assert.deepEqual(Object.keys(r.cards), ['1', '2']);
});

test('vault has cards the phone lacks: pull, and the vault revision is kept', () => {
  const r = merge(side({ 1: card(T0) }), side({ 1: card(T0), 2: card(T0) }, { revision: 7 }));
  assert.equal(r.ahead, 'vault'); assert.equal(r.push, false); assert.equal(r.pull, true);
  assert.equal(r.revision, 7);
  assert.deepEqual(Object.keys(r.cards), ['1', '2']);
});

test('each side has cards the other lacks: both are updated with everything', () => {
  const r = merge(side({ 1: card(T0), 3: card(T0) }), side({ 1: card(T0), 2: card(T0) }));
  assert.equal(r.ahead, 'both'); assert.equal(r.push, true); assert.equal(r.pull, true);
  assert.deepEqual(Object.keys(r.cards), ['1', '2', '3']);
});

test('the same card on both: the later review wins, from either side', () => {
  const early = card(T0, { reps: 1 }), late = card(T0 + 3 * DAY, { reps: 2 });
  let r = merge(side({ 1: late }), side({ 1: early }));
  assert.deepEqual(r.cards[1], late); assert.equal(r.push, true); assert.equal(r.pull, false);
  r = merge(side({ 1: early }), side({ 1: late }));
  assert.deepEqual(r.cards[1], late); assert.equal(r.push, false); assert.equal(r.pull, true);
});

test('the same review time with a different card cannot be decided: it asks and decides nothing', () => {
  const p = card(T0, { stability: 9 }), v = card(T0, { stability: 4 });
  const r = merge(side({ 1: p, 2: card(T0) }), side({ 1: v, 2: card(T0) }));
  assert.equal(r.cards, undefined); assert.equal(r.push, undefined);
  assert.equal(r.ask.length, 1);
  assert.deepEqual(r.ask[0], { kind: 'card', number: 1, phone: p, vault: v });
});

test('a question can be answered by keeping the phone or the vault', () => {
  const p = card(T0, { stability: 9 }), v = card(T0, { stability: 4 });
  const a = side({ 1: p }), b = side({ 1: v });
  assert.deepEqual(merge(a, b, 'phone').cards[1], p);
  assert.deepEqual(merge(a, b, 'vault').cards[1], v);
  assert.equal(merge(a, b, 'phone').push, true);
  assert.equal(merge(a, b, 'vault').push, false);
});

test('a phone with no cards only pulls and ignores its own settings', () => {
  const vault = side({ 1: card(T0), 2: card(T0) }, { revision: 7, settings: { ...S, newPerDay: 5 }, settingsAt: iso(T0) });
  const r = merge(side({}, { settings: { ...S, retention: 0.95 }, settingsAt: iso(T0 + DAY) }), vault);
  assert.equal(r.push, false); assert.equal(r.pull, true);
  assert.equal(r.revision, 7);
  assert.deepEqual(r.cards, vault.cards);
  assert.equal(r.settings.newPerDay, 5); assert.equal(r.settings.retention, 0.9);
});

test('a stale phone (lower revision, older copies of the same cards) pulls and never pushes', () => {
  const vault = side({ 1: card(T0 + 5 * DAY, { reps: 4 }), 2: card(T0 + 5 * DAY, { reps: 3 }) }, { revision: 12 });
  const r = merge(side({ 1: card(T0), 2: card(T0) }, { revision: 2 }), vault);
  assert.equal(r.push, false); assert.equal(r.pull, true);
  assert.equal(r.revision, 12);
  assert.deepEqual(r.cards, vault.cards);
});

test('settings: the later edit wins, no timestamp loses, equal values are fine', () => {
  const a = side({ 1: card(T0) }, { settings: { ...S, newPerDay: 20 }, settingsAt: iso(T0 + DAY) });
  const b = side({ 1: card(T0) }, { settings: { ...S, newPerDay: 5 }, settingsAt: iso(T0) });
  assert.equal(merge(a, b).settings.newPerDay, 20);
  assert.equal(merge(b, a).settings.newPerDay, 20);
  const never = side({ 1: card(T0) });
  assert.equal(merge(never, b).settings.newPerDay, 5);
  assert.equal(merge(b, never).settings.newPerDay, 5);
  assert.equal(merge(never, side({ 1: card(T0) })).ahead, 'same');
});

test('settings that differ with no way to tell which is later are a question', () => {
  const p = side({ 1: card(T0) }, { settings: { ...S, newPerDay: 20 } }), v = side({ 1: card(T0) }, { settings: { ...S, newPerDay: 5 } });
  const r = merge(p, v);
  assert.equal(r.ask.length, 1); assert.equal(r.ask[0].kind, 'settings');
  assert.equal(merge(p, v, 'phone').settings.newPerDay, 20);
  assert.equal(merge(p, v, 'vault').settings.newPerDay, 5);
  const sameStamp = merge(side({ 1: card(T0) }, { settings: { ...S, newPerDay: 20 }, settingsAt: iso(T0) }), side({ 1: card(T0) }, { settings: { ...S, newPerDay: 5 }, settingsAt: iso(T0) }));
  assert.equal(sameStamp.ask.length, 1);
});

test('merge does not change what it is given', () => {
  const p = side({ 1: card(T0), 3: card(T0) }), v = side({ 1: card(T0 + DAY), 2: card(T0) });
  const pc = copy(p), vc = copy(v);
  merge(p, v);
  assert.deepEqual(p, pc); assert.deepEqual(v, vc);
});

// A seeded random mix of cards on two sides, with ties on purpose (equal times always mean equal cards, so no questions).
function rnd(seed) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }
function randomSide(r) {
  const cards = {};
  for (let n = 1; n <= 40; n++) if (r() < 0.7) cards[n] = card(T0 + Math.floor(r() * 5) * DAY);
  return cards;
}
test('whatever the two sides hold, nothing is lost and the order does not matter', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const r = rnd(seed), pc = randomSide(r), vc = randomSide(r);
    if (!Object.keys(pc).length) continue;
    const m = merge(side(pc), side(vc)), back = merge(side(vc), side(pc));
    for (const [name, c] of [['phone', pc], ['vault', vc]]) for (const n of Object.keys(c)) {
      assert.ok(m.cards[n], `seed ${seed}: card ${n} from the ${name} was lost`);
      assert.ok(Date.parse(m.cards[n].last_review) >= Date.parse(c[n].last_review), `seed ${seed}: card ${n} went back in time`);
    }
    assert.deepEqual(m.cards, back.cards, `seed ${seed}: the result depends on which side is which`);
    const again = merge(side(m.cards), side(m.cards));
    assert.equal(again.ahead, 'same');
  }
});

// ---- the progress file

const progress = (o = {}) => ({ cards: { 1: card(T0), 2: card(T0 + DAY) }, settings: { ...S }, settingsAt: iso(T0), revision: 5, ...o });

test('a progress file reads back exactly, with real engine cards', () => {
  const deck = realDeck(), p = progress({ cards: deck.cards });
  const back = readProgress(JSON.stringify(makeProgress(p, NOW)));
  assert.deepEqual(back, p);
});

test('a progress file is also a valid backup, so the Files fallback still works', () => {
  const b = readBackup(JSON.stringify(makeProgress(progress(), NOW)));
  assert.deepEqual(Object.keys(b.cards), ['1', '2']);
  assert.equal(b.newPerDay, 10);
});

test('the progress file records the revision, when it was written and when settings last changed', () => {
  const f = makeProgress(progress({ settingsAt: null }), NOW);
  assert.equal(f.revision, 5); assert.equal(f.changed_at, NOW.toISOString()); assert.equal(f.settings_at, null);
  assert.equal(f.card_count, 2);
});

test('a progress file with no settings uses the defaults', () => {
  const f = makeProgress(progress(), NOW); delete f.settings;
  const back = readProgress(JSON.stringify(f));
  assert.deepEqual(back.settings, S);
});

const refused = (text, re) => assert.throws(() => readProgress(text), e => re.test(e.message) && /Nothing was changed\.$/.test(e.message));
test('anything that is not valid progress is refused with a clear message', () => {
  const good = () => makeProgress(progress(), NOW);
  refused('not json at all', /not usable/);
  refused('', /not usable/);
  refused('{}', /not usable/);
  refused(JSON.stringify({ ...good(), cards: {}, card_count: 0 }), /no cards/);          // an empty vault file is never real progress
  refused(JSON.stringify({ ...good(), version: 2 }), /newer version/);
  refused(JSON.stringify({ ...good(), card_count: 9 }), /card count/);                    // truncated
  const bad = good(); bad.cards[1].state = 0;
  refused(JSON.stringify(bad), /card 1 is damaged/);
  const plainBackup = good(); delete plainBackup.revision;
  refused(JSON.stringify(plainBackup), /revision/);                                       // a plain backup file is not progress
  refused(JSON.stringify({ ...good(), revision: -1 }), /revision/);
  refused(JSON.stringify({ ...good(), revision: 1.5 }), /revision/);
  refused(JSON.stringify({ ...good(), changed_at: 'yesterday' }), /revision/);
  refused(JSON.stringify({ ...good(), settings_at: 'yesterday' }), /revision/);
  refused(JSON.stringify({ ...good(), settings: { ...S, newPerDay: 7 } }), /daily limit/);
});
