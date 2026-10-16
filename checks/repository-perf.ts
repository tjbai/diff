// Live browser benchmark. Pin the same commit for before/after comparisons.
// bun checks/repository-perf.ts --commit SHA --out /tmp/repo-perf.json
// REPO_BROWSER_EXECUTABLE may point at an existing Playwright Chromium binary.
import { chromium, type Page } from 'playwright-core';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const args = process.argv.slice(2);
const opt = (name: string, fallback = '') => args.includes(name) ? args[args.indexOf(name) + 1]! : fallback;
const base = opt('--base', 'http://127.0.0.1:7717');
const repo = opt('--repo', 'AuctorAI/auctor');
const runs = Number(opt('--runs', '5'));
const snapshot = await fetch(`${base}/api/repo/${repo}/snapshot?${new URLSearchParams({ spec: opt('--commit') || 'dev' })}`).then((r) => r.json()) as { sha: string; branch: string };
if (!snapshot.sha) throw new Error('Snapshot could not be loaded');
const root = `${base}/${repo}/tree/${snapshot.sha}`;
const cache = join(homedir(), 'Library/Caches/ms-playwright');
const installed = existsSync(cache) ? readdirSync(cache).filter((n) => n.startsWith('chromium_headless_shell-')).sort().reverse()[0] : '';
const executable = process.env.REPO_BROWSER_EXECUTABLE || (installed ? join(cache, installed, 'chrome-headless-shell-mac-arm64/chrome-headless-shell') : undefined);
const browser = await chromium.launch(executable ? { executablePath: executable } : {});
const results: Record<string, number>[] = [];

async function clickPaint(page: Page, selector: string, ready: string) {
  return page.evaluate(async ({ selector, ready }) => {
    const start = performance.now();
    (document.querySelector(selector) as HTMLElement).click();
    await new Promise<void>((resolve, reject) => {
      if (document.querySelector(ready)) return resolve();
      const timeout = setTimeout(() => { observer.disconnect(); reject(new Error(`Timed out waiting for ${ready}`)); }, 30_000);
      const observer = new MutationObserver(() => { if (document.querySelector(ready)) { clearTimeout(timeout); observer.disconnect(); resolve(); } });
      observer.observe(document.body, { childList: true, subtree: true });
    });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return Math.round(performance.now() - start);
  }, { selector, ready });
}

try {
  for (let run = 0; run < runs; run++) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    let requests = 0;
    page.on('request', (r) => { if (r.url().includes('/api/repo/')) requests++; });
    await page.addInitScript(() => {
      const w = window as unknown as { __bench: { root: number; long: number[] } };
      w.__bench = { root: 0, long: [] };
      new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__bench.long.push(e.duration))).observe({ type: 'longtask' });
      const observer = new MutationObserver(() => {
        if (document.querySelector('.repo-directory tbody tr')) {
          observer.disconnect();
          requestAnimationFrame(() => requestAnimationFrame(() => { w.__bench.root = performance.now(); }));
        }
      });
      observer.observe(document, { childList: true, subtree: true });
    });
    const out: Record<string, number> = {};
    await page.goto(root);
    await page.waitForFunction(() => (window as unknown as { __bench: { root: number } }).__bench.root > 0);
    out['root.paint ms'] = await page.evaluate(() => Math.round((window as unknown as { __bench: { root: number } }).__bench.root));
    out['root.apiRequests'] = requests;
    out['file.first ms'] = await clickPaint(page, '.repo-directory a[data-path="package.json"]', '.repo-code');
    await page.waitForFunction(() => document.querySelector('.repo-line-code span'));
    await clickPaint(page, '.repo-breadcrumbs a[data-path=""]', '.repo-directory');
    const fileRequests = requests;
    out['file.repeat ms'] = await clickPaint(page, '.repo-directory a[data-path="package.json"]', '.repo-code');
    out['file.repeatRequests'] = requests - fileRequests;
    out['branches.first ms'] = await clickPaint(page, '.repo-branch-button', 'dialog[open] .repo-choice');
    await page.keyboard.press('Escape');
    out['branches.repeat ms'] = await clickPaint(page, '.repo-branch-button', 'dialog[open] .repo-choice');
    await page.keyboard.press('Escape');
    out['find.first ms'] = await clickPaint(page, '.repo-toolbar-actions button[title="Go to file (⌘K)"]', 'dialog[open] .repo-choice');
    await page.keyboard.press('Escape');
    const findRequests = requests;
    out['find.repeat ms'] = await clickPaint(page, '.repo-toolbar-actions button[title="Go to file (⌘K)"]', 'dialog[open] .repo-choice');
    out['find.repeatRequests'] = requests - findRequests;
    await page.keyboard.press('Escape');
    await page.keyboard.press('Meta+Shift+k');
    out['grep.results ms'] = await page.evaluate(async () => {
      const input = document.querySelector<HTMLInputElement>('dialog[open] input[placeholder="Search file contents…"]')!;
      const start = performance.now();
      const painted = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('Timed out waiting for code search')); }, 180_000);
        const observer = new MutationObserver(() => {
          if (document.querySelector('dialog[open] .repo-code-match')) { clearTimeout(timeout); observer.disconnect(); resolve(); }
        });
        observer.observe(document.body, { childList: true, subtree: true });
      });
      input.value = 'useState';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await painted;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return Math.round(performance.now() - start);
    });
    out['total.apiRequests'] = requests;
    out['longestTask ms'] = await page.evaluate(() => Math.round(Math.max(0, ...(window as unknown as { __bench: { long: number[] } }).__bench.long)));
    out['api.encodedBytes'] = await page.evaluate(() => performance.getEntriesByType('resource').filter((r) => r.name.includes('/api/repo/')).reduce((n, r) => n + (r as PerformanceResourceTiming).encodedBodySize, 0));
    console.log(`run ${run + 1}/${runs}`, JSON.stringify(out));
    results.push(out);
    await context.close();
  }
} finally { await browser.close(); }
const median = Object.fromEntries(Object.keys(results[0]!).map((key) => [key, results.map((r) => r[key]!).sort((a, b) => a - b)[Math.floor(results.length / 2)]!]));
const report = { repo, commit: snapshot.sha, runs, at: new Date().toISOString(), median, samples: results };
if (opt('--out')) await Bun.write(opt('--out'), JSON.stringify(report, null, 2));
console.log('MEDIAN', JSON.stringify(median));
