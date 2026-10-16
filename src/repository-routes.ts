// Loaded only after all original PR endpoints have been ruled out.
import type { ClientBuild } from './build.ts';
import { markdownBuild, pullsBuild, repositoryBuild } from './repository-build.ts';
import { pullsPage, repoPage } from './repository-html.ts';
export { resetBuilds } from './repository-build.ts';

const json = (data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data), { ...init, headers: { 'content-type': 'application/json', ...init.headers } });
const text = (body: string, type: string, extra: Record<string, string> = {}) =>
  new Response(body, { headers: { 'content-type': type, ...extra } });
const pageHeaders = { 'cache-control': 'no-store', 'content-security-policy': "frame-ancestors 'none'" };

// GitHub's URL shapes: /owner/repo, /owner/repo/tree/<ref>/<path>, /owner/repo/blob/<ref>/<path>.
// `api` is not a GitHub login, so /api/* never reads as a repository page.
const REPO_PAGE = /^\/(?!api\/)([\w.-]+)\/([\w.-]+)(?:\/(?:tree|blob)(?:\/(.*))?)?\/?$/;
const PULLS_PAGE = /^\/(?!api\/)([\w.-]+)\/([\w.-]+)\/pulls\/?$/;

/** The `<ref>/<path>` part of a page URL, decoded segment by segment. */
export function pathSpec(rest = ''): string | null {
  try { return rest.replace(/\/+$/, '').split('/').map(decodeURIComponent).join('/'); }
  catch { return null; }
}

export async function routeRepository(req: Request, url: URL, client: ClientBuild): Promise<Response | null> {
  const path = url.pathname;
  let m: RegExpExecArray | null;
  if ((m = PULLS_PAGE.exec(path))) {
    const [assets, repo] = await Promise.all([pullsBuild(), repositoryBuild()]);
    const state = url.searchParams.get('state') === 'closed' ? 'closed' : 'open';
    return text(pullsPage({ owner: m[1]!, repo: m[2]!, state, after: url.searchParams.get('after') ?? '', css: client.css, hash: assets.hash, repoHash: repo.hash }), 'text/html; charset=utf-8', pageHeaders);
  }
  if ((m = REPO_PAGE.exec(path))) {
    const spec = pathSpec(m[3]);
    if (spec == null) return new Response('bad request', { status: 400 });
    const assets = await repositoryBuild();
    return text(repoPage({ owner: m[1]!, repo: m[2]!, spec, css: client.css, hash: assets.hash, workerHash: client.hash }), 'text/html; charset=utf-8', pageHeaders);
  }
  if (path === '/api/markdown-assets') {
    const assets = await markdownBuild();
    return json({ hash: assets.hash }, { headers: { 'cache-control': 'no-store' } });
  }
  if ((m = /^\/(repo|pulls|markdown)\.(js|css)$/.exec(path))) {
    const build = m[1] === 'repo' ? repositoryBuild : m[1] === 'pulls' ? pullsBuild : markdownBuild;
    const assets = await build();
    const js = m[2] === 'js';
    // A stale page must not cache new bytes under an old content hash.
    const cache = url.searchParams.get('v') === assets.hash ? 'public, max-age=31536000, immutable' : 'no-store';
    return text(js ? assets.js : assets.css, js ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8', { 'cache-control': cache });
  }
  if ((m = /^\/api\/repo\/([\w.-]+)\/([\w.-]+)\/(snapshot|pulls|branches|tree|entry|paths|raw|grep)$/.exec(path))) {
    if (req.method !== 'GET') return json({ error: 'Method not allowed' }, { status: 405 });
    return repositoryApi(req, url, m);
  }
  return null;
}

async function repositoryApi(req: Request, url: URL, m: RegExpExecArray): Promise<Response> {
  const { repoSnapshot, repoPulls, repoBranches, repoTree, repoEntry, repoFile, repoBlob, RepoError } = await import('./repository.ts');
  try {
    const [owner, repo, action] = [m[1]!, m[2]!, m[3]!];
    const q = url.searchParams;
    if (action === 'grep') {
      const { grepRepository } = await import('./repository-search.ts');
      return json(await grepRepository(owner, repo, q.get('commit') ?? '', q.get('q') ?? '', q.get('regex') === '1', req.signal));
    }
    if (action === 'snapshot') return json(await repoSnapshot(owner, repo, q.get('spec') ?? ''), { headers: { 'cache-control': 'no-store' } });
    if (action === 'pulls') return json(await repoPulls(owner, repo, q.get('state') ?? 'open', q.get('after') || null), { headers: { 'cache-control': 'no-store' } });
    if (action === 'branches') return json(await repoBranches(owner, repo, q.get('q') ?? '', q.get('cursor')));
    if (action === 'tree') return json(await repoTree(owner, repo, q.get('sha') ?? ''));
    if (action === 'paths') {
      const tree = await repoTree(owner, repo, q.get('sha') ?? '', true);
      return json({ paths: tree.entries.filter((entry) => entry.type !== 'tree').map((entry) => entry.path), truncated: tree.truncated });
    }
    const entry = await repoEntry(owner, repo, q.get('tree') ?? '', q.get('path') ?? '');
    if (action === 'raw') {
      const bytes = await repoBlob(owner, repo, entry);
      const ext = entry.path.split('.').pop()?.toLowerCase() ?? '';
      const images: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', svg: 'image/svg+xml' };
      const name = entry.path.split('/').pop()!.replace(/[\r\n"\\]/g, '_');
      return new Response(new Uint8Array(bytes), { headers: {
        'content-type': q.has('image') ? images[ext] ?? 'application/octet-stream' : 'text/plain; charset=utf-8',
        'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox",
        ...(q.has('download') ? { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` } : {}),
      } });
    }
    return json({ entry, ...(entry.type === 'tree' ? await repoTree(owner, repo, entry.sha) : entry.type === 'blob' ? { file: await repoFile(owner, repo, entry) } : {}) });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, { status: e instanceof RepoError ? e.status : 500 });
  }
}
