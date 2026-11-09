// Run from the vi-trainer folder:  node --test
// Interval numbers below come from ts-fsrs 5.4.1 with steps 1m/10m and 90% retention. If the library
// is ever changed, these tests show exactly what moved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEngine, emptyDeck } from '../engine.js';

(0, eval)(readFileSync(new URL('../vendor/ts-fsrs.umd.js', import.meta.url), 'utf8'));   // sets globalThis.FSRS
const { State } = globalThis.FSRS;
const E = createEngine(globalThis.FSRS);

const AGAIN = 1, HARD = 2, GOOD = 3, EASY = 4;
const at = (h, m = 0, day = 30) => new Date(2026, 9, day, h, m);          // local time, October 2026
const mins = (card, from) => (new Date(card.due) - from) / 60000;
const hand = (state, due) => ({ state, due: due.toISOString() });         // hand-made card for queue tests
const withCards = cards => ({ cards, last: null });

// Takes cards one at a time (marking each done) and returns the order they came in.
function drain(deck, pack, now, cfg) {
  const done = hand(State.Review, new Date(2030, 0, 1)), order = [];
  let d = { ...deck, cards: { ...deck.cards } }, x;
  while ((x = E.next(d, pack, now, cfg)) && x.n !== undefined) {
    order.push(x.n + ':' + x.kind);
    if (x.kind === 'new') d = E.review(d, x.n, GOOD, now);          // records it in today's list, as the app does
    d = { ...d, cards: { ...d.cards, [x.n]: done } };
  }
  return order;
}

test('a new card shows the interval for each grade before choosing', () => {
  assert.deepEqual(E.preview(null, at(9)).map(p => p.label), ['1 min', '6 min', '10 min', '8 d']);
});

test('new card: Again, Hard, Good stay in learning; Easy graduates', () => {
  const now = at(9);
  const r = g => E.review(emptyDeck(), 1, g, now).cards[1];
  assert.deepEqual([AGAIN, HARD, GOOD].map(g => [r(g).state, mins(r(g), now)]),
    [[State.Learning, 1], [State.Learning, 6], [State.Learning, 10]]);
  assert.equal(r(EASY).state, State.Review);
  assert.equal(mins(r(EASY), now), 8 * 1440);
});

test('two steps: Good, then Good again 10 minutes later, graduates to about 2 days', () => {
  const d1 = E.review(emptyDeck(), 1, GOOD, at(9));
  const d2 = E.review(d1, 1, GOOD, at(9, 10));
  assert.equal(d2.cards[1].state, State.Review);
  assert.equal(mins(d2.cards[1], at(9, 10)), 2 * 1440);
});

test('a lapse on a review card goes to relearning in 10 minutes', () => {
  const d1 = E.review(emptyDeck(), 1, EASY, at(9));                 // due 8 days later
  const later = new Date(new Date(d1.cards[1].due));
  const d2 = E.review(d1, 1, AGAIN, later);
  assert.equal(d2.cards[1].state, State.Relearning);
  assert.equal(d2.cards[1].lapses, 1);
  assert.equal(mins(d2.cards[1], later), 10);
});

test('the same inputs always give the same result', () => {
  assert.deepEqual(E.review(emptyDeck(), 1, GOOD, at(9)), E.review(emptyDeck(), 1, GOOD, at(9)));
});

test('a card graded Again comes back in the same sitting', () => {
  const d = E.review(emptyDeck(), 1, AGAIN, at(9));                 // due 9:01
  assert.deepEqual(E.next(d, [1, 2], at(9, 0)), { n: 2, kind: 'new' });          // not due yet, other new cards exist
  assert.deepEqual(E.next(d, [1, 2], at(9, 1)), { n: 1, kind: 'learning' });     // due: comes first
  assert.deepEqual(E.next(d, [1], at(9, 0)), { n: 1, kind: 'learning' });        // nothing else left: shown early
});

test('learn-ahead: a learning card due within 20 minutes is shown early, later ones wait', () => {
  const pack = [];
  assert.deepEqual(E.next(withCards({ 1: hand(State.Learning, at(9, 15)) }), pack, at(9)), { n: 1, kind: 'learning' });
  const w = E.next(withCards({ 1: hand(State.Learning, at(9, 25)) }), pack, at(9));
  assert.deepEqual(w, { wait: at(9, 25) });
  assert.equal(E.next(emptyDeck(), pack, at(9)), null);
});

test('order: due learning, then reviews most overdue first, then new cards in course order', () => {
  const cards = {
    5: hand(State.Review, at(8, 0, 1)),            // 29 days overdue
    6: hand(State.Review, at(8, 0, 28)),           // 2 days overdue
    7: hand(State.Review, at(3, 0, 31)),           // due tomorrow 3 a.m. = still today's study day
    8: hand(State.Learning, at(8, 59)),
    9: hand(State.Review, at(15, 0, 31)),          // tomorrow afternoon: not due yet
  };
  assert.deepEqual(drain(withCards(cards), [3, 1, 2, 5, 6, 7, 8, 9], at(9), { startAt: 1 }),     // course starts at 1
    ['8:learning', '5:review', '6:review', '7:review', '1:new', '2:new', '3:new']);
});

test('after skipping many days every overdue review is still due, none reset, most overdue first', () => {
  const cards = { 1: hand(State.Review, at(9, 0, 20)), 2: hand(State.Review, at(9, 0, 1)) };
  const deck = withCards(cards), before = JSON.stringify(deck), now = at(9, 0, 30);
  assert.deepEqual(E.counts(deck, [], now), { new: 0, learning: 0, review: 2 });
  assert.deepEqual(E.next(deck, [], now), { n: 2, kind: 'review' });
  assert.equal(JSON.stringify(deck), before);                       // looking at the queue changes nothing
});

test('4 a.m. rollover: a card due at 3 a.m. belongs to the day before, 5 a.m. to the new day', () => {
  const early = withCards({ 1: hand(State.Review, at(3, 0, 31)) });
  assert.equal(E.counts(early, [], at(23, 0, 30)).review, 1);       // 11 p.m.: due in this study day
  const late = withCards({ 1: hand(State.Review, at(5, 0, 31)) });
  assert.equal(E.counts(late, [], at(23, 0, 30)).review, 0);        // 11 p.m.: not yet
  assert.equal(E.counts(late, [], at(3, 59, 31)).review, 0);        // 3:59 a.m.: still the old day
  assert.equal(E.counts(late, [], at(4, 0, 31)).review, 1);         // 4:00 a.m.: new day, now due
});

test('course order: new sentences come lowest number first whatever order the pack lists them', () => {
  const pack = [3, 1, 2];
  assert.deepEqual(E.next(emptyDeck(), pack, at(9)), { n: 1, kind: 'new' });
  const d = E.review(emptyDeck(), 1, GOOD, at(9));                  // 1 is now learning, due in 10 minutes
  assert.deepEqual(E.next(d, pack, at(9, 1)), { n: 2, kind: 'new' });
});

test('counts: new, learning and reviews due today', () => {
  const deck = withCards({ 1: hand(State.Learning, at(9, 5)), 2: hand(State.Review, at(8)), 3: hand(State.Review, at(15, 0, 31)) });
  assert.deepEqual(E.counts(deck, [1, 2, 3, 4, 5], at(9)), { new: 2, learning: 1, review: 1 });
});

test('undo puts back the card exactly as it was, including a brand new card', () => {
  const d0 = emptyDeck();
  const d1 = E.review(d0, 1, GOOD, at(9));
  assert.deepEqual(E.undo(d1).cards, d0.cards);                     // first-ever grade: the card is new again
  assert.equal(E.undo(d1).last, null);
  const d2 = E.review(d1, 1, GOOD, at(9, 10));
  const u = E.undo(d2);
  assert.deepEqual(u.cards, d1.cards);
  assert.equal(u.last, null);
  assert.deepEqual(E.undo(u), u);                                   // nothing more to undo: no change
  assert.deepEqual(E.next(E.undo(d1), [1, 2], at(9, 1)), { n: 1, kind: 'new' });
});

test('a deck saved as JSON and loaded again behaves the same (this is how it is stored)', () => {
  const d = E.review(E.review(emptyDeck(), 1, GOOD, at(9)), 2, EASY, at(9, 1));
  const copy = JSON.parse(JSON.stringify(d));
  assert.deepEqual(copy, d);
  assert.deepEqual(E.review(copy, 1, GOOD, at(9, 10)), E.review(d, 1, GOOD, at(9, 10)));
  assert.deepEqual(E.undo(copy), E.undo(d));
});

test('a bad grade or card number is refused and nothing changes', () => {
  const d = emptyDeck();
  for (const [n, g] of [[1, 0], [1, 5], [1, 'Good'], [1.5, GOOD], ['1', GOOD]]) assert.throws(() => E.review(d, n, g, at(9)));
  assert.deepEqual(d, emptyDeck());
});

// ---- ticket 05: daily plan, position, progress
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const PACK = range(1, 100);
const DAY = 86400000;
// Introduces `count` new sentences (lowest first) at the given time, one grade each, like a sitting would.
function introduce(deck, count, now, cfg) {
  for (let i = 0; i < count; i++) deck = E.review(deck, E.next(deck, PACK, now, cfg).n, GOOD, now);
  return deck;
}
const newOf = (deck, now, cfg, pack = PACK) => E.counts(deck, pack, now, cfg).new;

test('daily limit: by default 10 new sentences a day, in course order, then no more new ones', () => {
  assert.equal(newOf(emptyDeck(), at(9)), 10);
  assert.deepEqual(drain(emptyDeck(), PACK, at(9)), range(1, 10).map(n => n + ':new'));
});

test('daily limit: grading new sentences uses up today\'s allowance', () => {
  const d = introduce(emptyDeck(), 3, at(9));
  assert.equal(newOf(d, at(9, 1)), 7);
  assert.equal(E.next(d, PACK, at(9, 1)).n, 4);
});

test('daily limit: once it is used, new sentences stop but due cards still come', () => {
  const d = introduce(emptyDeck(), 10, at(9));
  assert.equal(newOf(d, at(9, 1)), 0);
  const x = E.next(d, PACK, at(9, 1));                               // nothing else left: only learn-ahead of cards just graded
  assert.notEqual(x && x.kind, 'new');
  const withDue = { ...d, cards: { ...d.cards, 50: hand(State.Review, at(8)) } };
  assert.deepEqual(E.next(withDue, PACK, at(9, 1)), { n: 50, kind: 'review' });
});

test('daily limit can be changed: a higher one gives more today, a lower one never goes below zero', () => {
  const d = introduce(emptyDeck(), 7, at(9));                        // 7 introduced with the default 10
  assert.equal(newOf(d, at(9, 1), { newPerDay: 20 }), 13);
  assert.equal(newOf(d, at(9, 1), { newPerDay: 5 }), 0);
  assert.equal(newOf(d, at(9, 1), { newPerDay: 0 }), 0);
});

test('a limit of 0 means review only: no new sentences at all', () => {
  assert.equal(newOf(emptyDeck(), at(9), { newPerDay: 0 }), 0);
  assert.equal(E.next(emptyDeck(), PACK, at(9), { newPerDay: 0 }), null);
});

test('the allowance starts again at the 4 a.m. rollover', () => {
  const d = introduce(emptyDeck(), 10, at(23, 0, 30));
  assert.equal(newOf(d, at(23, 30, 30)), 0);
  assert.equal(newOf(d, at(3, 59, 31)), 0);                          // still the same study day
  assert.equal(newOf(d, at(4, 0, 31)), 10);                          // new study day
  assert.equal(E.plan(d, PACK, at(4, 0, 31)).upcoming[0], 11);
});

test('undo of a new sentence\'s first grade gives its place in today\'s allowance back', () => {
  const d = introduce(emptyDeck(), 3, at(9));
  assert.equal(newOf(E.undo(d), at(9, 1)), 8);
  assert.equal(E.next(E.undo(d), PACK, at(9, 1)).n, 3);
  const again = E.review(d, 1, GOOD, at(9, 10));                     // grading an old card does not use new allowance
  assert.equal(newOf(again, at(9, 11)), 7);
  assert.equal(newOf(E.undo(again), at(9, 11)), 7);                  // ...and undoing it does not give any back
});

test('learn more: +5 for today only, repeatable, and it changes no card', () => {
  const d = introduce(emptyDeck(), 10, at(9));
  Object.values(d.cards).forEach(Object.freeze); Object.freeze(d.cards);
  const more = E.learnMore(d, at(9, 1));
  assert.deepEqual(more.cards, d.cards);
  assert.equal(newOf(more, at(9, 2)), 5);
  assert.equal(E.next(more, PACK, at(9, 2)).n, 11);
  assert.equal(newOf(E.learnMore(more, at(9, 3)), at(9, 4)), 10);   // a second tap
  assert.equal(newOf(more, at(4, 0, 31)), 10);                       // tomorrow: the normal limit, extras forgotten
  assert.equal(more.last, d.last);                                   // undo still undoes the last grade
});

test('learn more does not break the schedule: due cards still come first and course order holds', () => {
  const d = E.learnMore(introduce(emptyDeck(), 10, at(9)), at(9, 1));
  const withDue = { ...d, cards: { ...d.cards, 50: hand(State.Review, at(8)) } };
  assert.deepEqual(E.next(withDue, PACK, at(9, 2)), { n: 50, kind: 'review' });
  assert.deepEqual(drain(withDue, PACK, at(9, 2)).filter(x => x.endsWith(':new')), ['11:new', '12:new', '13:new', '14:new', '15:new']);
});

test('position: the next new sentence is the lowest number without a card', () => {
  assert.equal(E.plan(emptyDeck(), PACK, at(9)).pos, 1);
  const d = withCards({ 1: hand(State.Review, at(9)), 2: hand(State.Review, at(9)), 4: hand(State.Review, at(9)) });
  assert.equal(E.plan(d, PACK, at(9)).pos, 3);
  assert.equal(E.plan(withCards(Object.fromEntries(range(1, 3000).map(n => [n, hand(State.Review, at(9))]))), PACK, at(9)).pos, null);
});

test('starting position: start at sentence N and carry on in course order from there', () => {
  const cfg = { startAt: 60 };
  assert.equal(E.plan(emptyDeck(), PACK, at(9), cfg).pos, 60);
  assert.deepEqual(drain(emptyDeck(), PACK, at(9), cfg), range(60, 69).map(n => n + ':new'));
  const d = introduce(emptyDeck(), 2, at(9), cfg);
  assert.deepEqual(Object.keys(d.cards), ['60', '61']);              // sentences 1-59 are left alone
  assert.equal(E.plan(d, PACK, at(9, 1), cfg).pos, 62);
});

test('starting position: with cards but no saved start, the course carries on from the lowest studied sentence', () => {
  const d = withCards({ 500: hand(State.Review, at(9)), 501: hand(State.Review, at(9)) });
  const pack = range(1, 600);
  assert.equal(E.plan(d, pack, at(9)).pos, 502);                     // not back to sentence 1
  assert.equal(E.plan(d, pack, at(9), { startAt: 100 }).pos, 100);   // an explicit start wins
});

test('course order has no jumps: a sentence that is not on the phone stops new cards and is named', () => {
  const pack = [...range(1, 5), 101, 102];
  const d = withCards(Object.fromEntries(range(1, 5).map(n => [n, hand(State.Review, new Date(2030, 0, 1))])));
  const p = E.plan(d, pack, at(9));
  assert.equal(p.pos, 6); assert.equal(p.onPhone, false);
  assert.equal(newOf(d, at(9), undefined, pack), 0);
  assert.equal(E.next(d, pack, at(9)), null);
  assert.equal(E.plan(withCards({}), pack, at(9)).onPhone, true);
});

test('after weeks away: every overdue review is due, most overdue first, and new sentences are still just one day\'s worth', () => {
  let deck = emptyDeck();                                            // real cards graded Easy on 1-30 Oct, so due 9-38 Oct
  for (let n = 1; n <= 30; n++) deck = E.review(deck, n, EASY, new Date(2026, 9, n, 9));
  const now = new Date(2026, 10, 25, 9), before = JSON.stringify(deck);
  assert.deepEqual(E.counts(deck, PACK, now), { new: 10, learning: 0, review: 30 });   // not 10 per day missed
  assert.deepEqual(drain(deck, PACK, now).slice(0, 3), ['1:review', '2:review', '3:review']);
  assert.equal(JSON.stringify(deck), before);
  const g = E.review(deck, 1, GOOD, now);                            // grading a 55-day-overdue card keeps it a review card
  assert.equal(g.cards[1].state, State.Review);
  assert.equal(Object.keys(g.cards).length, 30);                     // no card lost or reset
});

test('target retention: a higher target gives shorter intervals, a lower one longer, from the next grade on', () => {
  const grade = r => {
    const e = createEngine(globalThis.FSRS, { retention: r });
    const d1 = e.review(emptyDeck(), 1, EASY, at(9));
    return e.review(d1, 1, GOOD, new Date(d1.cards[1].due)).cards[1].scheduled_days;
  };
  const [a, b, c, d] = [0.8, 0.85, 0.9, 0.95].map(grade);
  assert.ok(a > b && b > c && c > d, [a, b, c, d].join(' '));
  const e80 = createEngine(globalThis.FSRS, { retention: 0.8 }), e95 = createEngine(globalThis.FSRS, { retention: 0.95 });
  const card = createEngine(globalThis.FSRS).review(emptyDeck(), 1, EASY, at(9)).cards[1], later = new Date(card.due);
  assert.notDeepEqual(e80.preview(card, later), e95.preview(card, later));   // the labels shown before grading follow it too
  assert.equal(E.review(emptyDeck(), 1, EASY, at(9)).cards[1].due, createEngine(globalThis.FSRS, { retention: 0.9 }).review(emptyDeck(), 1, EASY, at(9)).cards[1].due);
});

test('a new card\'s first grade is recorded in today\'s list; grading an old card is not', () => {
  const d1 = E.review(emptyDeck(), 7, GOOD, at(9));
  assert.deepEqual(d1.today.intro, [7]);
  const d2 = E.review(d1, 7, GOOD, at(9, 10));
  assert.deepEqual(d2.today.intro, [7]);
  assert.deepEqual(E.undo(d1).today.intro, []);
});

// ---- read-along (ticket 04, changed in ticket 05): today's set = introduced today + still to come today

test('read-along set: today\'s new sentences in course order, whatever order the pack is in', () => {
  const pack = [60, 3, 2, 1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
  const deck = withCards({ 2: hand(State.Review, at(9)), 5: hand(State.Learning, at(9)) });
  assert.deepEqual(E.readAlong(deck, pack, at(9), { startAt: 1 }), [1, 3, 4, 6, 7, 8, 9, 10, 11, 12]);
});

test('read-along set: stays the same through the day as sentences get introduced', () => {
  const morning = E.readAlong(emptyDeck(), PACK, at(9));
  assert.deepEqual(morning, range(1, 10));
  const d = introduce(emptyDeck(), 4, at(9));
  assert.deepEqual(E.readAlong(d, PACK, at(10)), morning);           // 1-4 introduced today + 5-10 still to come
  assert.deepEqual(E.readAlong(introduce(emptyDeck(), 10, at(9)), PACK, at(10)), morning);   // all used: still the same ten
  assert.deepEqual(E.readAlong(E.undo(d), PACK, at(10)), morning);
});

test('read-along set: follows the daily limit, learn more, the start sentence and a new day', () => {
  assert.deepEqual(E.readAlong(emptyDeck(), PACK, at(9), { newPerDay: 5 }), range(1, 5));
  assert.deepEqual(E.readAlong(emptyDeck(), PACK, at(9), { startAt: 60 }), range(60, 69));
  assert.deepEqual(E.readAlong(E.learnMore(emptyDeck(), at(9)), PACK, at(9)), range(1, 15));
  const d = introduce(emptyDeck(), 10, at(9));
  assert.deepEqual(E.readAlong(d, PACK, at(4, 0, 31)), range(11, 20));   // tomorrow: the next ten
  assert.deepEqual(E.readAlong(emptyDeck(), PACK, at(9), { newPerDay: 0 }), []);
});

test('read-along set: fewer left than the limit gives what is left, none gives an empty set', () => {
  assert.deepEqual(E.readAlong(emptyDeck(), [1, 2, 3], at(9)), [1, 2, 3]);
  assert.deepEqual(E.readAlong(withCards({ 1: hand(State.Review, at(9)) }), [1], at(9)), []);
  assert.deepEqual(E.readAlong(emptyDeck(), [], at(9)), []);
});

test('read-along set: sentences introduced today but not on the phone are left out', () => {
  const d = introduce(emptyDeck(), 2, at(9));
  assert.deepEqual(E.readAlong(d, range(2, 20), at(9, 5)), range(2, 10));   // 1 was introduced but is not on this phone
});

test('read-along set: choosing it leaves the deck exactly as it was', () => {
  const deck = withCards({ 1: hand(State.Review, at(9)), 2: hand(State.Learning, at(9)) });
  Object.values(deck.cards).forEach(Object.freeze); Object.freeze(deck.cards); Object.freeze(deck);   // any write would throw
  const before = JSON.stringify(deck);
  E.readAlong(deck, [1, 2, 3, 4], at(9));
  assert.equal(JSON.stringify(deck), before);
});
