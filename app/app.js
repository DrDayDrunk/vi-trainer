import { createEngine, emptyDeck } from './engine.js';
import { validatePack } from './pack.js';
import { openDb, savePack, getSentence, allNumbers } from './store.js';

const $ = id => document.getElementById(id);
const E = createEngine(window.FSRS);
const player = new Audio();
let db, numbers = [], at = 0, current = null, blobUrl = null;

const say = (text, bad = false) => { $('msg').textContent = text; $('msg').className = bad ? 'error' : ''; };

// The sentence on screen is held in memory so that a tap can start its sound immediately.
// (iPhones only allow sound that starts straight from a tap, not after waiting for storage.)
async function showSentence() {
  current = await getSentence(db, numbers[at]);
  $('num').textContent = '#' + current.number;
  $('vi').textContent = current.vi_text;
  $('en').textContent = current.en_text;
}

async function refresh() {
  numbers = await allNumbers(db);
  at = Math.min(at, Math.max(0, numbers.length - 1));
  const c = E.counts(emptyDeck(), numbers, new Date());     // real progress arrives in the next stage
  $('c-new').textContent = c.new; $('c-learning').textContent = c.learning; $('c-review').textContent = c.review;
  $('status').textContent = numbers.length
    ? numbers.length + ' sentences on this phone (' + numbers[0] + ' to ' + numbers[numbers.length - 1] + ').'
    : 'No sentences on this phone yet. Tap Import sentences.';
  $('preview').hidden = !numbers.length;
  if (numbers.length) await showSentence();
}

function play(kind) {
  if (!current) return;
  try {
    player.pause();
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    blobUrl = URL.createObjectURL(new Blob([current[kind + '_audio']], { type: 'audio/mp4' }));
    player.src = blobUrl;
    player.play().catch(() => say('The sound could not play. Tap the button again.', true));
  } catch { say('The sound could not play. Tap the button again.', true); }
}

async function importFile(file) {
  say('Checking the file...');
  let json;
  try { json = JSON.parse(await file.text()); }
  catch { throw new Error('This is not a valid sentence pack: the file could not be read. Nothing was changed.'); }
  const sentences = validatePack(json);                     // refuses anything wrong before anything is stored
  try { await savePack(db, sentences); }
  catch { throw new Error('The phone could not store the sentences, so nothing was changed. Free up some space and try again.'); }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  await refresh();
  say('Imported sentences ' + sentences[0].number + ' to ' + sentences[sentences.length - 1].number + '.');
}

$('pick').onclick = () => $('file').click();
$('file').onchange = async e => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  try { await importFile(file); }
  catch (err) { say(/Nothing was changed/.test(err.message) ? err.message : 'Something went wrong. Nothing was changed.', true); }
};
$('pe').onclick = () => play('en');
$('pv').onclick = () => play('vi');
$('prev').onclick = async () => { at = (at + numbers.length - 1) % numbers.length; await showSentence(); };
$('next').onclick = async () => { at = (at + 1) % numbers.length; await showSentence(); };

(async () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  try { db = await openDb(); await refresh(); }
  catch { $('status').textContent = ''; say('This phone would not open the app storage. Close the app and open it again.', true); }
})();
