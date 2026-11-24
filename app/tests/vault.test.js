// The vault client: the app's only use of the network. Tested against a fake GitHub in memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createVault, PROGRESS } from '../vault.js';
import { fakeGitHub, TOKEN } from './fakegithub.js';

const make = (g, token = TOKEN, o = {}) => createVault(token, g.fetch, { timeout: 200, ...o });
const kind = k => e => e.kind === k;

test('a private vault with a good token checks out', async () => {
  const g = fakeGitHub();
  assert.equal(await make(g).check(), true);
});

test('a public repository is refused', async () => {
  await assert.rejects(make(fakeGitHub({ priv: false })).check(), e => e.kind === 'public' && /PUBLIC/.test(e.message));
});

test('every kind of failure gives a plain message, and none of them contains the token', async () => {
  const cases = [
    ['wrong token', g => make(g, 'github_pat_wrong'), 'auth', /refused the token/],
    ['too many requests', g => (g.status = 429, make(g)), 'limit', /too many requests/i],
    ['no access', g => (g.status = 403, make(g)), 'access', /does not have access/],
    ['GitHub down', g => (g.status = 503, make(g)), 'server', /problem on GitHub/],
    ['no connection', g => (g.offline = true, make(g)), 'network', /Could not reach the vault/],
    ['too slow', g => (g.hang = true, make(g)), 'network', /took too long/],
  ];
  for (const [name, setup, k, re] of cases) {
    const g = fakeGitHub();
    await assert.rejects(setup(g).check(), e => { assert.equal(e.kind, k, name); assert.match(e.message, re, name); assert.ok(!e.message.includes(TOKEN) && !e.message.includes('wrong'), name + ': token leaked'); return true; });
  }
});

test('requests carry the token only in the Authorization header, and pin the API version', async () => {
  const g = fakeGitHub(); g.put('progress/progress.json', '{}');
  const v = make(g); await v.check(); await v.readProgress();
  for (const r of g.requests) {
    assert.equal(r.headers.Authorization, 'Bearer ' + TOKEN);
    assert.equal(r.headers['X-GitHub-Api-Version'], '2022-11-28');
    assert.ok(!r.path.includes('TESTTOKEN') && !(r.body || '').includes('TESTTOKEN'));
  }
});

test('the pack folder lists bundles with their level, track and size, in order, ignoring other files', async () => {
  const g = fakeGitHub();
  g.put('pack/level1-track02.json', 'x'.repeat(2000)); g.put('pack/level1-track01.json', 'y'.repeat(1000));
  g.put('pack/level2-track20.json', 'z'.repeat(500)); g.put('pack/notes.txt', 'hi'); g.put('pack/level4-track01.json', 'no');
  const list = await make(g).listPack();
  assert.deepEqual(list.map(f => [f.name, f.level, f.track, f.size]), [
    ['level1-track01.json', 1, 1, 1000], ['level1-track02.json', 1, 2, 2000], ['level2-track20.json', 2, 20, 500]]);
});

test('a vault with no pack folder yet lists nothing', async () => {
  assert.deepEqual(await make(fakeGitHub()).listPack(), []);
});

test('a pack file is read exactly, and a missing one is a clear error', async () => {
  const g = fakeGitHub(), text = JSON.stringify({ vi: 'Hôm nay trời đẹp' });
  g.put('pack/level1-track01.json', text);
  assert.equal(await make(g).readPack('level1-track01.json'), text);
  await assert.rejects(make(g).readPack('level1-track09.json'), e => e.kind === 'missing' && /level1-track09.json/.test(e.message));
});

test('no progress in the vault yet reads as null', async () => {
  assert.equal(await make(fakeGitHub()).readProgress(), null);
});

test('progress is created, read back with its id, updated, and an update with an old id is a conflict', async () => {
  const g = fakeGitHub(), v = make(g);
  await v.writeProgress('{"a":1}', undefined);
  const first = await v.readProgress();
  assert.equal(first.text, '{"a":1}');
  await v.writeProgress('{"a":2}', first.sha);
  assert.equal((await v.readProgress()).text, '{"a":2}');
  await assert.rejects(v.writeProgress('{"a":3}', first.sha), kind('conflict'));
  await assert.rejects(v.writeProgress('{"a":4}', undefined), kind('conflict'));
  assert.equal((await v.readProgress()).text, '{"a":2}');
  assert.ok(g.writes().every(r => r.path.endsWith('/contents/' + PROGRESS)));
});

test('a 1.5 MB file with Vietnamese text goes up and comes back identical', async () => {
  const g = fakeGitHub(), v = make(g), text = JSON.stringify({ t: 'Tôi đang học tiếng Việt. '.repeat(60000) });
  assert.ok(text.length > 1.4e6);
  await v.writeProgress(text, undefined);
  assert.equal((await v.readProgress()).text, text);
});

test('earlier versions are listed newest first and each can be read', async () => {
  const g = fakeGitHub(), v = make(g);
  await v.writeProgress('one', undefined);
  await v.writeProgress('two', (await v.readProgress()).sha);
  await v.writeProgress('three', (await v.readProgress()).sha);
  const h = await v.history();
  assert.equal(h.length, 3);
  assert.ok(h[0].date > h[1].date && h[1].date > h[2].date);
  assert.deepEqual(await Promise.all(h.map(x => v.readProgressAt(x.sha))), ['three', 'two', 'one']);
  await assert.rejects(v.readProgressAt('nope'), kind('missing'));
});
