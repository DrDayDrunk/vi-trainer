// The private vault on GitHub (a separate private repository in the owner's own account). This is the only file that uses
// the network, and studying never needs it. Every failure becomes a plain message with a `kind`; no message ever holds the token.
const API = 'https://api.github.com';
export const OWNER = 'DrDayDrunk', REPO = 'vi-vault';
export const PROGRESS = 'progress/progress.json';
const NAME = /^level([1-3])-track(0[1-9]|1\d|20)\.json$/;

export class VaultError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

function b64(text) {
  const bytes = new TextEncoder().encode(text);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function failure(status, text) {
  let m = '';
  try { m = JSON.parse(text).message || ''; } catch { /* no message */ }
  if (status === 401) return new VaultError('auth', 'The vault refused the token. It may have expired or been deleted. Make a new one on GitHub and paste it in the Vault screen.');
  if (status === 429 || (status === 403 && /rate limit|abuse|too many/i.test(m))) return new VaultError('limit', 'GitHub says too many requests were made. Wait a few minutes and try again.');
  if (status === 403) return new VaultError('access', 'The token does not have access to the vault. On GitHub check that it covers only vi-vault and that Contents is set to Read and write.');
  if (status === 404) return new VaultError('missing', 'That was not found in the vault.');
  if (status === 409 || status === 422) return new VaultError('conflict', 'The vault changed while this phone was talking to it.');
  if (status >= 500) return new VaultError('server', 'There is a problem on GitHub right now. Try again later.');
  return new VaultError('http', 'The vault gave an unexpected reply (HTTP ' + status + ').');
}

export function createVault(token, f = (...a) => fetch(...a), { timeout = 20000, owner = OWNER, repo = REPO } = {}) {
  const base = '/repos/' + owner + '/' + repo;

  async function call(method, path, { body, raw } = {}) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await f(API + path, {
        method, cache: 'no-store', signal: ctl.signal, body: body && JSON.stringify(body),
        headers: { Authorization: 'Bearer ' + token, Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28', ...(body && { 'Content-Type': 'application/json' }) },
      });
      const text = await r.text();
      return { status: r.status, text, json: () => { try { return JSON.parse(text); } catch { return null; } } };
    } catch (e) {
      throw new VaultError('network', 'Could not reach the vault (' + (e.name === 'AbortError' ? 'it took too long' : 'no connection') + '). Studying works offline. Try again when you are online.');
    } finally { clearTimeout(timer); }
  }

  const folder = async dir => {
    const r = await call('GET', base + '/contents/' + dir);
    if (r.status === 404) return [];
    if (r.status !== 200 || !Array.isArray(r.json())) throw failure(r.status, r.text);
    return r.json();
  };

  return {
    // The vault repository must exist, be reachable with this token, and be private.
    async check() {
      const r = await call('GET', base);
      if (r.status === 404) throw new VaultError('missing', 'The vault repository ' + owner + '/' + repo + ' was not found, or this token cannot see it.');
      if (r.status !== 200) throw failure(r.status, r.text);
      if ((r.json() || {}).private !== true) throw new VaultError('public', 'The vault repository is PUBLIC. Make it private on GitHub before using it.');
      return true;
    },

    async listPack() {
      return (await folder('pack')).filter(f => f.type === 'file' && NAME.test(f.name))
        .map(f => { const [, l, t] = NAME.exec(f.name); return { name: f.name, level: +l, track: +t, size: f.size, sha: f.sha }; })
        .sort((a, b) => a.level - b.level || a.track - b.track);
    },

    async readPack(name) {
      const r = await call('GET', base + '/contents/pack/' + name, { raw: true });
      if (r.status === 404) throw new VaultError('missing', name + ' is not in the vault.');
      if (r.status !== 200) throw failure(r.status, r.text);
      return r.text;
    },

    // { text, sha } of the progress file, or null when the vault has none yet.
    async readProgress() {
      const hit = (await folder('progress')).find(f => f.path === PROGRESS);
      if (!hit) return null;
      const r = await call('GET', base + '/contents/' + PROGRESS, { raw: true });
      if (r.status === 404) return null;
      if (r.status !== 200) throw failure(r.status, r.text);
      return { text: r.text, sha: hit.sha };
    },

    // `sha` is the id of the version being replaced (undefined to create the file). A stale or missing id is a 'conflict'.
    async writeProgress(text, sha) {
      const r = await call('PUT', base + '/contents/' + PROGRESS, { body: { message: 'progress', content: b64(text), ...(sha && { sha }) } });
      if (r.status !== 200 && r.status !== 201) throw failure(r.status, r.text);
    },

    async history() {
      const r = await call('GET', base + '/commits?per_page=15&path=' + encodeURIComponent(PROGRESS));
      if (r.status !== 200 || !Array.isArray(r.json())) throw failure(r.status, r.text);
      return r.json().map(c => ({ sha: c.sha, date: c.commit.committer.date }));
    },

    async readProgressAt(sha) {
      const r = await call('GET', base + '/contents/' + PROGRESS + '?ref=' + encodeURIComponent(sha), { raw: true });
      if (r.status === 404 || r.status === 422) throw new VaultError('missing', 'That earlier version could not be found.');
      if (r.status !== 200) throw failure(r.status, r.text);
      return r.text;
    },
  };
}
