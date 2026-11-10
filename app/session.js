// Hands-free session: pure logic, no audio device and no screen (ticket 06). It only reads what it is given and
// returns a plan or a WAV file, so it cannot change any card. Times are in seconds.
export const RATE = 24000;                   // the clips' own sample rate; the session file uses it too
export const RETURNS = [5, 15];              // a new sentence comes back this many sentences after its first play, then again
export const MINUTES = [5, 10, 15, 20, 30];
export const SCALES = [0.75, 1, 1.5, 2];     // pause length: shorter, normal, longer, much longer
const DEFAULT_PREFS = { minutes: 15, scale: 1 };

// Saved choices (kept on this phone only, not in the backup). Anything not allowed becomes the default, one at a time.
export function cleanPrefs(p) {
  const o = p && typeof p === 'object' ? p : {};
  return { minutes: MINUTES.includes(o.minutes) ? o.minutes : DEFAULT_PREFS.minutes, scale: SCALES.includes(o.scale) ? o.scale : DEFAULT_PREFS.scale };
}

// "Tomorrow": the clock set just after the next 4 a.m., so the engine sees the next study day.
export function nextDay(now) {
  const d = new Date(now); d.setHours(4, 0, 0, 0);
  if (d <= now) d.setDate(d.getDate() + 1);
  return new Date(d.getTime() + 60000);
}

// One list, new sentences spread evenly among the due ones (learning first, then reviews, as the engine ordered them).
export function mix({ learning, review, fresh }) {
  const old = [...learning.map(n => ({ n, kind: 'learning' })), ...review.map(n => ({ n, kind: 'review' }))];
  const total = old.length + fresh.length, slot = new Set(fresh.map((_, i) => Math.floor((i + 0.5) * total / fresh.length)));
  let o = 0, f = 0;
  return Array.from({ length: total }, (_, i) => slot.has(i) ? { n: fresh[f++], kind: 'new' } : old[o++]);
}

// Pause rule from the prototype: after the English, after the first Vietnamese, after the second. k scales all three.
export const pauses = (vi, k = 1) => [(1.2 + 1.5 * vi) * k, (0.8 + 1.2 * vi) * k, k];
export const playSeconds = ({ en, vi }, k = 1) => en + 2 * vi + pauses(vi, k).reduce((a, b) => a + b);
// A new sentence plays three times in the session (first play and two returns), so it costs three plays of the budget.
export const cost = (it, k = 1) => playSeconds(it, k) * (it.kind === 'new' ? 3 : 1);

// items: [{ n, kind, en, vi }] in mixed order, with clip lengths. Takes items in order while they fit the target
// (one that does not fit is skipped so a shorter one can still use the time), then places each new sentence's returns.
// Returns { plays: [{ n, kind, ret }], seconds }. No randomness: the same inputs always give the same plan.
export function planSession(items, minutes, k = 1) {
  let used = 0;
  const picked = items.filter(it => { const c = cost(it, k); if (used + c > minutes * 60) return false; used += c; return true; });
  const out = [], later = [];
  const flush = () => { for (let i; (i = later.findIndex(x => x.at <= out.length)) >= 0;) out.push(later.splice(i, 1)[0].play); };
  for (const it of picked) {
    flush(); out.push({ n: it.n, kind: it.kind, ret: 0 });
    if (it.kind === 'new') RETURNS.forEach((d, r) => later.push({ at: out.length - 1 + d, play: { n: it.n, kind: it.kind, ret: r + 1 } }));
  }
  // ponytail: returns still waiting when the items run out follow the last sentence in order, a little sooner than planned
  later.sort((a, b) => a.at - b.at).forEach(x => out.push(x.play));
  return { plays: out, seconds: used };
}

export const toInt16 = f32 => Int16Array.from(f32, x => Math.round(Math.max(-1, Math.min(1, x)) * 32767));

// Stitches the plan into one WAV file (mono, 16-bit). clip(n) gives { en, vi } as Int16Array samples at `rate`.
export function render(plays, clip, k = 1, rate = RATE) {
  const gaps = c => pauses(c.vi.length / rate, k).map(s => Math.round(s * rate));
  const total = plays.reduce((sum, p) => { const c = clip(p.n); return sum + c.en.length + 2 * c.vi.length + gaps(c).reduce((a, b) => a + b); }, 0);
  const buf = new ArrayBuffer(44 + 2 * total), v = new DataView(buf), pcm = new Int16Array(buf, 44);
  const text = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  text(0, 'RIFF'); v.setUint32(4, 36 + 2 * total, true); text(8, 'WAVEfmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); text(36, 'data'); v.setUint32(40, 2 * total, true);
  let at = 0;
  for (const p of plays) {
    const c = clip(p.n), [a, b, d] = gaps(c);
    pcm.set(c.en, at); at += c.en.length + a;
    pcm.set(c.vi, at); at += c.vi.length + b;
    pcm.set(c.vi, at); at += c.vi.length + d;
  }
  return buf;
}

// vi-session-2026-11-10-15min.wav: the date of the clock the plan used, and the real length in whole minutes.
export const sessionName = (d, seconds) => 'vi-session-' + d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + '-' + Math.max(1, Math.round(seconds / 60)) + 'min.wav';
