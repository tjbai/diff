// Browser perf gate. Serves a PR from a private cache on its own port, drives
// headless Firefox through first load, scrolling, and the common interactions,
// and compares the medians with checks/budget.json. Budgets are a ratchet:
// they only go down. If you trip one, make it faster; do not raise it.
//
//   bun checks/perf.ts                 the synthetic fixture, against budgets
//   bun checks/perf.ts --ratchet       same, then lower budgets that have room
//   bun checks/perf.ts owner/repo#N    a real PR from ~/.cache/prv, report only
//   --fixture deletions  another fixture (checks/fixture.ts), with its own budgets
//   --runs N (default 5)  --headed  --json
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firefox, type Browser, type Locator, type Page } from 'playwright-core';
import { FIXTURES } from './fixture.ts';
import { BUDGET_FILE, readBudget, ratchet, report, writeBudget, type Metrics } from './budget.ts';

const ROOT = join(import.meta.dir, '..');
const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const opt = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const RUNS = Number(opt('--runs') ?? 5);
const target = args.find((a) => /^[\w.-]+\/[\w.-]+#\d+$/.test(a));
const FIXTURE = opt('--fixture') ?? 'mega';
if (!FIXTURES[FIXTURE]) throw new Error(`perf: no fixture ${FIXTURE}; one of ${Object.keys(FIXTURES).join(', ')}`);
/** Each fixture's budgets; the first one's kept their name. */
const SECTION = FIXTURE === 'mega' ? 'perf' : `perf ${FIXTURE}`;

// ------------------------------------------------------------ the PR to serve

let cache: string | undefined;
let pr: { owner: string; repo: string; number: number };
if (target) {
  const m = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(target)!;
  pr = { owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
} else {
  cache = mkdtempSync(join(tmpdir(), 'diff-perf-'));
  process.env.PRV_CACHE = cache;
  const { writeDiff, writePointer } = await import('../src/github.ts');
  const { splitPatch } = await import('../src/patch.ts');
  const fx = FIXTURES[FIXTURE]!();
  const { files, sections } = splitPatch(fx.patch);
  const [baseSha, headSha] = ['a'.repeat(40), 'b'.repeat(40)];
  const key = `${baseSha}..${headSha}`;
  await writeDiff(fx.owner, fx.repo, key, files, sections);
  const meta = {
    owner: fx.owner, repo: fx.repo, number: fx.number, title: fx.title, state: 'open' as const, author: 'perf',
    url: '', baseRef: 'main', headRef: `perf/${FIXTURE}`, commits: 42,
  };
  await writePointer({ meta, key, baseSha, headSha, checkedAt: 0 });
  pr = fx;
}

const port = 20000 + Math.floor(Math.random() * 20000);
const server = Bun.spawn([process.execPath, join(ROOT, 'src/server.ts')], {
  env: { ...process.env, PRV_PORT: String(port), ...(cache ? { PRV_CACHE: cache } : {}) },
  stdout: 'ignore',
  stderr: 'inherit',
});
const BASE = `http://127.0.0.1:${port}`;
for (let i = 0; ; i++) {
  if (await fetch(`${BASE}/health`).then((r) => r.ok, () => false)) break;
  if (i > 300) throw new Error('perf: server did not start');
  await Bun.sleep(20);
}
const PAGE = `${BASE}/${pr.owner}/${pr.repo}/pull/${pr.number}`;
const API = `${BASE}/api/pr/${pr.owner}/${pr.repo}/${pr.number}`;

// ------------------------------------------------------------ in-page probes

/** Runs before the app: records every frame and every slow input. */
function probe() {
  type View = { rendered: boolean; tokens: unknown; f: { lang: string }; parsed: { hunks: unknown[] } | null; el: HTMLElement };
  type App = { views: Map<number, View>; renderQueue: View[] };
  const w = window as unknown as {
    __perf: { frames: number[]; events: { name: string; start: number; dur: number }[]; highlighted?: number; shifts: number; tracking: boolean };
    __prvApp?: App;
  };
  w.__perf = { frames: [], events: [], shifts: 0, tracking: false };
  // Layout shifts: frames where code on screen moved in the page because
  // something above it changed height, like a box that rendered taller than
  // the room it held. Scrolling moves the screen, not the page, so it
  // doesn't count, smooth or not, and neither does the browser's scroll
  // anchoring, which hides some shifts and not others.
  let anchors: [Element, number][] = [];
  const pageTop = (el: Element) => el.getBoundingClientRect().top + scrollY;
  const shifted = () => {
    if (anchors.some(([el, y]) => el.isConnected && Math.abs(pageTop(el) - y) >= 1)) w.__perf.shifts++;
    anchors = [];
    for (const f of [0.3, 0.6, 0.9]) {
      const el = document.elementFromPoint(900, innerHeight * f)?.closest('tr, .file');
      if (el) anchors.push([el, pageTop(el)]);
    }
  };
  // The first frame where every code file on screen has its syntax colors.
  const highlighted = (app: App) => {
    const shown = [...app.views.values()].filter((v) => v.rendered && v.f.lang !== 'text' && v.parsed?.hunks.length && v.el.getBoundingClientRect().top < innerHeight);
    return shown.length > 0 && shown.every((v) => v.tokens && !app.renderQueue.includes(v));
  };
  const tick = (t: number) => {
    w.__perf.frames.push(t);
    if (w.__perf.tracking) shifted();
    else anchors = [];
    if (!w.__perf.highlighted && w.__prvApp && highlighted(w.__prvApp)) w.__perf.highlighted = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) w.__perf.events.push({ name: e.name, start: e.startTime, dur: e.duration });
  }).observe({ type: 'event', durationThreshold: 16, buffered: true } as PerformanceObserverInit);
}

const LONG = 50;

/** Wait until no frame has run long for `quiet` ms; returns when the last long frame ended. */
async function settle(page: Page, quiet = 1000, timeout = 30_000): Promise<number> {
  return page.evaluate(
    async ([quiet, timeout, LONG]) => {
      const f = (window as unknown as { __perf: { frames: number[] } }).__perf.frames;
      const start = performance.now();
      for (;;) {
        await new Promise((r) => setTimeout(r, 100));
        let last = 0;
        for (let i = 1; i < f.length; i++) if (f[i]! - f[i - 1]! > LONG) last = f[i]!;
        if (performance.now() - Math.max(last, start) > quiet || performance.now() - start > timeout) return last;
      }
    },
    [quiet, timeout, LONG] as const,
  );
}

/** Frame stats over [from, to): longest frame and total time past 50 ms. */
async function frames(page: Page, from: number, to = Infinity) {
  return page.evaluate(
    ([from, to, LONG]) => {
      const f = (window as unknown as { __perf: { frames: number[] } }).__perf.frames;
      let max = 0;
      let blocking = 0;
      for (let i = 1; i < f.length; i++) {
        if (f[i]! < from || f[i - 1]! >= to) continue;
        const gap = f[i]! - f[i - 1]!;
        max = Math.max(max, gap);
        if (gap > LONG) blocking += gap - LONG;
      }
      return { max: Math.round(max), blocking: Math.round(blocking) };
    },
    [from, to, LONG] as const,
  );
}

const now = (page: Page) => page.evaluate(() => performance.now());

/** Count layout shifts (see `probe`) from here until told to stop. */
const tracking = (page: Page, on: boolean) => page.evaluate((on) => ((window as unknown as { __perf: { tracking: boolean } }).__perf.tracking = on), on);

/** Wheel through the diff, as a person would, `n` notches of `dy`. */
async function wheel(page: Page, n: number, dy: number) {
  for (let i = 0; i < n; i++) {
    await page.mouse.wheel(0, dy);
    await page.waitForTimeout(16);
  }
}

/** Where to click `l`, resolved up front so Playwright's own checks don't count against the app. */
async function center(l: Locator): Promise<[number, number]> {
  await l.scrollIntoViewIfNeeded();
  const b = (await l.boundingBox())!;
  return [b.x + b.width / 2, b.y + b.height / 2];
}

/** Input → next paint for the slowest event since `from` (Event Timing; 16 ms floor). */
async function inputDelay(page: Page, from: number, names: string[]): Promise<number> {
  return page.evaluate(
    ([from, names]) => {
      const ev = (window as unknown as { __perf: { events: { name: string; start: number; dur: number }[] } }).__perf.events;
      return Math.max(16, ...ev.filter((e) => e.start >= from && names.includes(e.name)).map((e) => e.dur));
    },
    [from, names] as const,
  );
}

/** Open code files on screen still without syntax colors once the highlighter
 *  and render queue are idle: colors that arrived but were never painted, or
 *  never arrived. Not a budget: any one fails the check. */
const uncolored: string[] = [];
async function checkColors(page: Page, phase: string) {
  const paths = await page.evaluate(async () => {
    type View = { i: number; rendered: boolean; collapsed: boolean; f: { path: string; lang: string }; parsed: { hunks: unknown[] } | null; el: HTMLElement; body: HTMLElement };
    type App = { views: Map<number, View>; renderQueue: View[]; reasons: (string | null)[]; hl: { slots: { pending: number }[] } };
    const app = (window as unknown as { __prvApp: App }).__prvApp;
    for (const t = performance.now(); performance.now() - t < 5000; ) {
      await new Promise((r) => setTimeout(r, 50));
      if (!app.renderQueue.length && app.hl.slots.every((s) => !s.pending)) break;
    }
    await new Promise((r) => requestAnimationFrame(r));
    return [...app.views.values()]
      .filter((v) => {
        const r = v.el.getBoundingClientRect();
        return r.bottom > 0 && r.top < innerHeight && v.rendered && !v.collapsed && app.reasons[v.i] === null && v.f.lang !== 'text' && v.parsed?.hunks.length;
      })
      .filter((v) => !v.body.querySelector('[class*="tk"]'))
      .map((v) => v.f.path);
  });
  for (const p of paths) uncolored.push(`${phase}: ${p}`);
}

/** Run an interaction, then report its worst input latency and the jank it left behind. */
async function interaction(page: Page, names: string[], act: () => Promise<void>) {
  const t = await now(page);
  await act();
  const end = await settle(page, 500, 10_000);
  const fr = await frames(page, t, Math.max(end, t) + 1);
  return { input: await inputDelay(page, t, names), blocking: fr.blocking };
}

// ------------------------------------------------------------ one run

async function run(browser: Browser, emptyBodies = false): Promise<Metrics> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(probe);
  // Firefox has handed us empty 200 bodies for the worker script and for
  // grammars. The warmup run (unmeasured) gets one of each, and must still color.
  if (emptyBodies) {
    for (const [re, type] of [[/\/hl-worker\.js/, 'text/javascript'], [/\/api\/lang\//, 'application/json']] as const) {
      let first = true;
      await ctx.route(re, (route) => (first ? ((first = false), route.fulfill({ body: '', contentType: type })) : route.continue()));
    }
  }
  // The page refreshes a stale manifest from GitHub after it paints; answer
  // with the cached one so the run stays offline and the head never moves.
  await ctx.route(/\/api\/pr\/[^?]+$/, async (route) => {
    try {
      const res = await route.fetch({ url: `${route.request().url()}?cached=1` });
      const m = await res.json();
      delete m.stale;
      await route.fulfill({ response: res, json: m });
    } catch {} // the context closed mid-request
  });
  const page = await ctx.newPage();
  const out: Metrics = {};

  // First load.
  await page.goto(PAGE);
  await page.waitForFunction(() => (window as unknown as { __prvTimings?: unknown }).__prvTimings, null, { timeout: 60_000 });
  const settled = await settle(page);
  const load = await page.evaluate(() => {
    const t = (window as unknown as { __prvTimings: { marks: Record<string, number> } }).__prvTimings;
    const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? 0;
    const hl = (window as unknown as { __perf: { highlighted?: number } }).__perf.highlighted;
    return { firstPaint: t.marks.firstPaint!, fcp: Math.round(fcp), highlighted: Math.round(hl ?? -1), nodes: document.getElementsByTagName('*').length };
  });
  const lf = await frames(page, 0, Math.max(settled, load.firstPaint) + 1);
  out['load.firstPaint ms'] = load.firstPaint;
  out['load.fcp ms'] = load.fcp;
  out['load.highlighted ms'] = load.highlighted;
  out['load.settled ms'] = Math.round(Math.max(settled, load.firstPaint));
  out['load.blocking ms'] = lf.blocking;
  out['load.longestFrame ms'] = lf.max;
  out['load.domNodes'] = load.nodes;
  await checkColors(page, 'load');

  // Scroll down through the diff, as a wheel would.
  await page.mouse.move(900, 500);
  const blank = await page.evaluateHandle(() => {
    const s = { frames: 0, blank: 0, on: true };
    const tick = () => {
      if (!s.on) return;
      s.frames++;
      // A point that lands on a file's own box (its header and body are not
      // there yet, or not painted) or on a body or a long diff's table with nothing in it yet.
      const empty = (y: number) => {
        const el = document.elementFromPoint(900, innerHeight * y);
        return !!el && (el.classList.contains('file') || (el.matches('.js-file-content, .diff-segment') && !el.firstChild));
      };
      if ([0.3, 0.6, 0.9].some(empty)) s.blank++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return s;
  });
  await tracking(page, true);
  const t0 = await now(page);
  await wheel(page, 120, 250);
  const t1 = await now(page);
  const sf = await frames(page, t0, t1);
  const bs = await blank.evaluate((s) => ((s.on = false), s));
  out['scroll.longestFrame ms'] = sf.max;
  out['scroll.blocking ms'] = sf.blocking;
  out['scroll.blankFrames %'] = Math.round((100 * bs.blank) / Math.max(1, bs.frames));
  await settle(page, 500);
  await checkColors(page, 'scroll');

  // Drag a selected word away. A native drag ends the press with
  // pointercancel, not pointerup; files colored after it must still paint.
  // (No colored word means colors are already broken, and recorded above.)
  const word = page.locator('.file:not(.collapsed) span[class*="tk"]').filter({ hasText: /^[a-z]{4,}$/i }).first();
  if (await word.count()) {
    const [wx, wy] = await center(word);
    await page.mouse.dblclick(wx, wy);
    await page.mouse.move(wx, wy);
    await page.mouse.down();
    await page.mouse.move(wx + 200, wy + 200, { steps: 8 });
    await page.mouse.up();
  }

  // Drag the scrollbar far away: how long until the screen shows code.
  let worst = 0;
  let tb = 0;
  for (const frac of [0.5, 0.15, 0.85]) {
    const t = await now(page);
    const ms = await page.evaluate(async (frac) => {
      const empty = (y: number) => {
        const el = document.elementFromPoint(900, innerHeight * y);
        return !!el && (el.classList.contains('file') || (el.matches('.js-file-content, .diff-segment') && !el.firstChild));
      };
      const t = performance.now();
      scrollTo(0, frac * (document.documentElement.scrollHeight - innerHeight));
      for (;;) {
        await new Promise((r) => requestAnimationFrame(r));
        if (![0.3, 0.6, 0.9].some(empty) || performance.now() - t > 5000) return Math.round(performance.now() - t);
      }
    }, frac);
    worst = Math.max(worst, ms);
    const end = await settle(page, 500, 10_000);
    tb += (await frames(page, t, Math.max(end, t) + 1)).blocking;
    await checkColors(page, `teleport ${frac}`);
  }
  out['teleport.toContent ms'] = worst;
  out['teleport.blocking ms'] = tb;
  // Back up from there, into files that have not rendered yet.
  await page.mouse.move(900, 500);
  await wheel(page, 60, -250);
  await settle(page, 500);

  // j / k between files.
  worst = 0;
  let jb = 0;
  for (let i = 0; i < 8; i++) {
    const r = await interaction(page, ['keydown'], () => page.keyboard.press('j'));
    worst = Math.max(worst, r.input);
    jb += r.blocking;
  }
  out['next.input ms'] = worst;
  out['next.blocking ms'] = jb;

  // Jump far from the tree.
  worst = 0;
  jb = 0;
  for (const frac of [0.9, 0.3, 0.65]) {
    const rows = page.locator('.file-tree-nav li[data-path]:not(.is-gone)');
    const [x, y] = await center(rows.nth(Math.floor((await rows.count()) * frac)).locator('a'));
    await settle(page, 300);
    const r = await interaction(page, ['click', 'pointerdown', 'pointerup', 'mousedown', 'mouseup'], () => page.mouse.click(x, y));
    worst = Math.max(worst, r.input);
    jb += r.blocking;
  }
  out['treeJump.input ms'] = worst;
  out['treeJump.blocking ms'] = jb;
  await tracking(page, false);

  // Mark reviewed (collapses and moves to the next file).
  worst = 0;
  for (let i = 0; i < 3; i++) worst = Math.max(worst, (await interaction(page, ['keydown'], () => page.keyboard.press('v'))).input);
  out['review.input ms'] = worst;

  // Show tests, then hide them again: the biggest hide-state change.
  await page.locator('summary[aria-label="Hide files"]').click();
  const [cx, cy] = await center(page.locator('input[data-cat="tests"]'));
  let r = await interaction(page, ['click', 'input', 'change'], () => page.mouse.click(cx, cy));
  out['category.input ms'] = r.input;
  out['category.blocking ms'] = r.blocking;
  r = await interaction(page, ['click', 'input', 'change'], () => page.mouse.click(cx, cy));
  out['category.input ms'] = Math.max(out['category.input ms'], r.input);
  await page.keyboard.press('Escape');
  await page.locator('body').click({ position: { x: 5, y: 300 } });

  // Filter the tree.
  const t2 = await now(page);
  await page.locator('input[aria-label="Filter files"]').pressSequentially('src', { delay: 50 });
  await settle(page, 300);
  out['treeFilter.input ms'] = await inputDelay(page, t2, ['keydown', 'keypress', 'input', 'keyup']);
  await page.locator('input[aria-label="Filter files"]').fill('');

  // Unified → split repaints every rendered file.
  await page.locator('summary[aria-label="Settings"]').click();
  const [sx, sy] = await center(page.locator('[data-style="split"]'));
  r = await interaction(page, ['click', 'pointerup', 'mouseup'], () => page.mouse.click(sx, sy));
  out['split.input ms'] = r.input;
  out['split.blocking ms'] = r.blocking;
  await checkColors(page, 'split');
  // Back up through files laid out for the other view.
  await page.mouse.move(900, 500);
  await tracking(page, true);
  await wheel(page, 60, -250);
  await settle(page, 500);
  out['layout.shifts'] = await page.evaluate(() => (window as unknown as { __perf: { shifts: number } }).__perf.shifts);

  await ctx.close();
  return out;
}

// ------------------------------------------------------------ main

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

try {
  const sizes = {
    'bytes.html': (await (await fetch(PAGE)).text()).length,
    'bytes.manifest': (await (await fetch(`${API}?cached=1`)).text()).length,
  };
  // One browser, like a real one that is already open; the first run only warms it up.
  const browser = await firefox.launch({ headless: !flag('--headed') });
  const runs: Metrics[] = [];
  for (let i = 0; i <= RUNS; i++) {
    const r = await run(browser, i === 0);
    if (i) runs.push(r);
    process.stderr.write(i ? `run ${i}/${RUNS}\n` : 'warmup\n');
  }
  await browser.close();
  const measured: Metrics = { ...sizes };
  for (const k of Object.keys(runs[0]!)) measured[k] = median(runs.map((r) => r[k]!));
  if (flag('--json')) console.log(JSON.stringify({ measured, runs }));
  if (uncolored.length) {
    console.error(`perf: ${uncolored.length} file(s) on screen never got syntax colors:\n  ${[...new Set(uncolored)].slice(0, 20).join('\n  ')}`);
    process.exitCode = 1;
  }

  if (target) {
    for (const [k, v] of Object.entries(measured)) console.log(`${k.padEnd(28)} ${v}  (${runs.map((r) => r[k] ?? '').join(' ')})`);
  } else {
    const budget = readBudget();
    const failures = report('perf', measured, budget[SECTION]);
    if (flag('--ratchet')) {
      budget[SECTION] = ratchet(measured, budget[SECTION]);
      writeBudget(budget);
      console.log(`ratcheted ${BUDGET_FILE}`);
    } else if (failures) {
      console.error(`\nperf budget: ${failures} failure(s) — make it faster, don't raise the budget`);
      process.exitCode = 1;
    }
  }
} finally {
  server.kill();
  if (cache) rmSync(cache, { recursive: true, force: true });
}
