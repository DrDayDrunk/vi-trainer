import { createEngine } from './engine.js';
import { validatePack } from './pack.js';
import { openDb, savePack, getSentence, allNumbers, loadDeck, saveDeck } from './store.js';

const $ = id => document.getElementById(id);
const E = createEngine(window.FSRS);
const player = new Audio();
let db, deck, numbers = [], card = null, blobUrl = null, busy = false;

const say = (el, text, bad = false) => { el.textContent = text; el.className = bad ? 'error' : ''; };
const clock = d => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const kindOf = n => { const c = deck.cards[n]; return !c ? 'new' : c.state === window.FSRS.State.Review ? 'review' : 'learning'; };
const KIND = { new: 'New', learning: 'Learning', review: 'Review' };

// ---------------------------------------------------------------- home

function showHome() {
  const now = new Date(), c = E.counts(deck, numbers, now), nx = E.next(deck, numbers, now);
  $('c-new').textContent = c.new; $('c-learning').textContent = c.learning; $('c-review').textContent = c.review;
  $('status').textContent = numbers.length
    ? numbers.length + ' sentences on this phone (' + numbers[0] + ' to ' + numbers[numbers.length - 1] + ').'
    : 'No sentences on this phone yet. Tap Import sentences.';
  const ready = nx && nx.n !== undefined;
  $('study').disabled = !ready;
  $('study').textContent = ready ? 'Start studying' : nx ? 'Next card at ' + clock(nx.wait) : 'Nothing to study yet';
  $('review').hidden = true; $('home').hidden = false;
}

async function refresh() { numbers = await allNumbers(db); showHome(); }

// ---------------------------------------------------------------- sound

// The sound starts straight from a tap whenever the sentence is already in memory (iPhones require that).
function play(kind) {
  if (!card) return;
  try {
    player.pause();
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    blobUrl = URL.createObjectURL(new Blob([card.s[kind + '_audio']], { type: 'audio/mp4' }));
    player.src = blobUrl;
    player.play().then(() => say($('rmsg'), ''), () => say($('rmsg'), 'Tap the ' + (kind === 'en' ? 'English' : 'Vietnamese') + ' button to hear it.'));
  } catch { say($('rmsg'), 'The sound could not play. Tap the button again.', true); }
}

// ---------------------------------------------------------------- review

function render() {
  const now = new Date(), c = E.counts(deck, numbers, now), done = !card;
  $('left').textContent = 'New ' + c.new + '  Learning ' + c.learning + '  Due ' + c.review;
  $('card').hidden = done; $('done').hidden = !done;
  $('reveal').hidden = done || card.revealed; $('grades').hidden = done || !card.revealed;
  $('undo').disabled = !deck.last || busy;
  $('review').classList.toggle('revealed', !done && card.revealed);
  if (done) return;
  $('kind').textContent = KIND[card.kind]; $('num').textContent = '#' + card.n;
  $('en').textContent = card.s.en_text; $('vi').textContent = card.s.vi_text;
  $('vi').hidden = $('pv').hidden = !card.revealed;
  if (card.revealed) E.preview(deck.cards[card.n] || null, now).forEach(p => { $('t' + p.rating).textContent = p.label; });
}

async function showCard(forced) {
  const nx = forced || E.next(deck, numbers, new Date());
  if (!nx || nx.n === undefined) {
    card = null;
    $('done-text').textContent = nx ? 'Nothing more right now. The next card is due at ' + clock(nx.wait) + '.' : 'You have finished for now.';
    return render();
  }
  const s = await getSentence(db, nx.n);
  if (!s) { card = null; $('done-text').textContent = 'Sentence ' + nx.n + ' is missing from this phone. Import its pack from the home screen.'; return render(); }
  card = { n: nx.n, kind: nx.kind, s, revealed: false };
  say($('rmsg'), ''); render(); play('en');
}

function reveal() { card.revealed = true; render(); play('vi'); }

// A grade is saved before the next card appears; if saving fails the grade is not counted and nothing moves.
async function change(fn, forced) {
  if (busy) return;
  busy = true; $('undo').disabled = true;
  try {
    const next = fn(); await saveDeck(db, next); deck = next;
    try { await showCard(forced && forced()); }
    catch { say($('rmsg'), 'Your grade was saved, but the next card could not be shown. Go back to Home and start again.', true); }
  } catch { say($('rmsg'), 'That could not be saved, so it was not counted. Try again.', true); }
  finally { busy = false; render(); }
}
const grade = g => change(() => E.review(deck, card.n, g, new Date()));
const undo = () => { const n = deck.last && deck.last.n; if (n) change(() => E.undo(deck), () => ({ n, kind: kindOf(n) })); };
// For undo, kindOf is read after the undo is saved, so it sees the restored card.

// ---------------------------------------------------------------- import

async function importFile(file) {
  say($('msg'), 'Checking the file...');
  let json;
  try { json = JSON.parse(await file.text()); }
  catch { throw new Error('This is not a valid sentence pack: the file could not be read. Nothing was changed.'); }
  const sentences = validatePack(json);                     // refuses anything wrong before anything is stored
  try { await savePack(db, sentences); }
  catch { throw new Error('The phone could not store the sentences, so nothing was changed. Free up some space and try again.'); }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  await refresh();
  say($('msg'), 'Imported sentences ' + sentences[0].number + ' to ' + sentences[sentences.length - 1].number + '.');
}

$('pick').onclick = () => $('file').click();
$('file').onchange = async e => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  try { await importFile(file); }
  catch (err) { say($('msg'), /Nothing was changed/.test(err.message) ? err.message : 'Something went wrong. Nothing was changed.', true); }
};
$('study').onclick = async () => { $('home').hidden = true; $('review').hidden = false; await showCard(); };
$('back').onclick = () => { player.pause(); showHome(); };
$('reveal').onclick = reveal;
$('pe').onclick = () => play('en');
$('pv').onclick = () => play('vi');
$('undo').onclick = undo;
document.querySelectorAll('.grade').forEach(b => { b.onclick = () => grade(+b.dataset.g); });

(async () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  try { db = await openDb(); deck = await loadDeck(db); await refresh(); }
  catch (err) {
    // If progress cannot be read the app stops, so it can never start from empty and save over it.
    $('status').textContent = ''; $('study').disabled = $('pick').disabled = true;
    say($('msg'), /progress/.test(err.message) ? 'Your saved progress could not be read, so the app has stopped to protect it. Nothing was changed. Close the app and open it again.'
      : 'This phone would not open the app storage. Close the app and open it again.', true);
  }
})();
