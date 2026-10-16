import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grepDirectory } from '../src/repository-search.ts';

test.skipIf(!Bun.which('rg'))('bounded grep preserves literal/regex, hidden files, line numbers, and truncation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'diff-search-'));
  try {
    await Bun.write(join(dir, '.hidden.txt'), 'first\nCafé [value]\nlast\n');
    await Bun.write(join(dir, 'binary'), new Uint8Array([0, 65, 66, 67]));
    expect(await grepDirectory(dir, '[value]')).toEqual({ matches: [{ path: '.hidden.txt', line: 2, text: 'Café [value]' }], truncated: false });
    expect((await grepDirectory(dir, 'caf.+value', true)).matches).toHaveLength(1);
    expect(await grepDirectory(dir, 'not-present')).toEqual({ matches: [], truncated: false });
    await expect(grepDirectory(dir, '(', true)).rejects.toThrow();
    await expect(grepDirectory(join(dir, 'missing-directory'), 'needle')).rejects.toThrow();
    await Bun.write(join(dir, 'many.txt'), 'needle\n'.repeat(205));
    const result = await grepDirectory(dir, 'needle');
    expect(result.matches).toHaveLength(200);
    expect(result.truncated).toBe(true);
    const controller = new AbortController();
    controller.abort();
    await expect(grepDirectory(dir, 'needle', false, controller.signal)).rejects.toHaveProperty('name', 'AbortError');
    expect((await grepDirectory(dir, '[value]')).matches).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('HTTP cancellation kills running searches, removes queued searches, and frees bounded slots', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'diff-search-lifecycle-'));
  const sha = 'a'.repeat(40);
  mkdirSync(join(dir, 'search/example/repo', sha), { recursive: true });
  const entry = join(dir, 'probe.ts');
  // Use a real, long-running child as the search stand-in so cancellation and
  // concurrency can be checked deterministically without a huge file fixture.
  const standIn = 'await Bun.sleep(1000);';
  await Bun.write(entry, `
    const spawn = Bun.spawn;
    const live = new Map();
    const started = [], exited = [];
    let peak = 0;
    Bun.spawn = (args, options) => {
      if (args[0] !== 'rg') return spawn(args, options);
      const query = args[args.indexOf('-e') + 1];
      const process = spawn([Bun.argv[0], '-e', ${JSON.stringify(standIn)}], options);
      live.set(query, process);
      started.push({ query, args });
      peak = Math.max(peak, live.size);
      process.exited.then((code) => { live.delete(query); exited.push({ query, code }); });
      return process;
    };
    const serve = Bun.serve;
    Bun.serve = (options) => serve({ ...options, fetch(req, server) {
      const path = new URL(req.url).pathname;
      if (path === '/__probe') return Response.json({ live: [...live.keys()], started, exited, peak });
      if (path === '/__stop') { for (const process of live.values()) process.kill(); return new Response('ok'); }
      return options.fetch(req, server);
    }});
    await import(${JSON.stringify(join(import.meta.dir, '../src/server.ts'))});
  `);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const base = `http://127.0.0.1:${port}`;
  const server = Bun.spawn([process.execPath, entry], {
    env: { ...process.env, PRV_PORT: String(port), PRV_CACHE: dir, PRV_REPO: '' }, stdout: 'ignore', stderr: 'pipe',
  });
  type Probe = { live: string[]; started: { query: string; args: string[] }[]; exited: { query: string; code: number }[]; peak: number };
  const probe = () => fetch(`${base}/__probe`).then((r) => r.json()) as Promise<Probe>;
  const waitFor = async (ready: (p: Probe) => boolean) => {
    for (let i = 0; i < 300; i++) {
      const p = await probe();
      if (ready(p)) return p;
      await Bun.sleep(10);
    }
    throw new Error('search lifecycle did not settle');
  };
  const search = (q: string, signal?: AbortSignal) => fetch(`${base}/api/repo/example/repo/grep?${new URLSearchParams({ commit: sha, q })}`, { signal });
  try {
    for (let i = 0; ; i++) {
      if (await fetch(`${base}/health`).then((r) => r.ok, () => false)) break;
      if (i > 250 || server.exitCode !== null) throw new Error('search server did not start');
      await Bun.sleep(20);
    }
    const active = new AbortController(), queued = new AbortController();
    const cancelled = search('active', active.signal).catch((e: Error) => e.name);
    const normal = search('normal');
    await waitFor((p) => p.live.length === 2);
    const removed = search('queued', queued.signal).catch((e: Error) => e.name);
    const next = search('next');
    await Bun.sleep(50);
    expect((await probe()).started).toHaveLength(2);
    queued.abort();
    active.abort();
    expect(await cancelled).toBe('AbortError');
    expect(await removed).toBe('AbortError');
    const resumed = await waitFor((p) => p.live.includes('next'));
    expect(resumed.exited.find((p) => p.query === 'active')!.code).not.toBe(0);
    expect((await normal).status).toBe(200);
    expect((await next).status).toBe(200);
    const final = await waitFor((p) => p.live.length === 0);
    expect(final.peak).toBe(2);
    expect(final.started.map((p) => p.query).sort()).toEqual(['active', 'next', 'normal']);
    for (const { args } of final.started) expect(args[args.indexOf('--threads') + 1]).toBe('1');
  } finally {
    await fetch(`${base}/__stop`).catch(() => {});
    server.kill();
    await server.exited;
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);
