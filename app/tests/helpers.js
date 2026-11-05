// Shared by the backup and store tests: a deck made by the real engine, so tests use real card shapes.
import { readFileSync } from 'node:fs';
import { createEngine, emptyDeck } from '../engine.js';

(0, eval)(readFileSync(new URL('../vendor/ts-fsrs.umd.js', import.meta.url), 'utf8'));   // sets globalThis.FSRS
export const E = createEngine(globalThis.FSRS);

// Card 1 ends relearning, 2 is a review (Easy), 3 is learning (Again), 4 is learning (Hard), 5 is a review (Good, Good).
export function realDeck(t = new Date(2026, 10, 3, 10)) {
  const at = ms => new Date(t.getTime() + ms), min = 60000, day = 86400000;
  let d = emptyDeck();
  for (const [n, g, ms] of [[1, 1, 0], [1, 3, 2 * min], [1, 3, 60 * min], [1, 1, 3 * day], [2, 4, 0], [3, 1, 0], [4, 2, 0], [5, 3, 0], [5, 3, 12 * min]])
    d = E.review(d, n, g, at(ms));
  return d;
}
