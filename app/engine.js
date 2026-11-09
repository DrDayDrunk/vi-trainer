// Study engine: pure logic, no audio, no screen, no clock of its own (every function is given `now`).
// deck = { cards: { [sentenceNumber]: card }, last: { n, prev } | null, today?: { day, intro: [numbers], extra } }.
// A sentence with no card is new. `today` is the study day's own record: which new sentences were introduced, and how many
// extra ones "learn more" added. It is saved with each grade, resets at the 4 a.m. rollover, and is not part of a backup.
// Cards are plain JSON (dates as ISO strings), so a deck can be stored and loaded as it is.
const LEARN_AHEAD_MS = 20 * 60000;     // when nothing else is left, show a learning card up to 20 min early (as Anki does)
const GRADES = [1, 2, 3, 4];           // Again, Hard, Good, Easy
const LAST = 3000;                     // the course has sentences 1-3000
export const MORE = 5;                 // new sentences added by one tap of "learn more"

const fmt = ms => {
  const m = ms / 60000, h = m / 60, d = h / 24, r = x => x.toFixed(1).replace(/\.0$/, '');
  return m < 1 ? '<1 min' : m < 60 ? Math.round(m) + ' min' : h < 24 ? Math.round(h) + ' h'
    : d < 30 ? Math.round(d) + ' d' : d < 365 ? r(d / 30) + ' mo' : r(d / 365) + ' y';
};

export const emptyDeck = () => ({ cards: {}, last: null });

export function createEngine(FSRS, { retention = 0.9 } = {}) {
  const { State } = FSRS;
  // Fuzz is off so results are repeatable (see ponytail debt).
  const f = FSRS.fsrs({ request_retention: retention, enable_fuzz: false, enable_short_term: true,
    learning_steps: ['1m', '10m'], relearning_steps: ['10m'] });
  const toCard = c => ({ ...c, due: new Date(c.due), last_review: c.last_review ? new Date(c.last_review) : undefined });
  const fromCard = c => ({ ...c, due: c.due.toISOString(), last_review: c.last_review ? c.last_review.toISOString() : null });
  const run = (card, now) => f.repeat(card ? toCard(card) : FSRS.createEmptyCard(now), now);
  const isLearning = c => c.state === State.Learning || c.state === State.Relearning;
  const due = c => new Date(c.due);
  const byDue = (a, b) => due(a[1]) - due(b[1]);

  // The study day ends at the next 4 a.m. local time.
  const endOfStudyDay = now => {
    const d = new Date(now); d.setHours(4, 0, 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    return d;
  };

  const dayKey = now => endOfStudyDay(now).toISOString();
  // Today's record, or a fresh one if the saved one is from another study day or unreadable.
  const todayOf = (deck, now) => {
    const t = deck.today, k = dayKey(now);
    return t && t.day === k && Array.isArray(t.intro) && Number.isInteger(t.extra) && t.extra >= 0 ? t : { day: k, intro: [], extra: 0 };
  };

  // New sentences. Strictly course order, starting at cfg.startAt, or at the lowest studied sentence if none was set.
  // Returns { start, pos, onPhone, upcoming, more, intro }: start = where the course begins for this learner, pos = next new sentence (null when all 3000 have cards), onPhone = whether
  // it is on the phone (new cards stop at a sentence that is missing, they never jump over it), upcoming = the ones still
  // to come today (at most today's allowance), more = whether another one exists beyond those, intro = introduced today.
  function plan(deck, pack, now, { newPerDay = 10, startAt = null } = {}) {
    const t = todayOf(deck, now), have = new Set(pack), nums = Object.keys(deck.cards).map(Number);
    const allowed = Math.max(0, newPerDay + t.extra - t.intro.length), upcoming = [];
    const start = startAt ?? (nums.length ? Math.min(...nums) : 1);
    let pos = null, more = false;
    for (let n = start; n <= LAST; n++) {
      if (n in deck.cards) continue;
      if (pos === null) pos = n;
      if (!have.has(n)) break;
      if (upcoming.length < allowed) upcoming.push(n); else { more = true; break; }
    }
    return { start, pos, onPhone: pos !== null && have.has(pos), upcoming, more, intro: t.intro };
  }

  // "Learn more": a few extra new sentences for today only. Changes no card.
  const learnMore = (deck, now, n = MORE) => { const t = todayOf(deck, now); return { ...deck, today: { ...t, extra: t.extra + n } }; };

  // What each grade would give, shown before choosing: [{ rating, label }].
  const preview = (card, now) => { const r = run(card, now); return GRADES.map(g => ({ rating: g, label: fmt(r[g].card.due - now) })); };

  function review(deck, n, rating, now) {
    if (!Number.isInteger(n) || !GRADES.includes(rating)) throw new Error('Bad card number or grade.');
    const prev = deck.cards[n] ?? null, t = todayOf(deck, now);
    return { cards: { ...deck.cards, [n]: fromCard(run(prev, now)[rating].card) }, last: { n, prev },
      today: prev ? t : { ...t, intro: [...t.intro, n] } };      // a new sentence's first grade uses one of today's places
  }

  // Reverses the most recent grade only.
  function undo(deck) {
    if (!deck.last) return deck;
    const cards = { ...deck.cards }, { n, prev } = deck.last;
    if (prev) cards[n] = prev; else delete cards[n];
    const t = deck.today;
    return { cards, last: null, ...(t && { today: prev ? t : { ...t, intro: (t.intro || []).filter(x => x !== n) } }) };
  }

  // The next card to show: { n, kind }, or { wait: Date } if only later learning cards remain, or null.
  // Order: learning cards due now, reviews due today (most overdue first), new cards in course order, then learn-ahead.
  function next(deck, pack, now, cfg) {
    const all = Object.entries(deck.cards).map(([n, c]) => [+n, c]);
    const learning = all.filter(([, c]) => isLearning(c)).sort(byDue);
    const ready = learning.find(([, c]) => due(c) <= now);
    if (ready) return { n: ready[0], kind: 'learning' };
    const end = endOfStudyDay(now);
    const rev = all.filter(([, c]) => c.state === State.Review && due(c) < end).sort(byDue)[0];
    if (rev) return { n: rev[0], kind: 'review' };
    const fresh = plan(deck, pack, now, cfg).upcoming[0];
    if (fresh !== undefined) return { n: fresh, kind: 'new' };
    if (!learning.length) return null;
    const [n, c] = learning[0];
    return due(c) - now <= LEARN_AHEAD_MS ? { n, kind: 'learning' } : { wait: due(c) };
  }

  function counts(deck, pack, now, cfg) {
    const cards = Object.values(deck.cards), end = endOfStudyDay(now);
    return {
      new: plan(deck, pack, now, cfg).upcoming.length,
      learning: cards.filter(isLearning).length,
      review: cards.filter(c => c.state === State.Review && due(c) < end).length,
    };
  }

  // Read-along set: today's new sentences, those introduced today plus those still to come today, in course order.
  // The set stays the same through the day as sentences get introduced. Read-only.
  function readAlong(deck, pack, now, cfg) {
    const p = plan(deck, pack, now, cfg), have = new Set(pack);
    return [...new Set([...p.intro.filter(n => have.has(n)), ...p.upcoming])].sort((a, b) => a - b);
  }

  return { preview, review, undo, next, counts, readAlong, plan, learnMore };
}
