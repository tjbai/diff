#!/usr/bin/env bun
// diff <github PR url | owner/repo#N> — open a fast local "Files changed" view.
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { CACHE_ROOT } from '../src/github.ts';
import { sourceVersion } from '../src/version.ts';

const t0 = Date.now();
const PORT = Number(process.env.PRV_PORT ?? 7717);
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER = join(import.meta.dir, '..', 'src', 'server.ts');
const LOG = join(CACHE_ROOT, 'server.log');

const USAGE = `usage: diff            open the start page
       diff <https://github.com/owner/repo/pull/N | owner/repo#N> [--no-open]
       diff --stop      stop the background server
       diff --restart   restart the background server`;

function parse(arg: string) {
  const m =
    /github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/.exec(arg) ?? /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(arg.trim());
  return m ? { owner: m[1]!, repo: m[2]!, number: Number(m[3]) } : null;
}

async function health(): Promise<{ version: string } | null> {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(500) });
    return r.ok ? ((await r.json()) as { version: string }) : null;
  } catch {
    return null;
  }
}

async function stop() {
  try {
    await fetch(`${BASE}/api/shutdown`, { method: 'POST', signal: AbortSignal.timeout(1000) });
  } catch {}
  for (let i = 0; i < 100 && (await health()); i++) await Bun.sleep(20);
}

async function ensureServer(): Promise<string> {
  const want = sourceVersion();
  const h = await health();
  if (h?.version === want) return 'reused';
  if (h) await stop();
  mkdirSync(CACHE_ROOT, { recursive: true });
  // Give the daemon its own session so it survives the launcher and terminal.
  const log = openSync(LOG, 'a', 0o600);
  try {
    const child = spawn(process.execPath, [SERVER], { detached: true, stdio: ['ignore', log, log] });
    child.on('error', (e) => console.error(`diff: ${e.message}`));
    child.unref();
  } finally {
    closeSync(log);
  }
  for (let i = 0; i < 500; i++) {
    await Bun.sleep(10);
    if ((await health())?.version === want) return h ? 'restarted' : 'started';
  }
  throw new Error(`server did not start; see ${LOG}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--stop')) return void (await stop());
  if (args.includes('--restart')) {
    await stop();
    console.log(`diff: server ${await ensureServer()}`);
    return;
  }
  const target = args.find((a) => !a.startsWith('--'));
  if (!target && args.every((a) => a === '--no-open' || a === '--color')) {
    const server = await ensureServer();
    if (!args.includes('--no-open')) Bun.spawn([process.platform === 'darwin' ? 'open' : 'xdg-open', BASE], { stdio: ['ignore', 'ignore', 'ignore'] });
    console.log(`diff: ${BASE} (server ${server})`);
    return;
  }
  const pr = target ? parse(target) : null;
  if (!pr) {
    console.error(USAGE);
    process.exit(2);
  }
  const server = await ensureServer();
  const tServer = Date.now() - t0;
  // Start the fetch/diff now so it overlaps with the browser starting up.
  const warm = (await fetch(`${BASE}/api/warm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(pr),
  }).then((r) => r.json())) as { cached: boolean };
  const url = `${BASE}/${pr.owner}/${pr.repo}/pull/${pr.number}?t0=${t0}`;
  const open = !args.includes('--no-open');
  if (open) Bun.spawn([process.platform === 'darwin' ? 'open' : 'xdg-open', url], { stdio: ['ignore', 'ignore', 'ignore'] });
  // With --no-open, print the full URL (with t0) so scripts can open it and time first paint.
  console.log(`diff: ${open ? url.replace(/\?.*$/, '') : url}  (server ${server} in ${tServer} ms, ${warm.cached ? 'cached diff shown, refreshing' : 'fetching'})`);
}

main().catch((e) => {
  console.error(`diff: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
