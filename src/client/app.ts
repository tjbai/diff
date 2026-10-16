import { CATEGORIES, defaultEnabledCategories } from '../geld.ts';
import type { ExportBundle, ExportRequest, FileEntry, Manifest, ManualState, ReviewedState } from '../types.ts';
import {
  buildRows,
  colgroup,
  diffstatBlocks,
  esc,
  expand,
  icon,
  parsePatch,
  patchDocs,
  renderRows,
  type Line,
  type Parsed,
  type Row,
  type Tokens,
} from './diff.ts';
import { extractEmbedded, fmt, gunzipBase64, h } from './dom.ts';
import { Highlighter, type Grammar } from './highlight.ts';
import type { IconName } from './icons.ts';
import { FileTree } from './tree.ts';

type Boot =
  | { mode: 'live'; owner: string; repo: string; number: number; manifest: Promise<Manifest>; workers?: Worker[] }
  | { mode: 'export' }
  | { mode: 'index' };
type DiffStyle = 'split' | 'unified';

declare global {
  interface Window {
    __prvBoot: Boot;
    __prvTimings?: Record<string, unknown>;
    /** The running viewer, for debugging from the console. */
    __prvApp?: App;
  }
}

/** v2: unified became the default; choices saved under the old key (written
 *  when split was the default) are ignored. */
const PREFS_KEY = 'prv:prefs:v2';
/** v2: Agent config is hidden by default too; selections saved under the old
 *  key (Geld's default, Tests only) are ignored. */
const CATS_KEY = 'prv:cats:v4';
const DEFAULT_HIDDEN = [...defaultEnabledCategories(), 'agents', 'docs', 'manual'];
/** Patches bigger than this start behind "Load diff", like GitHub's large diffs. */
const LARGE_PATCH = 150_000;
/** How much patch text to fetch ahead of need, at most (see `App.prefetch`). */
const PREFETCH_BYTES = 32_000_000;
/** Most text, both sides together, to send a file to the highlighter. */
const MAX_HIGHLIGHT = 2_000_000;
/** Rows per table in a long diff (see `FileView.paint`). */
const SEGMENT = 100;
const CAT_TITLE = new Map(CATEGORIES.map((c) => [c.id as string, c.title]));

const store = {
  get<T>(k: string, fallback: T): T {
    try {
      const v = localStorage.getItem(k);
      return v == null ? fallback : (JSON.parse(v) as T);
    } catch {
      return fallback;
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};

const marks: Record<string, number> = {};
const mark = (k: string) => (marks[k] ??= Math.round(performance.now()));

interface Source {
  mode: 'live' | 'export';
  manifest: Manifest;
  /** Patch text by file index; `null` means omitted from an export. */
  patches: Map<number, string | null>;
  bundle?: ExportBundle;
}

async function decodeBundle(b64: string): Promise<ExportBundle> {
  const bundle = JSON.parse(await gunzipBase64(b64)) as ExportBundle;
  if (bundle.v !== 1) throw new Error(`unsupported export version ${bundle.v}`);
  return bundle;
}

function sourceFromBundle(bundle: ExportBundle): Source {
  const patches = new Map<number, string | null>();
  bundle.patches.forEach((p, i) => patches.set(i, p));
  return { mode: 'export', manifest: bundle.manifest, patches, bundle };
}

let workerUrl: string | undefined;
async function highlightWorkerUrl(): Promise<string> {
  if (workerUrl) return workerUrl;
  const embedded = document.getElementById('prv-worker')?.textContent;
  // file:// pages cannot start workers from disk; a blob URL works everywhere.
  workerUrl = embedded
    ? URL.createObjectURL(new Blob([await gunzipBase64(embedded)], { type: 'text/javascript' }))
    : `/hl-worker.js${new URL(import.meta.url).search}`;
  return workerUrl;
}

/** Two highlighter workers. The live page starts them in its <head>, so Shiki
 *  loads while the manifest and this script do; take those the first time. */
async function highlightWorkers(): Promise<Worker[]> {
  const boot = window.__prvBoot;
  if (boot.mode === 'live' && boot.workers) {
    const w = boot.workers;
    boot.workers = undefined;
    return w;
  }
  const url = await highlightWorkerUrl();
  const out: Worker[] = [];
  for (let i = 0; i < 2; i++) {
    try {
      out.push(new Worker(url));
    } catch {}
  }
  return out;
}

/** GitHub renders `code` spans in PR titles. */
/** Throws a non-2xx response's `{ error }`. */
async function ok(res: Response) {
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? String(res.status));
}

function titleHtml(t: string): string {
  return t
    .split(/(`[^`]+`)/)
    .map((p) => (p.length > 2 && p.startsWith('`') && p.endsWith('`') ? `<code class="notranslate">${esc(p.slice(1, -1))}</code>` : esc(p)))
    .join('');
}

// ------------------------------------------------------------- one file

/** A rendered body's height, roughly: GitHub's 20px rows, capped. */
const fileEstimate = (f: FileEntry) => Math.min(40000, (f.additions + f.deletions) * 20 + 60);

/** One file's box, empty and sized for content-visibility (`auto` makes the
 *  browser remember the real height once it renders). Its header and body
 *  fill in when it nears the viewport: the browser builds layout objects for
 *  every element not `display: none`, so a 2,000-file PR mounts 2,000
 *  elements, not 40,000. */
function fileShellHtml(f: FileEntry, i: number, hidden: boolean, reviewed: boolean): string {
  return `<div class="file${reviewed ? ' collapsed is-reviewed' : ''}" data-i="${i}"${hidden ? ' hidden' : ''} style="contain-intrinsic-size:auto ${reviewed ? 38 : fileEstimate(f) + 38}px"></div>`;
}

/** A file's header and its empty body. */
function fileInnerHtml(f: FileEntry, reviewed: boolean): string {
  const binary = f.kinds?.includes('binary');
  const name = f.prevPath ? `${f.prevPath} → ${f.path}` : f.path;
  const stat =
    (f.additions ? `<span class="color-fg-success">+${fmt(f.additions)}</span>` : '') +
    (f.deletions ? `<span class="color-fg-danger">−${fmt(f.deletions)}</span>` : '');
  const est = fileEstimate(f);
  return (
    `<div class="file-header"><div class="file-info">` +
    `<button type="button" class="btn-octicon js-details-target" data-act="toggle" aria-label="Toggle diff contents" aria-expanded="${!reviewed}">${icon('chevron-down', 'toggle-chevron')}</button>` +
    `<span class="Truncate"><a class="Link--primary Truncate-text" title="${esc(name)}" href="#" data-act="top"><bdi>${esc(name)}</bdi></a></span>` +
    `</div><div class="file-actions">` +
    `<span class="diffstat">${binary ? 'BIN' : stat} ${diffstatBlocks(f.additions, f.deletions, f.status === 'added')}</span>` +
    `<label class="btn btn-sm reviewed-toggle" title="Mark reviewed (v)"><input type="checkbox" data-act="review"${reviewed ? ' checked' : ''}> Reviewed</label>` +
    `<button type="button" class="btn-octicon" data-act="hide" aria-label="Hide file" title="Hide file (h)">${icon('eye-closed')}</button></div></div>` +
    `<div class="js-file-content" style="contain-intrinsic-size:auto ${est}px"></div>`
  );
}

class FileView {
  body: HTMLElement;
  rendered = false;
  parsed: Parsed | null = null;
  rows: Row[] = [];
  tokens: Tokens | null = null;
  full: { old: string[]; new: string[] } | null = null;
  private hydrating: Promise<void> | null = null;

  constructor(
    private app: App,
    readonly i: number,
    readonly el: HTMLElement,
  ) {
    if (!el.firstChild) el.innerHTML = fileInnerHtml(this.f, app.isReviewed(i));
    this.body = el.lastElementChild as HTMLElement;
  }

  get f() {
    return this.app.files[this.i]!;
  }

  get collapsed() {
    return this.el.classList.contains('collapsed');
  }

  message(html: string) {
    this.body.innerHTML = `<div class="data highlight empty">${html}</div>`;
  }

  render() {
    this.rendered = true;
    const f = this.f;
    const patch = this.app.src.patches.get(this.i);
    if (patch === null) return this.message('Not included in this export.');
    if (f.size > LARGE_PATCH && !this.app.forceLoad.has(this.i)) {
      return this.message(
        `<button type="button" class="btn-link load-diff" data-act="load">Load diff</button><div class="load-note">Large diffs are not rendered by default.</div>`,
      );
    }
    if (patch === undefined) {
      this.rendered = false;
      this.app.requestPatch(this.i);
      return;
    }
    if (!this.parsed) {
      this.parsed = parsePatch(patch);
      const expandable = this.app.live && f.status !== 'added' && f.status !== 'deleted';
      this.rows = buildRows(this.parsed, expandable, expandable);
    }
    if (this.parsed.binary) return this.message('Binary file not shown.');
    if (!this.parsed.hunks.length) {
      if (f.kinds?.includes('renames')) return this.message('File renamed without changes.');
      if (f.kinds?.includes('modes')) return this.message('File mode changed.');
      return this.message(f.status === 'added' ? 'Empty file.' : 'File without changes.');
    }
    this.paint();
    if (this.tokens) return;
    // A hunk can open inside a docstring or a call, which only the lines
    // above it reveal: color from the patch first, then recolor from the
    // whole files, which queue behind the patches on screen.
    const whole = this.app.live && f.status !== 'added' && f.status !== 'deleted';
    void this.highlight().then(() => (whole ? this.hydrate().catch(() => {}) : undefined));
  }

  paint() {
    if (!this.parsed?.hunks.length) return;
    const mode = this.app.diffStyle;
    let max = 0;
    for (const r of this.rows) if (r.type === 'line') max = Math.max(max, r.line.o, r.line.n);
    const trs = renderRows(this.rows, mode, this.tokens);
    const table = (rows: string[]) =>
      `<table class="diff-table js-diff-table tab-size${mode === 'split' ? ' file-diff-split' : ''}" data-tab-size="8">${colgroup(mode, max)}<tbody>${rows.join('')}</tbody></table>`;
    // A long diff is a stack of tables, each skipped by content-visibility
    // while off screen, so landing on a 3,000-line file styles and lays out
    // the hundred rows you see, not all of them.
    let html = '';
    if (trs.length <= SEGMENT) html = table(trs);
    else for (let s = 0; s < trs.length; s += SEGMENT) html += `<div class="diff-segment" style="contain-intrinsic-size:auto ${Math.min(SEGMENT, trs.length - s) * 20}px">${table(trs.slice(s, s + SEGMENT))}</div>`;
    this.body.innerHTML = `<div class="diff-table-wrap">${html}</div>`;
  }

  async highlight() {
    const f = this.f;
    if (f.lang === 'text') return;
    // Old-side documents first, then new-side ones.
    let docs: string[];
    let nOld: number;
    let oldIdx: (l: Line) => number;
    let newIdx: (l: Line) => number;
    const whole = this.full && [this.full.old.join('\n'), this.full.new.join('\n')];
    if (whole && whole[0]!.length + whole[1]!.length <= MAX_HIGHLIGHT) {
      docs = whole;
      nOld = 1;
      oldIdx = (l) => l.o - 1;
      newIdx = (l) => l.n - 1;
    } else {
      const d = patchDocs(this.rows);
      docs = [...d.old, ...d.new];
      nOld = d.old.length;
      oldIdx = (l) => d.oldIdx.get(l) ?? -1;
      newIdx = (l) => d.newIdx.get(l) ?? -1;
    }
    if (docs.reduce((a, s) => a + s.length, 0) > MAX_HIGHLIGHT) return;
    const full = this.full;
    const out = await this.app.hl.tokenize(f.lang, docs);
    if (!out || this.full !== full) return;
    this.tokens = { old: out.slice(0, nOld).flat(), new: out.slice(nOld).flat(), oldIdx, newIdx };
    if (!this.collapsed) this.app.paintWhenIdle(this);
  }

  /** Fetch both full files once; expansion and full-file highlighting need them. */
  hydrate(): Promise<void> {
    this.hydrating ??= (async () => {
      const f = this.f;
      const [o, n] = await Promise.all([this.app.fetchFile('old', f.prevPath ?? f.path), this.app.fetchFile('new', f.path)]);
      const split = (s: string) => {
        const a = s.split('\n');
        if (a[a.length - 1] === '') a.pop();
        return a.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
      };
      // The patch's colors stay up until the whole files' replace them.
      this.full = { old: split(o), new: split(n) };
      void this.highlight();
    })();
    return this.hydrating;
  }

  async expand(row: number, dir: 'up' | 'down' | 'all') {
    await this.hydrate();
    expand(this.rows, row, dir, this.full!.new);
    this.paint();
  }

  setCollapsed(c: boolean) {
    this.el.classList.toggle('collapsed', c);
    this.el.querySelector('.js-details-target')!.setAttribute('aria-expanded', String(!c));
    // Tokens that landed while collapsed were never painted.
    if (!c && this.tokens) this.app.paintWhenIdle(this);
  }
}

// ------------------------------------------------------------- the page

class App {
  m!: Manifest;
  files!: FileEntry[];
  enabled: Set<string>;
  manual: ManualState = {};
  reviewed: ReviewedState = {};
  diffStyle: DiffStyle;
  reasons: (string | null)[] = [];
  visible: number[] = [];
  views = new Map<number, FileView>();
  forceLoad = new Set<number>();
  hl!: Highlighter;
  tree: FileTree;
  current = -1;
  el = {
    root: h('div', { class: 'prv' }),
    /** Repository chrome, title, and tabs; scrolls away. */
    top: h('div', { class: 'pr-top' }),
    /** The toolbar; sticks, and shows the title once the top has scrolled away. */
    header: h('header', { class: 'pr-header' }),
    flash: h('div', { class: 'flash-container' }),
    layout: h('div', { class: 'diff-layout' }),
    sidebar: h('div', { class: 'diff-sidebar' }),
    list: h('div', { class: 'js-diff-progressive-container' }),
  };
  private io: IntersectionObserver;
  private refreshing = false;
  /** Detaches window/document listeners when a dropped export replaces this view. */
  readonly ac = new AbortController();

  constructor(readonly src: Source) {
    this.diffStyle = store.get<{ diffStyle?: DiffStyle }>(PREFS_KEY, {}).diffStyle ?? src.bundle?.prefs.diffStyle ?? 'unified';
    if (src.mode === 'export') {
      // Exports leave hand-hidden files out, so they stay hidden there.
      this.enabled = new Set([...src.bundle!.enabledCats, 'manual']);
      this.manual = { ...src.bundle!.manual };
    } else {
      this.enabled = new Set(store.get<string[]>(CATS_KEY, [...store.get<string[]>('prv:cats:v3', DEFAULT_HIDDEN), 'manual']));
    }
    this.tree = new FileTree((p) => this.peekTo(this.files.findIndex((f) => f.path === p)));
    // Bodies render only as they come near the viewport.
    this.io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const v = this.view(Number((e.target as HTMLElement).dataset.i));
          if (!v.rendered) this.queueRender(v);
        }
      },
      { rootMargin: '1200px 0px' },
    );
    this.setManifest(src.manifest);
  }

  get live() {
    return this.src.mode === 'live';
  }
  /** Each viewer's own marks: per PR live, per export file for a recipient. */
  get reviewedKey() {
    const { owner, repo, number } = this.m.meta;
    const scope = this.live ? '' : `@${this.src.bundle!.exportedAt}`;
    return `prv:reviewed:${owner}/${repo}#${number}${scope}`;
  }
  get manualKey() {
    const { owner, repo, number } = this.m.meta;
    return `prv:manual:${owner}/${repo}#${number}`;
  }

  setManifest(m: Manifest) {
    this.m = m;
    this.files = m.files;
    if (this.live) this.manual = store.get<ManualState>(this.manualKey, {});
    this.reviewed = store.get<ReviewedState>(this.reviewedKey, {});
    // A mark holds only while the file's diff is the one that was reviewed.
    const hashes = new Map(m.files.map((f) => [f.path, f.hash]));
    let dropped = 0;
    for (const [path, h] of Object.entries(this.reviewed)) if (hashes.get(path) !== h) (delete this.reviewed[path], dropped++);
    if (dropped) store.set(this.reviewedKey, this.reviewed);
    this.views.clear();
    this.forceLoad.clear();
    this.renderQueue.length = 0;
    this.reasons = [];
  }

  /** One shell per file, in one parse. Hiding and showing only flips `hidden`. */
  mountShells() {
    this.io.disconnect();
    this.peek = null;
    const reasons = this.files.map((f) => this.reasonFor(f));
    this.el.list.innerHTML = this.files.map((f, i) => fileShellHtml(f, i, reasons[i] !== null, this.isReviewed(i))).join('');
    for (const el of this.el.list.children) this.io.observe(el);
    this.tree.setFiles(this.files.map((f, i) => ({ i, path: f.path, status: f.status, reviewed: this.isReviewed(i) })));
    this.renderFilterMenu();
  }

  // ----------------------------------------------------------- hide model

  manualFor(path: string): 'hide' | 'show' | undefined {
    const m = this.manual;
    if (m[path]) return m[path];
    for (let i = path.lastIndexOf('/'); i > 0; i = path.lastIndexOf('/', i - 1)) {
      const v = m[path.slice(0, i + 1)];
      if (v) return v;
    }
    return undefined;
  }

  reasonFor(f: FileEntry): string | null {
    const m = this.manualFor(f.path);
    if (m === 'show') return null;
    if (m === 'hide' && this.enabled.has('manual')) return 'manual';
    return f.cats.find((c) => this.enabled.has(c)) ?? null;
  }

  saveManual() {
    if (this.live) store.set(this.manualKey, this.manual);
    this.renderFilterMenu();
  }

  /** `h` / the eye: hide a shown file by hand. With Manual off, hand-hidden
   *  files are shown, and this unhides them instead. */
  hideFile(path: string) {
    const was = this.manual[path];
    delete this.manual[path];
    const f = this.files.find((x) => x.path === path);
    if (f && was !== 'hide' && this.reasonFor(f) === null) {
      this.manual[path] = 'hide';
      if (!this.enabled.has('manual')) return (this.saveManual(), this.toggleCategory('manual'));
    }
    this.saveManual();
    this.update();
  }


  isReviewed(i: number): boolean {
    const f = this.files[i]!;
    return this.reviewed[f.path] === f.hash;
  }

  /** Mark or unmark one file: collapse or expand it, and update its tree row.
   *  Marking moves on to the next unreviewed file. */
  setReviewed(i: number, on: boolean) {
    const f = this.files[i]!;
    if (on) this.reviewed[f.path] = f.hash;
    else delete this.reviewed[f.path];
    store.set(this.reviewedKey, this.reviewed);
    if (this.peek === i) this.peek = null;
    const v = this.view(i);
    v.el.classList.toggle('is-reviewed', on);
    v.el.querySelector<HTMLInputElement>('input[data-act=review]')!.checked = on;
    v.setCollapsed(on);
    this.tree.setReviewed(i, on);
    const approve = this.el.header.querySelector('.approve');
    if (approve) approve.outerHTML = this.approveHtml();
    if (!on) return;
    const at = this.visible.indexOf(i);
    const next = [...this.visible.slice(at + 1), ...this.visible.slice(0, at)].find((j) => !this.isReviewed(j));
    if (next !== undefined) this.jumpTo(next);
  }

  toggleCategory(id: string) {
    if (this.enabled.has(id)) this.enabled.delete(id);
    else this.enabled.add(id);
    if (this.live) store.set(CATS_KEY, [...this.enabled]);
    this.update();
  }

  // ----------------------------------------------------------- data

  async loadPatches(idx: number[]) {
    const missing = idx.filter((i) => !this.src.patches.has(i) && (this.files[i]!.size <= LARGE_PATCH || this.forceLoad.has(i)));
    if (!missing.length || !this.live) return;
    const key = this.m.key;
    const res = await fetch('/api/patches', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, ids: missing }),
    });
    if (!res.ok) throw new Error(`patches: ${res.status} ${await res.text()}`);
    const out = (await res.json()) as (string | null)[];
    if (key !== this.m.key) return;
    missing.forEach((i, j) => this.src.patches.set(i, out[j] ?? null));
  }

  /** Fetch the rest of the shown files' patches while the page is idle, so
   *  a jump or a fast scroll renders without waiting on the server. */
  async prefetch() {
    const key = this.m.key;
    let left = PREFETCH_BYTES;
    while (left > 0) {
      await new Promise((r) => requestIdleCallback(r, { timeout: 500 }));
      if (key !== this.m.key) return;
      const batch: number[] = [];
      let bytes = 0;
      for (const i of this.visible) {
        const size = this.files[i]!.size;
        if (this.src.patches.has(i) || size > LARGE_PATCH) continue;
        batch.push(i);
        if ((bytes += size) > 1_000_000) break;
      }
      if (!batch.length) return;
      left -= bytes;
      await this.loadPatches(batch).catch(() => {});
    }
  }

  /** Batch patch requests from files about to render. */
  private wantPatch = new Set<number>();
  requestPatch(i: number) {
    if (this.wantPatch.has(i)) return;
    this.wantPatch.add(i);
    if (this.wantPatch.size > 1) return;
    setTimeout(async () => {
      const ids = [...this.wantPatch];
      try {
        await this.loadPatches(ids);
      } catch (e) {
        this.flash(e instanceof Error ? e.message : String(e));
      }
      this.wantPatch.clear();
      for (const i of ids) {
        const v = this.views.get(i);
        if (v && !v.rendered && this.reasons[i] === null) this.queueRender(v);
      }
    }, 0);
  }

  /** Render (or repaint) bodies a few milliseconds per frame, so no frame stalls. */
  private renderQueue: FileView[] = [];
  private renderScheduled = false;
  queueRender(v: FileView, repaint = false) {
    if (!this.renderQueue.includes(v)) this.renderQueue.push(v);
    (v as { repaint?: boolean }).repaint ||= repaint;
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    const step = () => {
      const t = performance.now();
      // Files on screen first, then outward: after a long jump the queue
      // also holds everything in the observer's margin above the viewport.
      const away = (v: FileView) => {
        const r = v.el.getBoundingClientRect();
        return r.bottom < 0 ? -r.bottom : Math.max(0, r.top - innerHeight);
      };
      const order = new Map(this.renderQueue.map((v) => [v, away(v)]));
      this.renderQueue.sort((a, b) => order.get(a)! - order.get(b)!);
      while (this.renderQueue.length && performance.now() - t < 8) {
        const next = this.renderQueue.shift()! as FileView & { repaint?: boolean };
        if (next.repaint) {
          next.repaint = false;
          if (next.rendered) next.paint();
        } else if (!next.rendered && this.reasons[next.i] === null) next.render();
      }
      if (this.renderQueue.length) requestAnimationFrame(step);
      else this.renderScheduled = false;
    };
    requestAnimationFrame(step);
  }

  async fetchFile(side: 'old' | 'new', path: string): Promise<string> {
    const r = await fetch(`/api/file?key=${encodeURIComponent(this.m.key)}&side=${side}&path=${encodeURIComponent(path)}`);
    if (!r.ok) throw new Error(`could not load ${path}`);
    return r.text();
  }

  /** File `i`'s box, filled in or not. Enough for geometry. */
  shell(i: number): HTMLElement {
    return this.el.list.children[i] as HTMLElement;
  }

  view(i: number): FileView {
    let v = this.views.get(i);
    if (!v) {
      v = new FileView(this, i, this.shell(i));
      this.views.set(i, v);
    }
    return v;
  }

  /** Apply the hide state: flip `hidden` on the files and tree rows that
   *  changed, and refresh the header counts. Nothing else is rebuilt. */
  update() {
    const prev = this.reasons;
    this.reasons = this.files.map((f) => this.reasonFor(f));
    this.visible = [];
    this.reasons.forEach((r, i) => {
      if (r === null) this.visible.push(i);
      if ((prev[i] === null) !== (r === null) || prev.length === 0) this.shell(i).hidden = r !== null;
    });
    this.tree.setHidden((i) => this.reasons[i] !== null);
    for (const input of this.tree.extra.querySelectorAll<HTMLInputElement>('input[data-cat]')) input.checked = this.enabled.has(input.dataset.cat!);
    this.tree.extra.querySelector('summary')?.classList.toggle('is-filtering', this.visible.length < this.files.length);
    this.renderHeaderStats();
  }

  /** Repaint a file with fresh tokens, but never under a live selection or drag. */
  private deferred = new Set<FileView>();
  private pointerDown = false;
  paintWhenIdle(v: FileView) {
    if (!this.selectionIn(v)) return this.queueRender(v, true);
    this.deferred.add(v);
  }
  private selectionIn(v: FileView): boolean {
    if (this.pointerDown) return true;
    const sel = document.getSelection();
    return !!sel && !sel.isCollapsed && sel.rangeCount > 0 && v.body.contains(sel.getRangeAt(0).commonAncestorContainer);
  }
  flushDeferred() {
    for (const v of [...this.deferred]) {
      if (this.selectionIn(v)) continue;
      this.deferred.delete(v);
      this.queueRender(v, true);
    }
  }

  // ----------------------------------------------------------- navigation

  stickyTop() {
    return this.el.header.getBoundingClientRect().height;
  }

  /** Where a file lands when you jump to it: level with the sidebar's first row. */
  landTop() {
    return this.stickyTop() + (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--land-gap')) || 0);
  }

  /** Top-align a file at the landing line and make it current, even when it
   *  is already on screen. The spacer after the last file makes room. */
  jumpTo(i: number) {
    if (i < 0 || this.reasons[i] !== null) return;
    this.endPeek(i);
    const v = this.view(i);
    if (!v.rendered) v.render();
    this.holdAt(v.el);
    this.setCurrent(this.visible.indexOf(i));
  }

  /** A reviewed file opened from the tree. It stays open until another file is picked. */
  peek: number | null = null;

  /** Jump from the tree: a reviewed file opens until you move on to another one. */
  peekTo(i: number) {
    this.jumpTo(i);
    if (i < 0 || this.reasons[i] !== null || !this.isReviewed(i) || !this.view(i).collapsed) return;
    this.view(i).setCollapsed(false);
    this.peek = i;
  }

  /** Collapse the peeked file again, unless `keep` is it. Holds `keep` in place. */
  endPeek(keep: number) {
    const p = this.peek;
    if (p === null || p === keep) return;
    this.peek = null;
    if (!this.isReviewed(p)) return;
    const el = this.view(keep).el;
    const top = el.getBoundingClientRect().top;
    this.view(p).setCollapsed(true);
    window.scrollBy(0, el.getBoundingClientRect().top - top);
  }

  /** The one current file: the tree's active row and the file's outline. */
  setCurrent(idx: number) {
    if (idx === this.current) return;
    this.el.list.querySelector('.file.is-current')?.classList.remove('is-current');
    this.current = idx;
    const i = this.visible[idx];
    if (i === undefined) return this.tree.setActive(null);
    this.view(i).el.classList.add('is-current');
    this.tree.setActive(this.files[i]!.path);
  }

  /** Scroll `el` to the landing line and keep it there for a moment: files
   *  near the viewport render and replace their estimated heights, which would
   *  otherwise push it away. Any user scroll input ends the hold. */
  private holdToken = 0;
  /** True while a jump is aligning, so scroll tracking doesn't fight it. */
  private holding = false;
  holdAt(el: HTMLElement) {
    const token = ++this.holdToken;
    this.holding = true;
    const stop = () => {
      if (this.holdToken === token) (this.holdToken++, (this.holding = false));
    };
    for (const ev of ['wheel', 'touchstart', 'pointerdown', 'keydown']) window.addEventListener(ev, stop, { once: true, capture: true, signal: this.ac.signal });
    let stable = 0;
    let frames = 0;
    const align = () => {
      if (this.holdToken !== token) return;
      const d = el.getBoundingClientRect().top - this.landTop();
      if (Math.abs(d) > 0.5) {
        window.scrollBy(0, d);
        stable = 0;
      } else stable++;
      if (stable < 6 && ++frames < 90) requestAnimationFrame(align);
      else stop();
    };
    align();
  }

  currentIndex(): number {
    const top = this.landTop() + 2;
    let lo = 0;
    let hi = this.visible.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.shell(this.visible[mid]!).getBoundingClientRect().top <= top) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  go(delta: number) {
    if (!this.visible.length) return;
    const cur = this.currentIndex();
    let next = cur + delta;
    if (delta < 0 && this.shell(this.visible[cur]!).getBoundingClientRect().top < this.landTop() - 4) next = cur;
    next = Math.max(0, Math.min(this.visible.length - 1, next));
    this.jumpTo(this.visible[next]!);
  }

  onScroll() {
    if (!this.visible.length) return;
    const idx = this.currentIndex();
    if (!this.holding) this.setCurrent(idx);
  }

  // ----------------------------------------------------------- actions

  async refresh() {
    if (!this.live || this.refreshing) return;
    this.refreshing = true;
    const t = performance.now();
    try {
      const { owner, repo, number } = this.m.meta;
      const res = await fetch(`/api/pr/${owner}/${repo}/${number}`);
      await ok(res);
      const m = (await res.json()) as Manifest;
      const changed = m.key !== this.m.key;
      if (changed) {
        this.src.patches.clear();
        this.setManifest(m);
        this.mountShells();
        this.update();
        this.renderHeader();
        void this.prefetch();
      } else if (JSON.stringify(m.meta) !== JSON.stringify(this.m.meta)) {
        this.m = { ...this.m, meta: m.meta };
        this.renderHeader();
      }
      if (this.el.flash.firstChild) this.flash(null);
      console.info(`diff: refresh ${changed ? `→ ${m.headSha.slice(0, 7)}` : 'unchanged'} in ${Math.round(performance.now() - t)} ms`, m.timings);
    } catch (e) {
      this.flash(`Refresh failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.refreshing = false;
    }
  }

  flash(msg: string | null) {
    this.el.flash.replaceChildren(...(msg ? [h('div', { class: 'flash flash-error' }, msg)] : []));
  }

  async exportHtml(btn: HTMLButtonElement) {
    btn.disabled = true;
    try {
      const req: ExportRequest = {
        key: this.m.key,
        enabledCats: [...this.enabled],
        manual: this.enabled.has('manual') ? this.manual : {},
        omit: this.files.map((_, i) => i).filter((i) => this.reasons[i] !== null),
        prefs: { diffStyle: this.diffStyle },
      };
      const t = performance.now();
      const res = await fetch('/api/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) });
      await ok(res);
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'diff-export.html';
      const a = h('a', { href: URL.createObjectURL(blob), download: name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      console.info(`diff: exported ${name} (${(blob.size / 1e6).toFixed(2)} MB) in ${Math.round(performance.now() - t)} ms`);
    } catch (e) {
      this.flash(`Export failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      btn.disabled = false;
    }
  }

  setDiffStyle(s: DiffStyle) {
    if (s === this.diffStyle) return;
    this.diffStyle = s;
    store.set(PREFS_KEY, { diffStyle: s });
    this.el.root.dataset.diffStyle = s;
    for (const v of this.views.values()) if (v.rendered) this.queueRender(v, true);
    this.renderHeader();
  }

  onListClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const fileEl = t.closest<HTMLElement>('.file');
    if (!fileEl) return;
    const v = this.view(Number(fileEl.dataset.i));
    // Any click in a file makes it current; a click on its header also top-aligns it.
    const inHeader = !!t.closest('.file-header');
    this.endPeek(v.i);
    this.setCurrent(this.visible.indexOf(v.i));
    const exp = t.closest<HTMLElement>('[data-expand]');
    if (exp) return void v.expand(Number(exp.dataset.row), exp.dataset.expand as 'up' | 'down' | 'all');
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (!act) return void (inHeader && this.jumpTo(v.i));
    if (act === 'review') return this.setReviewed(v.i, (t as HTMLInputElement).checked);
    e.preventDefault();
    if (act === 'toggle') (v.setCollapsed(!v.collapsed), this.jumpTo(v.i));
    else if (act === 'hide') this.hideFile(v.f.path);
    else if (act === 'top') this.jumpTo(v.i);
    else if (act === 'load') {
      this.forceLoad.add(v.i);
      void this.loadPatches([v.i]).then(() => v.render());
    }
  }

  // ----------------------------------------------------------- chrome

  /** Re-render a chrome region, keeping any of its menus open. */
  private paintKeepingMenus(el: HTMLElement, html: string) {
    const open = [...el.querySelectorAll<HTMLElement>('details[open][data-menu]')].map((d) => d.dataset.menu);
    el.innerHTML = html;
    for (const m of open) el.querySelector(`details[data-menu="${m}"]`)?.setAttribute('open', '');
  }

  /** The header's right side: diffstat, the gear (view, export), and
   *  Approve. It follows the hide state, so it repaints on its own. */
  renderHeaderStats() {
    const stat = this.el.top.querySelector<HTMLElement>('.pr-tabnav-stat');
    const toolbar = this.el.header.querySelector<HTMLElement>('.pr-toolbar');
    if (!stat || !toolbar) return;
    stat.innerHTML = this.diffstatHtml();
    this.el.top.querySelector('.tabnav-tab .Counter')!.textContent = fmt(this.visible.length);
    const radio = (v: DiffStyle, label: string) =>
      `<button type="button" class="ActionListItem" role="menuitemradio" aria-checked="${this.diffStyle === v}" data-style="${v}"><span class="check">${this.diffStyle === v ? icon('check') : ''}</span>${label}</button>`;
    this.paintKeepingMenus(
      toolbar,
      `<details class="details-reset details-overlay select-menu" data-menu="view"><summary class="btn btn-sm btn-icon" aria-label="Settings" title="Settings">${icon('gear')}<span class="dropdown-caret"></span></summary><div class="select-menu-modal settings-menu"><div class="ActionList">` +
        `<div class="menu-heading">View</div>${radio('unified', 'Unified')}${radio('split', 'Split')}` +
        (this.live ? `<div class="ActionList-sectionDivider" role="presentation"></div><button type="button" class="ActionListItem" data-act="export"><span class="check">${icon('download')}</span>Export .html</button>` : '') +
        `</div></div></details>` +
        this.approveHtml(),
    );
  }

  renderHeader() {
    const { meta } = this.m;
    const verb = meta.state === 'merged' ? 'merged' : 'wants to merge';
    const exportedAt = this.live ? null : new Date(this.src.bundle!.exportedAt);
    const snapshot = exportedAt
      ? `<span class="snapshot" title="Exported from diff ${esc(exportedAt.toLocaleString())}">· snapshot ${esc(exportedAt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}</span>`
      : '';
    // An export has no server, so its repository links go to github.com.
    const site = this.live ? '' : 'https://github.com';
    const ext = this.live ? '' : ' target="_blank" rel="noreferrer"';
    const base = `${site}/${esc(meta.owner)}/${esc(meta.repo)}`;
    const tab = (href: string, name: IconName, label: string, selected: boolean) =>
      `<a class="UnderlineNav-item" href="${href}"${ext}${selected ? ' aria-current="page"' : ''}>${icon(name)}${label}</a>`;
    // Fork PRs label both sides `owner:branch`, as GitHub does.
    const headOwner = meta.headRepo?.split('/')[0];
    const ref = (cls: string, repo: string, name: string, owner?: string) =>
      `<a class="commit-ref ${cls}" href="${site}/${esc(repo)}/tree/${esc(name)}"${ext}>${esc(owner ? `${owner}:${name}` : name)}</a>`;
    const title = `<bdi class="pr-title">${titleHtml(meta.title)}</bdi> <span class="pr-number">#${meta.number}</span>`;
    this.el.top.innerHTML =
      `<div class="repohead"><div class="repohead-title"><a href="${base}"${ext}>${esc(meta.owner)}</a><span>/</span><a href="${base}"${ext}><strong>${esc(meta.repo)}</strong></a></div>` +
      `<nav class="UnderlineNav" aria-label="Repository">${tab(base, 'code', 'Code', false)}${tab(`${base}/pulls`, 'git-pull-request', 'Pull requests', true)}</nav></div>` +
      `<div class="gh-header"><h1 class="gh-header-title">${title}</h1>` +
      `<div class="gh-header-meta">${this.stateBadge()}<span class="pr-meta-text">` +
      `<a class="author" href="https://github.com/${esc(meta.author)}" target="_blank" rel="noreferrer">${esc(meta.author)}</a> ${verb} ${fmt(meta.commits)} commit${meta.commits === 1 ? '' : 's'} into ` +
      ref('base-ref', `${meta.owner}/${meta.repo}`, meta.baseRef, headOwner && meta.owner) + ' from ' +
      ref('head-ref', meta.headRepo ?? `${meta.owner}/${meta.repo}`, meta.headRef, headOwner) +
      `${snapshot}</span></div></div>` +
      `<div class="tabnav"><nav class="tabnav-tabs" aria-label="Pull request"><span class="tabnav-tab" aria-current="page">${icon('file-diff')}Files changed<span class="Counter"></span></span></nav><div class="pr-tabnav-stat"></div></div>`;
    this.paintKeepingMenus(
      this.el.header,
      `<div class="pr-sticky-title">${this.stateBadge()}<span class="pr-sticky-text">${title}</span></div><div class="pr-toolbar"></div>`,
    );
    this.renderHeaderStats();
    document.title = `${meta.title} by ${meta.author} · Pull Request #${meta.number} · ${meta.owner}/${meta.repo}`;
  }

  /** Review progress and the primary action in one: it fills as files are
   *  marked reviewed and turns solid once all shown files are. Without
   *  Approve (your own PR, a closed one, an export) it is just the progress. */
  approveHtml(): string {
    const { meta, headSha } = this.m;
    const total = this.visible.length;
    const done = this.visible.filter((i) => this.isReviewed(i)).length;
    const all = total > 0 && done === total;
    const attrs = `style="--p:${total ? (done / total) * 100 : 0}%" title="${done} of ${total} shown files reviewed`;
    const count = `<span class="approve-count">${fmt(done)}/${fmt(total)}</span>`;
    if (!this.live || meta.viewerDidAuthor || meta.state === 'merged' || meta.state === 'closed')
      return `<span class="btn btn-sm approve is-static${all ? ' is-done' : ''}" ${attrs}">${count} reviewed</span>`;
    if (meta.approvedSha === headSha) return `<span class="btn btn-sm approve is-approved" ${attrs}">${icon('check')} Approved ${count}</span>`;
    return `<button type="button" class="btn btn-sm approve${all ? ' is-done' : ''}" data-act="approve" ${attrs}; approves ${headSha.slice(0, 7)}, the commit shown">Approve ${count}</button>`;
  }

  async approve(btn: HTMLButtonElement) {
    btn.disabled = true;
    try {
      const { owner, repo, number } = this.m.meta;
      const res = await fetch('/api/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ owner, repo, number, headSha: this.m.headSha }),
      });
      await ok(res);
      this.m = { ...this.m, meta: (await res.json()) as Manifest['meta'] };
      this.flash(null);
    } catch (e) {
      this.flash(`Approve failed: ${e instanceof Error ? e.message : e}`);
    }
    this.renderHeader();
  }

  /** "+A −D" over shown files. Hovering shows the
   *  all-file totals and what is hidden, by category and by hand. */
  diffstatHtml(): string {
    const sum = (idx: number[]): [number, number] => {
      let a = 0;
      let d = 0;
      for (const i of idx) (a += this.files[i]!.additions), (d += this.files[i]!.deletions);
      return [a, d];
    };
    const [adds, dels] = sum(this.visible);
    const stat = (a: number, d: number) => `<span class="color-fg-success">+${fmt(a)}</span> <span class="color-fg-danger">−${fmt(d)}</span>`;
    const byReason = new Map<string, number[]>();
    this.reasons.forEach((r, i) => r && (byReason.get(r) ?? byReason.set(r, []).get(r)!).push(i));
    const row = (label: string, idx: number[], cls = '') => {
      const [a, d] = sum(idx);
      return `<div class="ds-row${cls}"><span class="ds-label">${label}</span><span class="ds-count">${fmt(idx.length)}</span><span class="ds-stat">${stat(a, d)}</span></div>`;
    };
    const hiddenIdx = [...byReason.values()].flat();
    const reasons = ['manual', ...CATEGORIES.map((c) => c.id as string)].filter((r) => byReason.has(r));
    const pop =
      `<div class="diffstat-popover" role="tooltip">` +
      row('Shown', this.visible) +
      (hiddenIdx.length ? row('Hidden', hiddenIdx) + reasons.map((r) => row(r === 'manual' ? 'Manual' : esc(CAT_TITLE.get(r) ?? r), byReason.get(r)!, ' ds-sub')).join('') : '') +
      `<div class="ds-divider"></div>` +
      row('All files', this.files.map((_, i) => i), ' ds-total') +
      `</div>`;
    return (
      `<div class="pr-diffstat" tabindex="0"><span class="diffstat">${stat(adds, dels)}</span>${pop}</div>`
    );
  }

  /** Hand-hidden files and the Geld categories, as a checkbox menu behind the tree's eye button. */
  renderFilterMenu() {
    const counts = new Map<string, number>();
    for (const f of this.files) for (const c of f.cats) counts.set(c, (counts.get(c) ?? 0) + 1);
    counts.set('manual', this.files.filter((f) => this.manualFor(f.path) === 'hide').length);
    const rows = [{ id: 'manual', title: 'Manual', description: 'Files you hid with h or a file\'s eye button' }, ...CATEGORIES]
      .filter((c) => counts.get(c.id))
      .map(
        (c) =>
          `<label class="ActionListItem" title="${esc(c.description)}"><input type="checkbox" data-cat="${c.id}"${this.enabled.has(c.id) ? ' checked' : ''}><span class="ActionListItem-text">${esc(c.title)}</span><span class="ActionListItem-count">${fmt(counts.get(c.id)!)}</span></label>`,
      )
      .join('');
    this.paintKeepingMenus(
      this.tree.extra,
      `<details class="details-reset details-overlay select-menu" data-menu="filter"><summary class="btn btn-sm btn-icon${this.visible.length < this.files.length ? ' is-filtering' : ''}" aria-label="Hide files" title="Hide files">${icon('eye-closed')}</summary><div class="select-menu-modal flyout filter-menu"><div class="select-menu-header">Hide files</div><div class="ActionList">${rows || '<div class="menu-note">No categories match these files.</div>'}</div></div></details>`,
    );
  }

  stateBadge(): string {
    const s = this.m.meta.state;
    const name = s === 'merged' ? 'git-merge' : s === 'closed' ? 'git-pull-request-closed' : s === 'draft' ? 'git-pull-request-draft' : 'git-pull-request';
    const label = s[0]!.toUpperCase() + s.slice(1);
    return `<span class="State State--${s}" title="Status: ${label}">${icon(name)} ${label}</span>`;
  }

  onChromeClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const btn = t.closest<HTMLButtonElement>('[data-style],[data-act]');
    if (!btn) return;
    btn.closest('details')?.removeAttribute('open');
    const { style, act } = btn.dataset;
    if (style) this.setDiffStyle(style as DiffStyle);
    else if (act === 'approve') void this.approve(btn);
    else if (act === 'export') void this.exportHtml(btn);
  }

  // ----------------------------------------------------------- mount

  async mount(container: HTMLElement) {
    // Ask for the first screen's patches now, so they are here by the time
    // the shells are, and the first frame with files already shows code.
    const first: number[] = [];
    for (let i = 0; i < this.files.length && first.length < 6; i++) if (this.reasonFor(this.files[i]!) === null) first.push(i);
    const patches = this.loadPatches(first);
    this.hl = new Highlighter(await highlightWorkers(), (lang) => this.grammar(lang));
    for (const i of first) this.hl.preload(this.files[i]!.lang);
    const main = h('div', { class: 'diff-view' }, h('div', { class: 'land-mask' }), this.el.flash, this.el.list);
    this.el.sidebar.append(this.tree.el);
    this.el.layout.append(this.el.sidebar, main);
    // The toolbar shows the title only once the title block has scrolled away.
    const sentinel = h('div', { class: 'pr-header-sentinel' });
    this.el.root.append(this.el.top, sentinel, this.el.header, this.el.layout);
    new IntersectionObserver(([e]) => this.el.header.classList.toggle('is-stuck', !e!.isIntersecting)).observe(sentinel);
    this.el.root.dataset.diffStyle = this.diffStyle;
    container.replaceChildren(this.el.root);
    this.renderHeader();
    this.el.list.addEventListener('click', (e) => this.onListClick(e));
    this.el.header.addEventListener('click', (e) => this.onChromeClick(e));
    this.tree.extra.addEventListener('change', (e) => {
      const cat = (e.target as HTMLElement).dataset.cat;
      if (cat) this.toggleCategory(cat);
    });
    // Everything sticky sits under the header; its height drives the offsets.
    new ResizeObserver(() => document.documentElement.style.setProperty('--hdr-h', `${this.stickyTop()}px`)).observe(this.el.header);
    document.documentElement.style.setProperty('--hdr-h', `${this.stickyTop()}px`);
    // Close an open menu on outside click, like GitHub's details menus.
    const signal = this.ac.signal;
    document.addEventListener(
      'click',
      (e) => {
        for (const d of document.querySelectorAll('details[data-menu][open]')) if (!d.contains(e.target as Node)) d.removeAttribute('open');
      },
      { signal },
    );
    window.addEventListener('pointerdown', () => (this.pointerDown = true), { signal, capture: true });
    window.addEventListener('pointerup', () => ((this.pointerDown = false), this.flushDeferred()), { signal, capture: true });
    document.addEventListener('selectionchange', () => this.deferred.size && this.flushDeferred(), { signal });
    let raf = 0;
    window.addEventListener(
      'scroll',
      () => {
        if (!raf) raf = requestAnimationFrame(() => ((raf = 0), this.onScroll()));
      },
      { signal },
    );
    await patches;
    mark('patches');
    this.mountShells();
    this.update();
    mark('shells');
    // Paint the first screen now rather than on the observer's next tick.
    for (const i of first) this.view(i).render();
    mark('items');
    this.bindKeys();
  }

  grammar(lang: string): Grammar | null {
    if (this.src.mode === 'export') return this.src.bundle!.langs[lang] ?? null;
    return `/api/lang/${encodeURIComponent(lang)}`;
  }

  bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(TEXTAREA|SELECT)$/.test(t.tagName) || (t instanceof HTMLInputElement && t.type !== 'checkbox'))) return;
      if (e.key === 'j') this.go(1);
      else if (e.key === 'k') this.go(-1);
      else if (e.key === 'h') {
        if (this.visible.length) this.hideFile(this.files[this.visible[this.currentIndex()]!]!.path);
      } else if (e.key === 'v') {
        if (this.visible.length) {
          const i = this.visible[this.currentIndex()]!;
          this.setReviewed(i, !this.isReviewed(i));
        }
      } else return;
      e.preventDefault();
    }, { signal: this.ac.signal });
  }

  destroy() {
    this.ac.abort();
    this.io.disconnect();
  }
}

// ------------------------------------------------------------- boot

let app: App | undefined;

async function start(src: Source) {
  app?.destroy();
  app = new App(src);
  window.__prvApp = app;
  await app.mount(document.getElementById('app')!);
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  mark('firstPaint');
  const t0 = Number(new URLSearchParams(location.search).get('t0'));
  const t = {
    mode: src.mode,
    pr: `${app.m.meta.owner}/${app.m.meta.repo}#${app.m.meta.number}`,
    stale: !!src.manifest.stale,
    files: app.files.length,
    visible: app.visible.length,
    marks: { ...marks },
    server: src.manifest.timings,
    e2eFromCli: t0 ? Date.now() - t0 : undefined,
  };
  window.__prvTimings = t;
  console.info('diff timings', t);
  if (src.mode === 'live') {
    void fetch('/api/timing', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(t) }).catch(() => {});
    if (src.manifest.stale) void app.refresh();
    void app.prefetch();
  }
}

function showError(msg: string) {
  document.getElementById('app')!.replaceChildren(h('div', { class: 'flash flash-error boot-error' }, msg));
}

function renderIndex() {
  const input = h('input', { class: 'form-control', placeholder: 'https://github.com/owner/repo/pull/123 or owner/repo#123', autofocus: true }) as HTMLInputElement;
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const v = input.value.trim();
    const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(v) ?? /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(v);
    if (m) location.href = `/${m[1]}/${m[2]}/pull/${m[3]}`;
  });
  document.getElementById('app')!.replaceChildren(h('div', { class: 'index' }, h('h1', {}, 'diff'), input));
}

// Drop an exported .html onto the live page to view it.
function enableDrop() {
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files[0];
    if (!file) return;
    try {
      const b64 = extractEmbedded(await file.text(), 'prv-bundle');
      if (!b64) throw new Error(`${file.name} is not a diff export`);
      await start(sourceFromBundle(await decodeBundle(b64)));
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    }
  });
}

async function main() {
  const boot = window.__prvBoot;
  try {
    if (boot.mode === 'export') {
      const bundle = await decodeBundle(document.getElementById('prv-bundle')!.textContent!);
      mark('bundle');
      return await start(sourceFromBundle(bundle));
    }
    enableDrop();
    if (boot.mode === 'index') return renderIndex();
    const manifest = await boot.manifest;
    mark('manifest');
    await start({ mode: 'live', manifest, patches: new Map() });
  } catch (e) {
    console.error(e);
    showError(e instanceof Error ? e.message : String(e));
  }
}

void main();
