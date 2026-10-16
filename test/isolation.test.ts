import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('PR startup and rebuild never import or build optional repository features', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'diff-isolation-'));
  const entry = join(directory, 'probe.ts');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const base = `http://127.0.0.1:${port}`;
  // Instrument an actual child server, keeping probes out of production code.
  await Bun.write(entry, `
    const builds = [];
    let broken = '';
    const build = Bun.build;
    Bun.build = (options) => {
      builds.push(...options.entrypoints);
      if (broken && options.entrypoints.some((p) => p.endsWith('/' + broken))) throw new Error('deliberate optional build failure');
      return build(options);
    };
    const serve = Bun.serve;
    Bun.serve = (options) => serve({ ...options, fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === '/__probe') {
        if (url.searchParams.has('break')) broken = url.searchParams.get('break');
        return Response.json({ builds, modules: Object.keys(require.cache) });
      }
      return options.fetch(req, server);
    }});
    await import(${JSON.stringify(join(import.meta.dir, '../src/server.ts'))});
  `);
  const server = Bun.spawn([process.execPath, entry], {
    env: { ...process.env, PRV_PORT: String(port), PRV_CACHE: directory, PRV_REPO: '' }, stdout: 'ignore', stderr: 'pipe',
  });
  try {
    for (let i = 0; ; i++) {
      if (await fetch(`${base}/health`).then((r) => r.ok, () => false)) break;
      if (i > 250 || server.exitCode !== null) throw new Error('isolation server did not start');
      await Bun.sleep(20);
    }
    const probe = () => fetch(`${base}/__probe`).then((r) => r.json()) as Promise<{ builds: string[]; modules: string[] }>;
    const original = await fetch(`${base}/app.js`).then((r) => r.text());
    const index = await fetch(`${base}/`).then((r) => r.text());
    expect(index).toContain("window.__prvBoot={mode:'index'};");
    expect(index).not.toContain('/pulls.js');
    expect((await fetch(`${base}/not-a-route`)).status).toBe(404);
    const html = await fetch(`${base}/example/repo/pull/1`).then((r) => r.text());
    expect(html).toContain('/app.js?v=');
    expect(html).not.toMatch(/repo\.js|markdown|pulls\.js/);
    await fetch(`${base}/hl-worker.js`);
    const before = await probe();
    expect(before.builds.map((p) => p.split('/').pop())).toEqual(['app.ts', 'hl-worker.ts', 'style.css']);
    expect(before.modules.filter((p) => /\/repository[^/]*\.ts$/.test(p))).toEqual([]);

    const hash = await fetch(`${base}/api/rebuild`, { method: 'POST' }).then((r) => r.json()) as { hash: string };
    const rebuilt = await probe();
    expect(rebuilt.builds.length).toBe(6);
    expect(rebuilt.modules.filter((p) => /\/repository[^/]*\.ts$/.test(p))).toEqual([]);

    // Concurrent first-use requests share a build. Browsing a directory does
    // not initialize Markdown, GitHub access, or the archive/grep backend.
    await Promise.all([1, 2, 3].map(() => fetch(`${base}/example/repo/tree`).then((r) => r.text())));
    const directoryView = await probe();
    expect(directoryView.builds.filter((p) => p.endsWith('/repository.ts')).length).toBe(1);
    expect(directoryView.modules.some((p) => /\/(repository-search|repository-github|repository)\.ts$/.test(p))).toBe(false);
    expect(directoryView.builds.some((p) => p.endsWith('/markdown.ts'))).toBe(false);
    await Promise.all([1, 2].map(() => fetch(`${base}/example/repo/pulls`).then((r) => r.text())));
    expect((await probe()).builds.filter((p) => p.endsWith('/pulls.ts')).length).toBe(1);

    const metadata = await fetch(`${base}/api/markdown-assets`).then((r) => r.json()) as { hash: string };
    const styles = await fetch(`${base}/markdown.css?v=${metadata.hash}`);
    expect(styles.headers.get('cache-control')).toContain('immutable');
    const stale = await fetch(`${base}/markdown.css?v=outdated`);
    expect(stale.headers.get('cache-control')).toBe('no-store');
    expect((await probe()).builds.filter((p) => p.endsWith('/markdown.ts')).length).toBe(1);
    expect(await fetch(`${base}/app.js`).then((r) => r.text())).toBe(original);

    const after = await fetch(`${base}/api/rebuild`, { method: 'POST' }).then((r) => r.json()) as { hash: string };
    expect(after.hash).toBe(hash.hash);
    expect((await probe()).builds.filter((p) => /\/(repository|markdown|pulls)\.ts$/.test(p)).length).toBe(3);
    expect(await fetch(`${base}/example/repo/pull/1`).then((r) => r.text())).toBe(html);

    // A broken optional bundle neither poisons PR serving nor remains cached
    // forever after the problem is fixed.
    await fetch(`${base}/__probe?break=pulls.ts`);
    expect((await fetch(`${base}/pulls.js`)).status).toBe(500);
    expect(await fetch(`${base}/app.js`).then((r) => r.text())).toBe(original);
    expect((await fetch(`${base}/api/rebuild`, { method: 'POST' })).status).toBe(200);
    await fetch(`${base}/__probe?break=`);
    expect((await fetch(`${base}/pulls.js`)).status).toBe(200);
  } finally {
    server.kill();
    await server.exited;
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
