// Study engine: pure logic, no audio, no screen, no clock of its own (every function is given `now`).
// deck = { cards: { [sentenceNumber]: card }, last: { n, prev } | null }. A sentence with no card is new.
// Cards are plain JSON (dates as ISO strings), so a deck can be stored and loaded as it is.
const LEARN_AHEAD_MS = 20 * 60000;     // when nothing else is left, show a learning card up to 20 min early (as Anki does)
const GRADES = [1, 2, 3, 4];           // Again, Hard, Good, Easy

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

  // What each grade would give, shown before choosing: [{ rating, label }].
  const preview = (card, now) => { const r = run(card, now); return GRADES.map(g => ({ rating: g, label: fmt(r[g].card.due - now) })); };

  function review(deck, n, rating, now) {
    if (!Number.isInteger(n) || !GRADES.includes(rating)) throw new Error('Bad card number or grade.');
    const prev = deck.cards[n] ?? null;
    return { cards: { ...deck.cards, [n]: fromCard(run(prev, now)[rating].card) }, last: { n, prev } };
  }

  // Reverses the most recent grade only.
  function undo(deck) {
    if (!deck.last) return deck;
    const cards = { ...deck.cards }, { n, prev } = deck.last;
    if (prev) cards[n] = prev; else delete cards[n];
    return { cards, last: null };
  }

  // The next card to show: { n, kind }, or { wait: Date } if only later learning cards remain, or null.
  // Order: learning cards due now, reviews due today (most overdue first), new cards in course order, then learn-ahead.
  function next(deck, pack, now) {
    const all = Object.entries(deck.cards).map(([n, c]) => [+n, c]);
    const learning = all.filter(([, c]) => isLearning(c)).sort(byDue);
    const ready = learning.find(([, c]) => due(c) <= now);
    if (ready) return { n: ready[0], kind: 'learning' };
    const end = endOfStudyDay(now);
    const rev = all.filter(([, c]) => c.state === State.Review && due(c) < end).sort(byDue)[0];
    if (rev) return { n: rev[0], kind: 'review' };
    const fresh = [...pack].sort((a, b) => a - b).find(n => !(n in deck.cards));
    if (fresh !== undefined) return { n: fresh, kind: 'new' };
    if (!learning.length) return null;
    const [n, c] = learning[0];
    return due(c) - now <= LEARN_AHEAD_MS ? { n, kind: 'learning' } : { wait: due(c) };
  }

  function counts(deck, pack, now) {
    const cards = Object.values(deck.cards), end = endOfStudyDay(now);
    return {
      new: pack.filter(n => !(n in deck.cards)).length,
      learning: cards.filter(isLearning).length,
      review: cards.filter(c => c.state === State.Review && due(c) < end).length,
    };
  }

  return { preview, review, undo, next, counts };
}
