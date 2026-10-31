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
function drain(deck, pack, now) {
  const done = hand(State.Review, new Date(2030, 0, 1)), order = [];
  let cards = { ...deck.cards }, x;
  while ((x = E.next(withCards(cards), pack, now)) && x.n !== undefined) { order.push(x.n + ':' + x.kind); cards[x.n] = done; }
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
  assert.deepEqual(drain(withCards(cards), [3, 1, 2, 5, 6, 7, 8, 9], at(9)),
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
  assert.deepEqual(E.undo(d1), d0);                                 // first-ever grade: the card is new again
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
