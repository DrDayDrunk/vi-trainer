// Ticket 06: hands-free session. Pure logic only (queue, mix, plan, render, WAV, prefs); the phone-only parts are in STATUS.md.
// Run from the app folder:  node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { E } from './helpers.js';
import { emptyDeck } from '../engine.js';
import { sessionName, mix, pauses, playSeconds, cost, planSession, render, toInt16, nextDay, cleanPrefs, RATE, RETURNS } from '../session.js';

const { State } = globalThis.FSRS;
const hand = (state, due) => ({ state, due: due.toISOString() });
const now = new Date(2026, 10, 9, 12);                       // Mon 9 Nov 2026, 12:00 local
const pack = Array.from({ length: 60 }, (_, i) => i + 1);    // sentences 1-60 are on the phone
const cfg = { newPerDay: 3, startAt: 1 };

// ---------------------------------------------------------------- engine: queue

const queueDeck = () => ({ last: null, cards: {
  5: hand(State.Learning, new Date(2026, 10, 9, 12, 30)), 6: hand(State.Relearning, new Date(2026, 10, 9, 9)),
  10: hand(State.Review, new Date(2026, 10, 8, 10)), 11: hand(State.Review, new Date(2026, 10, 6, 10)),
  12: hand(State.Review, new Date(2026, 10, 10, 10)),      // due tomorrow 10:00: not due today
  99: hand(State.Review, new Date(2026, 10, 1)),           // due, but sentence 99 is not on the phone
} });

test('queue: learning by due time, reviews due today most overdue first, new in course order, missing named', () => {
  assert.deepEqual(E.queue(queueDeck(), pack, now, cfg), { learning: [6, 5], review: [11, 10], fresh: [1, 2, 3], missing: [99] });
});

test('queue: choosing the queue leaves the deck exactly as it was', () => {
  const d = queueDeck(), before = JSON.stringify(d);
  E.queue(d, pack, now, cfg); E.queue(d, pack, nextDay(now), cfg);
  assert.equal(JSON.stringify(d), before);
});

test('queue for tomorrow: reviews due tomorrow are in, and the new-sentence allowance starts fresh', () => {
  const d = E.review(emptyDeck(), 1, 3, now);              // sentence 1 graded today: uses today's only new place
  const c = { newPerDay: 1, startAt: 1 };
  assert.deepEqual(E.queue(d, pack, now, c), { learning: [1], review: [], fresh: [], missing: [] });
  assert.deepEqual(E.queue(d, pack, nextDay(now), c), { learning: [1], review: [], fresh: [2], missing: [] });
  assert.deepEqual(E.queue(queueDeck(), pack, nextDay(now), cfg).review, [11, 10, 12]);
});

// ---------------------------------------------------------------- mix

test('mix: new sentences are spread evenly among the due ones, due order kept', () => {
  const m = mix({ learning: [1, 2], review: [3, 4], fresh: [100, 101] });
  assert.deepEqual(m.map(x => x.n), [1, 100, 2, 3, 101, 4]);
  assert.deepEqual(m.map(x => x.kind), ['learning', 'new', 'learning', 'review', 'new', 'review']);
});

test('mix: only due, or only new, or nothing', () => {
  assert.deepEqual(mix({ learning: [], review: [7, 8], fresh: [] }).map(x => x.n), [7, 8]);
  assert.deepEqual(mix({ learning: [], review: [], fresh: [3, 4] }).map(x => x.kind), ['new', 'new']);
  assert.deepEqual(mix({ learning: [], review: [], fresh: [] }), []);
});

test('mix: one new sentence among 20 due ones is not at either end', () => {
  const i = mix({ learning: [], review: Array.from({ length: 20 }, (_, k) => k + 1), fresh: [100] }).findIndex(x => x.n === 100);
  assert.ok(i > 3 && i < 17, 'position ' + i);
});

// ---------------------------------------------------------------- pauses and plan

const item = (n, kind = 'review', en = 2, vi = 3) => ({ n, kind, en, vi });
const near = (a, b, d = 1e-9) => assert.ok(Math.abs(a - b) < d, a + ' vs ' + b);

test('pauses follow the prototype rule: 1.2 s + 1.5 x Vietnamese, 0.8 s + 1.2 x, then 1.0 s', () => {
  const p = pauses(2);
  near(p[0], 4.2); near(p[1], 3.2); near(p[2], 1);
  near(playSeconds(item(1, 'review', 2, 3)), 2 + 6 + 5.7 + 4.4 + 1);
});

test('the pause setting scales every pause and nothing else', () => {
  near(pauses(2, 2)[0], 8.4); near(pauses(2, 0.75)[2], 0.75);
  near(playSeconds(item(1), 2) - playSeconds(item(1), 1), 5.7 + 4.4 + 1);
});

test('plan: never longer than the target, and within a minute of it when there is enough to play', () => {
  for (const minutes of [5, 10, 15, 20, 30]) {
    const items = Array.from({ length: 200 }, (_, i) => item(i + 1, 'review', 1.5 + (i % 5) * 0.4, 2 + (i % 7) * 0.5));
    const p = planSession(items, minutes);
    assert.ok(p.seconds <= minutes * 60, minutes + ' min: ' + p.seconds);
    assert.ok(p.seconds >= minutes * 60 - 60, minutes + ' min: ' + p.seconds);
  }
});

test('plan: a longer pause setting still fits the target', () => {
  const items = Array.from({ length: 200 }, (_, i) => item(i + 1));
  const a = planSession(items, 15, 1), b = planSession(items, 15, 2);
  assert.ok(b.plays.length < a.plays.length);
  assert.ok(b.seconds <= 900 && b.seconds >= 840);
});

test('plan: each due sentence plays once; each new sentence returns after 5 and after 15 sentences', () => {
  assert.deepEqual(RETURNS, [5, 15]);
  const items = [item(100, 'new'), ...Array.from({ length: 40 }, (_, i) => item(i + 1))];
  const p = planSession(items, 30);
  assert.deepEqual(p.plays.map((x, i) => x.n === 100 ? i : -1).filter(i => i >= 0), [0, 5, 15]);
  assert.deepEqual(p.plays.filter(x => x.n === 100).map(x => x.ret), [0, 1, 2]);
  for (let n = 1; n <= 40; n++) assert.equal(p.plays.filter(x => x.n === n).length, 1);
  assert.equal(p.plays.length, 43);
});

test('plan: a new sentence costs three plays, so its returns always fit in the target', () => {
  assert.equal(cost(item(1, 'new')), 3 * cost(item(1)));
  const p = planSession([item(1, 'new'), item(2, 'new'), item(3, 'new')], 2);       // 120 s: room for two (3 x 19.1 each)
  assert.deepEqual(p.plays.map(x => x.n).sort(), [1, 1, 1, 2, 2, 2]);
  assert.ok(p.seconds <= 120);
});

test('plan: returns of new sentences near the end are kept, in order, after the last sentence', () => {
  const items = [...Array.from({ length: 3 }, (_, i) => item(i + 1)), item(9, 'new')];
  const p = planSession(items, 30);
  assert.deepEqual(p.plays.map(x => x.n), [1, 2, 3, 9, 9, 9]);
});

test('plan: with little to play it is shorter than the target and says so by its length', () => {
  const p = planSession([item(1), item(2)], 15);
  assert.equal(p.plays.length, 2); near(p.seconds, 2 * playSeconds(item(1)));
  assert.deepEqual(planSession([], 15), { plays: [], seconds: 0 });
});

test('plan: an item too long for what is left is skipped so a shorter one can still fit', () => {
  const p = planSession([item(1, 'review', 2, 3), item(2, 'review', 30, 30), item(3, 'review', 2, 3)], 1);   // 60 s
  assert.deepEqual(p.plays.map(x => x.n), [1, 3]);
});

test('plan: same inputs give the same plan', () => {
  const items = Array.from({ length: 60 }, (_, i) => item(i + 1, i % 6 === 0 ? 'new' : 'review', 1 + (i % 4), 2 + (i % 3)));
  assert.equal(JSON.stringify(planSession(items, 15, 1.5)), JSON.stringify(planSession(items, 15, 1.5)));
});

test('the whole path from a deck to a plan leaves every card exactly as it was', () => {
  const d = queueDeck(), before = JSON.stringify(d);
  const q = E.queue(d, pack, now, cfg), items = mix(q).map(o => ({ ...o, en: 2, vi: 3 }));
  planSession(items, 15);
  assert.equal(JSON.stringify(d), before);
});

// ---------------------------------------------------------------- render (the audio file)

const clips = { 1: { en: Int16Array.of(1, 2, 3), vi: Int16Array.of(4, 5) }, 2: { en: Int16Array.of(6), vi: Int16Array.of(7, 8, 9, 10) } };
const samples = buf => Array.from(new Int16Array(buf, 44));

test('render: English, pause, Vietnamese, pause, Vietnamese, pause, in the planned order, as a WAV file', () => {
  const rate = 10, buf = render([{ n: 1 }], n => clips[n], 1, rate);
  // English 3 samples; pauses for a 0.2 s Vietnamese clip: 1.5 s = 15, 1.04 s = 10, 1.0 s = 10 samples
  assert.deepEqual(samples(buf), [1, 2, 3, ...Array(15).fill(0), 4, 5, ...Array(10).fill(0), 4, 5, ...Array(10).fill(0)]);
  const v = new DataView(buf), tag = o => String.fromCharCode(...new Uint8Array(buf, o, 4));
  assert.deepEqual([tag(0), tag(8), tag(12), tag(36)], ['RIFF', 'WAVE', 'fmt ', 'data']);
  assert.deepEqual([v.getUint32(4, true), v.getUint16(20, true), v.getUint16(22, true), v.getUint32(24, true), v.getUint32(28, true), v.getUint16(32, true), v.getUint16(34, true), v.getUint32(40, true)],
    [36 + 84, 1, 1, 10, 20, 2, 16, 84]);
  assert.equal(buf.byteLength, 44 + 84);
});

test('render: two plays follow each other and the pause setting lengthens the silences', () => {
  const rate = 10, one = render([{ n: 1 }], n => clips[n], 1, rate), both = render([{ n: 1 }, { n: 2 }], n => clips[n], 1, rate);
  assert.deepEqual(samples(both).slice(0, 42), samples(one));
  assert.equal(samples(both)[42], 6);
  assert.ok(render([{ n: 1 }], n => clips[n], 2, rate).byteLength > one.byteLength);
});

test('render: the file is as long as the plan said (at the real clip rate)', () => {
  const mk = s => new Int16Array(Math.round(s * RATE)), c = { 1: { en: mk(2.1), vi: mk(3.3) }, 2: { en: mk(1.7), vi: mk(2.4) } };
  const its = [1, 2, 1, 2, 2].map(n => ({ n, kind: 'review', en: c[n].en.length / RATE, vi: c[n].vi.length / RATE }));
  const p = planSession(its, 30), buf = render(p.plays, n => c[n], 1, RATE);
  near((buf.byteLength - 44) / 2 / RATE, p.seconds, 0.01);
});

test('toInt16 clamps and rounds', () => {
  assert.deepEqual(Array.from(toInt16(Float32Array.of(0, 1, -1, 2, -2, 0.5))), [0, 32767, -32767, 32767, -32767, 16384]);
});

// ---------------------------------------------------------------- tomorrow's clock and saved choices

test('nextDay: just after the next 4 a.m., whatever the time now', () => {
  const at = (...a) => new Date(2026, 10, ...a).getTime();
  assert.equal(nextDay(new Date(2026, 10, 9, 21)).getTime(), at(10, 4, 1));
  assert.equal(nextDay(new Date(2026, 10, 9, 2)).getTime(), at(9, 4, 1));
  assert.equal(nextDay(new Date(2026, 10, 9, 4, 0, 30)).getTime(), at(10, 4, 1));
  assert.equal(nextDay(new Date(2026, 10, 9, 4)).getTime(), at(10, 4, 1));          // exactly 4:00:00 is already the new day
});

test('saved choices: only the allowed lengths and pause settings are accepted, one at a time', () => {
  assert.deepEqual(cleanPrefs({ minutes: 20, scale: 1.5 }), { minutes: 20, scale: 1.5 });
  assert.deepEqual(cleanPrefs({ minutes: 17, scale: 1.5 }), { minutes: 15, scale: 1.5 });
  assert.deepEqual(cleanPrefs({ minutes: 5, scale: 3 }), { minutes: 5, scale: 1 });
  assert.deepEqual(cleanPrefs(null), { minutes: 15, scale: 1 });
  assert.deepEqual(cleanPrefs('x'), { minutes: 15, scale: 1 });
});

test('file name: date of the plan\'s clock and the real length in minutes', () => {
  assert.equal(sessionName(new Date(2026, 10, 10, 4, 1), 899.4), 'vi-session-2026-11-10-15min.wav');
  assert.equal(sessionName(new Date(2026, 0, 5), 10), 'vi-session-2026-01-05-1min.wav');
});
