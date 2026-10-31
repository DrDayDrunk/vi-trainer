// Checks a pack file (made by the Mac tool) before anything is stored. Returns the 50 sentences with
// audio as bytes, or throws a plain-language message. Nothing is stored here, so a refusal changes nothing.
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function fail(why) { throw new Error('This is not a valid sentence pack: ' + why + ' Nothing was changed.'); }

function clip(s, key) {
  const text = s[key];
  if (typeof text !== 'string' || !text || text.length % 4 || !BASE64.test(text)) fail('sentence ' + s.number + ' has a damaged ' + key.replace('_', ' ') + '.');
  const bytes = Uint8Array.from(atob(text), c => c.charCodeAt(0));
  const isM4a = bytes.length > 100 && String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp';
  if (!isM4a) fail('sentence ' + s.number + ' has ' + key.replace('_', ' ') + ' that is not a sound clip.');
  return bytes.buffer;
}

export function validatePack(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) fail('the file is not a pack.');
  if (b.format !== 'vi-trainer-bundle' || b.version !== 1) fail('wrong file type or version.');
  if (![1, 2, 3].includes(b.level) || !Number.isInteger(b.track) || b.track < 1 || b.track > 20) fail('level or track is wrong.');
  if (b.count !== 50 || !Array.isArray(b.sentences) || b.sentences.length !== 50) fail('it does not hold exactly 50 sentences.');
  if (b.audio_type !== 'audio/mp4') fail('the sound clips are not in the expected format.');
  const base = (b.level - 1) * 1000 + (b.track - 1) * 50;
  return b.sentences.map((s, i) => {
    if (!s || typeof s !== 'object') fail('sentence ' + (base + i + 1) + ' is missing.');
    if (s.number !== base + i + 1 || s.level !== b.level || s.track !== b.track) fail('sentence ' + (base + i + 1) + ' has the wrong number.');
    const text = k => {
      if (typeof s[k] !== 'string' || !s[k].trim()) fail('sentence ' + s.number + ' has no ' + k.replace('_', ' ') + '.');
      return s[k].normalize('NFC').trim();
    };
    return { number: s.number, level: s.level, track: s.track, en_text: text('en_text'), vi_text: text('vi_text'),
      en_audio: clip(s, 'en_audio'), vi_audio: clip(s, 'vi_audio') };
  });
}
