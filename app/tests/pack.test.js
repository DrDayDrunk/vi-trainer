import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePack } from '../pack.js';

// Fake but well-formed audio: starts like a real .m4a file (bytes 4-8 spell "ftyp").
const AUDIO = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), Buffer.alloc(400, 7)]).toString('base64');

function bundle(level = 1, track = 1) {
  const base = (level - 1) * 1000 + (track - 1) * 50;
  return {
    format: 'vi-trainer-bundle', version: 1, level, track, count: 50, audio_type: 'audio/mp4',
    sentences: Array.from({ length: 50 }, (_, i) => ({
      number: base + i + 1, level, track, en_text: 'English ' + (i + 1), vi_text: 'Hôm nay trời đẹp ' + (i + 1),
      en_audio: AUDIO, vi_audio: AUDIO,
    })),
  };
}
const refuses = (mutate, level, track) => {
  const b = bundle(level, track); mutate(b);
  assert.throws(() => validatePack(b), /not a valid|Nothing was changed/i);
};

test('a good track 1 bundle gives sentences 1 to 50 with audio as bytes', () => {
  const s = validatePack(bundle());
  assert.deepEqual(s.map(x => x.number), Array.from({ length: 50 }, (_, i) => i + 1));
  assert.ok(s[0].en_audio instanceof ArrayBuffer && s[0].en_audio.byteLength > 400);
  assert.equal(s[0].vi_text, 'Hôm nay trời đẹp 1');
});

test('level 2 track 3 must be numbered 1101 to 1150', () => {
  assert.equal(validatePack(bundle(2, 3))[0].number, 1101);
  refuses(b => { b.sentences.forEach((x, i) => { x.number = i + 1; }); }, 2, 3);   // numbered as if track 1
});

test('tone marks are stored in one standard form so the same sentence is always the same text', () => {
  const b = bundle(); b.sentences[0].vi_text = 'Tôi là người Việt'.normalize('NFD');
  assert.equal(validatePack(b)[0].vi_text, 'Tôi là người Việt'.normalize('NFC'));
});

test('anything that is not a pack is refused', () => {
  for (const x of [null, undefined, 'text', 42, [], {}]) assert.throws(() => validatePack(x), /not a valid/i);
});

test('wrong format, version, level, track, count or audio type is refused', () => {
  refuses(b => { b.format = 'other'; });
  refuses(b => { b.version = 2; });
  refuses(b => { b.level = 4; });
  refuses(b => { b.track = 21; });
  refuses(b => { b.count = 49; });
  refuses(b => { b.audio_type = 'audio/mpeg'; });
});

test('49 or 51 sentences are refused', () => {
  refuses(b => { b.sentences.pop(); });
  refuses(b => { b.sentences.push({ ...b.sentences[0] }); });
});

test('a gap, a repeat, a swap or a number from another track is refused', () => {
  refuses(b => { b.sentences[10].number = 99; });
  refuses(b => { b.sentences[10].number = b.sentences[9].number; });
  refuses(b => { [b.sentences[3], b.sentences[4]] = [b.sentences[4], b.sentences[3]]; });
  refuses(b => { b.sentences[0].track = 2; });
});

test('missing or blank text is refused', () => {
  refuses(b => { b.sentences[5].vi_text = ''; });
  refuses(b => { b.sentences[5].en_text = '   '; });
  refuses(b => { delete b.sentences[5].vi_text; });
  refuses(b => { b.sentences[5].vi_text = 12; });
});

test('missing, damaged or non-audio clips are refused', () => {
  refuses(b => { delete b.sentences[7].en_audio; });
  refuses(b => { b.sentences[7].vi_audio = ''; });
  refuses(b => { b.sentences[7].vi_audio = 'not base64 !!'; });
  refuses(b => { b.sentences[7].en_audio = Buffer.alloc(500, 1).toString('base64'); });   // not an .m4a
  refuses(b => { b.sentences[7].en_audio = Buffer.from('ftyp').toString('base64'); });    // far too short
});

test('the message names the sentence and says nothing was changed', () => {
  const b = bundle(); b.sentences[7].vi_audio = '';
  assert.throws(() => validatePack(b), /sentence 8.*Nothing was changed/is);
});
