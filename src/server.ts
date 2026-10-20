// The diff daemon: serves the app, the per-PR manifest and patches, file
// contents for hunk expansion, grammars, and exports.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { bundledLanguages } from 'shiki';
import { buildClient, type ClientBuild } from './build.ts';
import { approvePr, CACHE_ROOT, cachedPr, loadPr, prByKey, showFile, type PrResult } from './github.ts';
import { exportPage, indexPage, livePage } from './html.ts';
import type { ExportBundle, ExportRequest, Manifest } from './types.ts';
import { sourceVersion } from './version.ts';

const PORT = Number(process.env.PRV_PORT ?? 7717);
const VERSION = sourceVersion();
const started = performance.now();

let client: ClientBuild = await buildClient();
console.log(`built client in ${Math.round(performance.now() - started)}ms (app ${(client.js.length / 1024).toFixed(0)} KB, worker ${(client.worker.length / 1024).toFixed(0)} KB)`);

const json = (data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data), { ...init, headers: { 'content-type': 'application/json', ...init.headers } });
const text = (body: string, type: string, extra: Record<string, string> = {}) =>
  new Response(body, { headers: { 'content-type': type, ...extra } });

function toManifest(r: PrResult, stale = false): Manifest {
  return {
    meta: r.meta,
    key: r.key,
    baseSha: r.baseSha,
    headSha: r.headSha,
    files: r.files,
    timings: r.timings,
    checkedAt: r.checkedAt,
    ...(stale ? { stale } : {}),
  };
}

const grammars = new Map<string, Promise<unknown[]>>();
function grammar(name: string): Promise<unknown[]> {
  let p = grammars.get(name);
  if (!p) {
    const loader = (bundledLanguages as Record<string, () => Promise<{ default: unknown[] }>>)[name];
    if (!loader) return Promise.reject(new Error(`unknown language ${name}`));
    p = loader().then((m) => m.default);
    grammars.set(name, p);
  }
  return p;
}

let workerB64: string | undefined;

async function buildExport(req: ExportRequest): Promise<{ name: string; html: string }> {
  const r = await prByKey(req.key);
  if (!r) throw new Error('unknown diff key; refresh and try again');
  const omit = new Set(req.omit);
  const patches = r.sections.map((s, i) => (omit.has(i) ? null : s));
  const names = new Set(r.files.filter((f, i) => patches[i] != null && f.lang !== 'text').map((f) => f.lang));
  const langs: Record<string, unknown[]> = {};
  await Promise.all([...names].map(async (n) => (langs[n] = await grammar(n).catch(() => []))));
  const bundle: ExportBundle = {
    v: 1,
    manifest: toManifest(r),
    patches,
    enabledCats: req.enabledCats,
    manual: req.manual,
    langs,
    prefs: req.prefs,
    exportedAt: Date.now(),
    omitHidden: omit.size > 0,
  };
  const gz = Bun.gzipSync(Buffer.from(JSON.stringify(bundle)), { level: 6 });
  workerB64 ??= Buffer.from(Bun.gzipSync(Buffer.from(client.worker), { level: 9 })).toString('base64');
  const { owner, repo, number, title } = r.meta;
  const html = exportPage({
    title: `${title} · ${owner}/${repo}#${number}`,
    css: client.css,
    js: client.js,
    bundleB64: Buffer.from(gz).toString('base64'),
    workerB64,
  });
  return { name: `diff-${owner}-${repo}-${number}-${r.headSha.slice(0, 7)}.html`, html };
}

function logTiming(entry: Record<string, unknown>) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  console.log('timing', line);
  try {
    mkdirSync(CACHE_ROOT, { recursive: true });
    appendFileSync(join(CACHE_ROOT, 'timings.log'), `${line}\n`);
  } catch {}
}

const PR_PAGE = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?(?:files)?\/?$/;
const PR_API = /^\/api\/pr\/([^/]+)\/([^/]+)\/(\d+)$/;

async function route(req: Request, url: URL): Promise<Response> {
  const path = url.pathname;
  let m: RegExpExecArray | null;

  if (path === '/favicon.ico') return new Response(null, { status: 204 });
  if (path === '/health') return json({ ok: true, version: VERSION, pid: process.pid });

  if ((m = PR_PAGE.exec(path))) {
    return text(livePage({ owner: m[1]!, repo: m[2]!, number: Number(m[3]), css: client.css, hash: client.hash }), 'text/html; charset=utf-8', {
      'cache-control': 'no-store',
      // A hidden frame of this page would load (and clone) any repo for another site.
      'content-security-policy': "frame-ancestors 'none'",
    });
  }
  if (path === '/') return text(indexPage({ css: client.css, hash: client.hash }), 'text/html; charset=utf-8');
  if (path === '/app.js') {
    return text(client.js, 'text/javascript; charset=utf-8', { 'cache-control': 'public, max-age=31536000, immutable' });
  }
  // Firefox has handed workers empty bodies for this and for grammars, maybe
  // from stale cache entries; from localhost, caching either saves nothing.
  if (path === '/hl-worker.js') return text(client.worker, 'text/javascript; charset=utf-8', { 'cache-control': 'no-store' });

  if ((m = PR_API.exec(path))) {
    const [owner, repo, n] = [m[1]!, m[2]!, Number(m[3])];
    if (url.searchParams.get('cached') === '1') {
      const hit = await cachedPr(owner, repo, n);
      if (hit) return json(toManifest(hit, true));
    }
    return json(toManifest(await loadPr(owner, repo, n)));
  }

  if (path === '/api/warm' && req.method === 'POST') {
    const { owner, repo, number } = (await req.json()) as { owner: string; repo: string; number: number };
    // Load the cached result into memory, and start a fresh fetch in the background.
    const hit = await cachedPr(owner, repo, number);
    loadPr(owner, repo, number).catch((e) => console.error('warm', e));
    return json({ cached: !!hit });
  }

  if (path === '/api/approve' && req.method === 'POST') {
    const { owner, repo, number, headSha } = (await req.json()) as { owner: string; repo: string; number: number; headSha: string };
    return json(await approvePr(owner, repo, number, headSha));
  }

  if (path === '/api/patches' && req.method === 'POST') {
    const { key, ids } = (await req.json()) as { key: string; ids: number[] };
    const r = await prByKey(key);
    if (!r) return json({ error: 'unknown key' }, { status: 404 });
    return json(ids.map((i) => r.sections[i] ?? null));
  }

  if (path === '/api/file') {
    const r = await prByKey(url.searchParams.get('key') ?? '');
    if (!r) return json({ error: 'unknown key' }, { status: 404 });
    const side = url.searchParams.get('side');
    const rev = side === 'old' ? r.baseSha : r.headSha;
    const body = await showFile(r.meta.owner, r.meta.repo, rev, url.searchParams.get('path') ?? '');
    return body == null ? new Response('not found', { status: 404 }) : text(body, 'text/plain; charset=utf-8');
  }

  if ((m = /^\/api\/lang\/([\w+#-]+)$/.exec(path))) {
    return json(await grammar(m[1]!), { headers: { 'cache-control': 'no-store' } });
  }

  if (path === '/api/export' && req.method === 'POST') {
    const t = performance.now();
    const { name, html } = await buildExport((await req.json()) as ExportRequest);
    logTiming({ kind: 'export', ms: Math.round(performance.now() - t), bytes: html.length });
    return new Response(html, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'content-disposition': `attachment; filename="${name}"` },
    });
  }

  if (path === '/api/timing' && req.method === 'POST') {
    logTiming((await req.json()) as Record<string, unknown>);
    return json({ ok: true });
  }

  if (path === '/api/rebuild' && req.method === 'POST') {
    client = await buildClient();
    workerB64 = undefined;
    return json({ hash: client.hash });
  }

  if (path === '/api/shutdown' && req.method === 'POST') {
    setTimeout(() => process.exit(0), 10);
    return json({ ok: true });
  }

  return new Response('not found', { status: 404 });
}

// Browsers let any website send requests here, even though they can't read the
// answers. A foreign Host means DNS rebinding (evil.example resolving to
// 127.0.0.1), which *would* let the site read them. The API is for this
// server's own pages and for clients that aren't browsers (the CLI); the
// extension only needs /health.
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
function allowed(req: Request, url: URL): boolean {
  const host = req.headers.get('host') ?? '';
  if (!HOSTS.has(host)) return false;
  if (!url.pathname.startsWith('/api/')) return true;
  const site = req.headers.get('sec-fetch-site');
  const origin = req.headers.get('origin');
  return (!site || site === 'same-origin' || site === 'none') && (!origin || origin === `http://${host}`);
}

Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    if (!allowed(req, url)) return new Response('forbidden', { status: 403 });
    try {
      return await route(req, url);
    } catch (e) {
      console.error(url.pathname, e);
      return json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  },
});
console.log(`diff listening on http://127.0.0.1:${PORT} (version ${VERSION}, pid ${process.pid})`);
