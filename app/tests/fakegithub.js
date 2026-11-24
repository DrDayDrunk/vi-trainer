// A fake GitHub for the vault tests: one private repository in memory, with the parts of the REST API the app uses.
// A test helper only; it is never loaded by the app.
export const TOKEN = 'github_pat_TESTTOKENTESTTOKENTESTTOKENTESTTOKENTESTTOKEN';
const enc = new TextEncoder();
const sha = (n => () => 'sha' + (++n))(0);

export function fakeGitHub({ priv = true, owner = 'DrDayDrunk', repo = 'vi-vault' } = {}) {
  const g = {
    files: {},        // path -> { text, sha }
    commits: [],      // newest first: { sha, path, text, date }
    requests: [],     // { method, path, headers, body }
    offline: false, hang: false, status: null, before: null,   // test controls
    tick: Date.UTC(2026, 10, 12, 8),
  };
  const reply = (status, body, text) => ({
    ok: status < 300, status, headers: { get: () => null },
    text: async () => text ?? JSON.stringify(body), json: async () => body,
  });
  g.fetch = async (url, o = {}) => {
    const u = new URL(url), path = u.pathname, method = o.method || 'GET', h = o.headers || {};
    g.requests.push({ method, path: path + u.search, headers: h, body: o.body });
    if (g.offline) throw new TypeError('Load failed');
    if (g.hang) await new Promise((_, no) => o.signal && o.signal.addEventListener('abort', () => no(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    if (g.before) await g.before(method, path);
    if (g.status) return reply(g.status, { message: 'forced ' + g.status });
    if (h.Authorization !== 'Bearer ' + TOKEN) return reply(401, { message: 'Bad credentials' });
    const base = '/repos/' + owner + '/' + repo;
    if (method === 'GET' && path === base) return reply(200, { private: priv });
    if (method === 'GET' && path === base + '/commits') {
      const p = u.searchParams.get('path');
      return reply(200, g.commits.filter(c => c.path === p).map(c => ({ sha: c.sha, commit: { committer: { date: c.date } } })));
    }
    if (path.startsWith(base + '/contents/')) {
      const p = decodeURIComponent(path.slice((base + '/contents/').length));
      if (method === 'GET') {
        const ref = u.searchParams.get('ref');
        if (g.files[p]) {
          if (!/raw/.test(h.Accept)) return reply(403, { message: 'raw only in this fake' });
          const text = ref ? (g.commits.find(c => c.sha === ref && c.path === p) || {}).text : g.files[p].text;
          return text === undefined ? reply(404, { message: 'No commit found for the ref ' + ref }) : reply(200, null, text);
        }
        const kids = Object.keys(g.files).filter(f => f.startsWith(p + '/') && !f.slice(p.length + 1).includes('/'));
        if (!kids.length) return reply(404, { message: 'Not Found' });
        return reply(200, kids.map(f => ({ name: f.split('/').pop(), path: f, sha: g.files[f].sha, size: enc.encode(g.files[f].text).length, type: 'file' })));
      }
      if (method === 'PUT') {
        const b = JSON.parse(o.body), cur = g.files[p];
        if ((cur && b.sha !== cur.sha) || (!cur && b.sha)) return reply(cur ? 409 : 422, { message: cur ? p + ' does not match ' + cur.sha : "sha wasn't supplied" });
        const text = new TextDecoder().decode(Uint8Array.from(atob(b.content), c => c.charCodeAt(0))), s = sha();
        g.files[p] = { text, sha: s };
        g.commits.unshift({ sha: 'c' + s, path: p, text, date: new Date(g.tick += 60000).toISOString() });
        return reply(cur ? 200 : 201, { content: { sha: s } });
      }
    }
    return reply(404, { message: 'no route ' + method + ' ' + path });
  };
  g.put = (path, text) => { const s = sha(); g.files[path] = { text, sha: s }; g.commits.unshift({ sha: 'c' + s, path, text, date: new Date(g.tick += 60000).toISOString() }); };
  g.writes = () => g.requests.filter(r => r.method === 'PUT');
  return g;
}
