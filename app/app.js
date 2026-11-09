import { createEngine, MORE } from './engine.js';
import { validatePack } from './pack.js';
import { openDb, savePack, getSentence, allNumbers, loadDeck, saveDeck, replaceDeck, loadSettings, saveSettings } from './store.js';
import { makeBackup, backupName, readBackup, newest, refusal, reminder } from './backup.js';

const $ = id => document.getElementById(id);
const player = new Audio();
let E, db, deck, settings, numbers = [], card = null, blobUrl = null, busy = false, pending = null;
// The engine is made again whenever the target retention changes. cfg() is what the engine needs from the settings.
const useSettings = s => { if (!settings || s.retention !== settings.retention) E = createEngine(window.FSRS, { retention: s.retention }); settings = s; };
const cfg = () => ({ newPerDay: settings.newPerDay, startAt: settings.startAt });

const say = (el, text, bad = false) => { el.textContent = text; el.className = bad ? 'error' : ''; };
const clock = d => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const kindOf = n => { const c = deck.cards[n]; return !c ? 'new' : c.state === window.FSRS.State.Review ? 'review' : 'learning'; };
const KIND = { new: 'New', learning: 'Learning', review: 'Review' };
const count = cards => Object.keys(cards).length;
const when = iso => new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

// ---------------------------------------------------------------- home

function showHome() {
  const now = new Date(), c = E.counts(deck, numbers, now, cfg()), nx = E.next(deck, numbers, now, cfg()), p = E.plan(deck, numbers, now, cfg());
  $('c-new').textContent = c.new; $('c-learning').textContent = c.learning; $('c-review').textContent = c.review;
  $('status').textContent = numbers.length
    ? numbers.length + ' sentences on this phone (' + numbers[0] + ' to ' + numbers[numbers.length - 1] + ').'
    : 'No sentences on this phone yet. Tap Import sentences.';
  $('next-new').textContent = !numbers.length ? '' : p.pos === null ? 'All 3000 sentences have been started.'
    : !p.onPhone ? 'Next new sentence: ' + p.pos + ', which is not on this phone yet. Import it, or change the starting sentence in Settings.'
    : 'Next new sentence: ' + p.pos + '.' + (c.new ? '' : ' Today\'s new sentences are done.');
  $('learn-more').disabled = !p.more; $('learn-more').textContent = 'Learn more (+' + MORE + ' new sentences)';
  const ready = nx && nx.n !== undefined;
  $('study').disabled = !ready;
  $('study').textContent = ready ? 'Start studying' : nx ? 'Next card at ' + clock(nx.wait) : 'Nothing to study yet';
  const r = reminder(settings, count(deck.cards), now);
  $('nudge').hidden = !r; $('nudge-text').textContent = r || '';
  const al = E.readAlong(deck, numbers, now, cfg());
  $('to-along').disabled = !al.length;
  $('to-along').textContent = al.length || !numbers.length ? 'Read along' : 'Read along (no new sentences today)';
  $('review').hidden = $('backup').hidden = $('along').hidden = $('settings').hidden = true; $('home').hidden = false;
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
  const now = new Date(), c = E.counts(deck, numbers, now, cfg()), done = !card;
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
  const nx = forced || E.next(deck, numbers, new Date(), cfg());
  if (!nx || nx.n === undefined) {
    card = null;
    $('done-text').textContent = nx ? 'Nothing more right now. The next card is due at ' + clock(nx.wait) + '.'
      : 'You have finished for now.' + (E.plan(deck, numbers, new Date(), cfg()).more ? ' For more new sentences, go to Home and tap Learn more.' : '');
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

// ---------------------------------------------------------------- backup

function showBackupInfo() {
  const n = count(deck.cards);
  $('bk-last').textContent = !n ? 'Nothing to back up yet. Study some cards first.' : settings.lastBackup ? 'Last backup: ' + when(settings.lastBackup) + '.' : 'You have not backed up yet.';
  $('bk-export').disabled = !n;
}

function showBackup() {
  pending = null; $('bk-confirm').hidden = true; say($('bk-msg1'), ''); say($('bk-msg2'), '');
  showBackupInfo(); $('bk-days').value = settings.backupDays;
  $('home').hidden = true; $('backup').hidden = false;
}

// The share sheet needs to start straight from the tap, so nothing is awaited before it. A JSON file is tried first,
// then the same text as a plain-text file, then a plain download.
async function exportBackup() {
  const out = $('bk-msg1'), now = new Date(), name = backupName(now), n = count(deck.cards);
  const text = JSON.stringify(makeBackup(deck, settings.backupDays, now, { newPerDay: settings.newPerDay, retention: settings.retention, startAt: settings.startAt }));
  const file = navigator.canShare && ['application/json', 'text/plain'].map(type => new File([text], name, { type })).find(f => navigator.canShare({ files: [f] }));
  try {
    if (file) await navigator.share({ files: [file] });
    else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    }
    settings = { ...settings, lastBackup: now.toISOString() };
    await saveSettings(db, settings);
  } catch (err) { return say(out, err.name === 'AbortError' ? 'Not saved. Nothing was changed.' : 'The backup could not be saved. Nothing was changed.', true); }
  showBackupInfo(); say(out, 'Backup of ' + n + ' cards shared. Make sure you chose Save to Files.');
}

// Reads and checks the file; if the phone has no progress it restores at once, otherwise it shows both sides and waits.
async function chooseBackup(file) {
  const out = $('bk-msg2'); pending = null; $('bk-confirm').hidden = true;
  say(out, 'Checking the file...');
  try {
    const b = readBackup(await file.text()), why = refusal(deck.cards, b.cards);
    if (why) throw new Error(why);
    if (!count(deck.cards)) return await restore(b);
    pending = b; say(out, '');
    $('cmp-b').textContent = 'Backup: ' + count(b.cards) + ' cards, newest review ' + when(newest(b.cards)) + '.';
    $('cmp-p').textContent = 'This phone: ' + count(deck.cards) + ' cards, newest review ' + when(newest(deck.cards)) + '.';
    $('bk-confirm').hidden = false;
  } catch (err) { say(out, /Nothing was changed/.test(err.message) ? err.message : 'Something went wrong. Nothing was changed.', true); }
}

// replaceDeck checks the rules again against what is really stored, so a stale screen cannot cause a bad restore.
async function restore(b) {
  try {
    await replaceDeck(db, b.cards, b.backupDays, new Date(), { newPerDay: b.newPerDay, retention: b.retention, startAt: b.startAt });
    deck = await loadDeck(db); useSettings(await loadSettings(db)); pending = null;
    const have = new Set(numbers), missing = Object.keys(deck.cards).filter(n => !have.has(+n)).length;
    showHome();
    say($('msg'), 'Restored ' + count(deck.cards) + ' cards.' + (missing === 1 ? ' 1 card has no sentence on this phone yet. Tap Import sentences to add it.' : missing ? ' ' + missing + ' cards have no sentence on this phone yet. Tap Import sentences to add them.' : ''));
  } catch (err) { say($('bk-msg2'), /Nothing was changed/.test(err.message) ? err.message : 'The restore failed. Nothing was changed.', true); }
}

$('to-backup').onclick = $('nudge-go').onclick = showBackup;
$('bk-back').onclick = showHome;
$('bk-export').onclick = exportBackup;
$('bk-pick').onclick = () => $('bk-file').click();
$('bk-file').onchange = e => { const file = e.target.files[0]; e.target.value = ''; if (file) chooseBackup(file); };
$('bk-yes').onclick = () => { $('bk-confirm').hidden = true; if (pending) restore(pending); };
$('bk-no').onclick = () => { pending = null; $('bk-confirm').hidden = true; say($('bk-msg2'), 'Cancelled. Nothing was changed.'); };
$('bk-days').onchange = async e => {
  const before = settings;
  settings = { ...settings, backupDays: +e.target.value };
  try { await saveSettings(db, settings); } catch { settings = before; e.target.value = before.backupDays; say($('bk-msg1'), 'The reminder setting could not be saved.', true); }
};

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

// ---------------------------------------------------------------- daily plan and settings (ticket 05)

// Learn more: a few extra new sentences for today only. No card changes; only today's record is saved.
$('learn-more').onclick = async () => {
  if (busy) return;
  busy = true;
  try { const next = E.learnMore(deck, new Date()); await saveDeck(db, next); deck = next; showHome(); say($('msg'), MORE + ' extra new sentences added for today.'); }
  catch { say($('msg'), 'That could not be saved. Nothing was changed.', true); }
  finally { busy = false; }
};

function showSettings() {
  const started = count(deck.cards) > 0, p = E.plan(deck, numbers, new Date(), cfg());
  say($('st-msg'), '');
  $('st-new').value = settings.newPerDay; $('st-ret').value = settings.retention;
  $('st-start').hidden = started; $('st-at').value = settings.startAt ?? '';
  $('st-pos').textContent = started ? 'Your course started at sentence ' + p.start + '. It can only be set before your first review.'
    : 'Where the course begins for you. It can only be set before your first review. Until you set it, it begins at sentence 1.';
  $('home').hidden = true; $('settings').hidden = false;
}

// Settings are not progress, but a failed save still says so and puts the old value back.
async function saveSetting(patch, done, undoField) {
  const next = { ...settings, ...patch };
  try { await saveSettings(db, next); useSettings(next); say($('st-msg'), done); }
  catch { undoField(); say($('st-msg'), 'That could not be saved. Nothing was changed.', true); }
}
$('to-settings').onclick = showSettings;
$('st-back').onclick = showHome;
$('st-new').onchange = e => saveSetting({ newPerDay: +e.target.value }, 'Saved. ' + (+e.target.value ? 'Up to ' + e.target.value + ' new sentences a day.' : 'No new sentences, reviews only.'), () => { e.target.value = settings.newPerDay; });
$('st-ret').onchange = e => saveSetting({ retention: +e.target.value }, 'Saved. It applies to grades you give from now on.', () => { e.target.value = settings.retention; });
$('st-at-save').onclick = () => {
  const text = $('st-at').value.trim(), n = Number(text);
  if (count(deck.cards)) return say($('st-msg'), 'The starting sentence can only be set before your first review. Nothing was changed.', true);
  if (!/^\d+$/.test(text) || n < 1 || n > 3000) return say($('st-msg'), 'Type a whole number from 1 to 3000. Nothing was changed.', true);
  saveSetting({ startAt: n }, 'Saved. The course starts at sentence ' + n + '.' + (numbers.includes(n) ? '' : ' That sentence is not on this phone yet. Import its pack from Home.'), () => { $('st-at').value = settings.startAt ?? ''; });
};

// ---------------------------------------------------------------- read-along (ticket 04)
// Shows a sentence's Vietnamese text while its clip plays. It only reads sentences: nothing in this section
// touches the deck, so it cannot change any card's schedule (a test checks this section for that).
const GAP_MS = 1500;                                   // ponytail: fixed pause between repeats, not scaled to the clip length; scale it if long sentences feel rushed
const prefs = { loops: 3, speed: 1, showEn: true };    // kept while the app stays open, forgotten when it is closed
let along = null, run = 0, alUrl = null;               // run goes up on every step, replay and exit, so an older loop stops itself
const sleep = ms => new Promise(ok => setTimeout(ok, ms));
const setSpeed = () => { player.defaultPlaybackRate = player.playbackRate = prefs.speed; };
const showEnglish = () => { $('a-en').hidden = !prefs.showEn; $('a-en-toggle').textContent = prefs.showEn ? 'Hide English' : 'Show English'; };

// Plays the clip prefs.loops times. The first play starts straight from the tap (or from a step, as in review).
async function playLoops(my) {
  const out = $('a-msg');
  player.src = alUrl; setSpeed();                      // loading a clip resets the speed, so it is set after
  player.preservesPitch = player.webkitPreservesPitch = true;   // slower must not change the tones
  for (let k = 1; k <= prefs.loops; k++) {
    say(out, 'Play ' + k + ' of ' + prefs.loops);
    const end = new Promise(ok => { player.onended = player.onerror = ok; });
    try { await player.play(); } catch { if (my === run) say(out, 'Tap Play again to hear it.', true); return; }
    await end;
    if (my !== run) return;
    if (k < prefs.loops) { await sleep(GAP_MS); if (my !== run) return; }
  }
  say(out, along.i === along.set.length - 1 ? 'Last sentence of this set.' : 'Done. Tap Next, or Play again.');
}

async function alShow(i) {
  const my = ++run, n = along.set[i];
  player.pause(); if (alUrl) URL.revokeObjectURL(alUrl); alUrl = null;
  along.i = i;
  $('a-pos').textContent = (i + 1) + ' of ' + along.set.length;
  $('a-prev').disabled = i === 0; $('a-next').disabled = i === along.set.length - 1;
  $('a-num').textContent = 'Sentence ' + n; say($('a-msg'), '');
  let s = null;
  try { s = await getSentence(db, n); } catch { /* shown below */ }
  if (my !== run) return;
  $('a-vi').textContent = s ? s.vi_text : ''; $('a-en').textContent = s ? s.en_text : '';
  if (!s) return say($('a-msg'), 'Sentence ' + n + ' could not be read from this phone.', true);
  alUrl = URL.createObjectURL(new Blob([s.vi_audio], { type: 'audio/mp4' }));
  playLoops(my);
}

function leaveAlong() {
  ++run; player.pause(); player.onended = player.onerror = null;
  player.defaultPlaybackRate = player.playbackRate = 1;           // review must not inherit a slow speed
  if (alUrl) URL.revokeObjectURL(alUrl); alUrl = null;
  showHome();
}

$('to-along').onclick = () => {
  const set = E.readAlong(deck, numbers, new Date(), cfg());
  if (!set.length) return;
  along = { set, i: 0 };
  $('a-loops').value = prefs.loops; $('a-speed').value = prefs.speed; showEnglish();
  $('home').hidden = true; $('along').hidden = false;
  alShow(0);
};
$('a-back').onclick = leaveAlong;
$('a-prev').onclick = () => alShow(along.i - 1);
$('a-next').onclick = () => alShow(along.i + 1);
$('a-again').onclick = () => { if (alUrl) { const my = ++run; player.pause(); playLoops(my); } };
$('a-en-toggle').onclick = () => { prefs.showEn = !prefs.showEn; showEnglish(); };
$('a-loops').onchange = e => { prefs.loops = +e.target.value; };
$('a-speed').onchange = e => { prefs.speed = +e.target.value; setSpeed(); };
// ---------------------------------------------------------------- end of read-along

(async () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  try { db = await openDb(); deck = await loadDeck(db); useSettings(await loadSettings(db)); await refresh(); }
  catch (err) {
    // If progress cannot be read the app stops, so it can never start from empty and save over it.
    $('status').textContent = ''; $('study').disabled = $('pick').disabled = $('to-backup').disabled = $('to-settings').disabled = true;
    say($('msg'), /progress/.test(err.message) ? 'Your saved progress could not be read, so the app has stopped to protect it. Nothing was changed. Close the app and open it again.'
      : 'This phone would not open the app storage. Close the app and open it again.', true);
  }
})();
