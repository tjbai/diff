import { h } from './dom.ts';
import { Highlighter } from './highlight.ts';
import type { Tok } from './diff.ts';
import { failure, ic, message, timeEl } from './repo-shared.ts';
import type { RepoBranches, RepoEntry, RepoFile, RepoPaths, RepoSnapshot, RepoTree } from '../repository-types.ts';

const boot = (window as unknown as { __repoBoot: { owner: string; repo: string; workerHash: string; snapshot?: Promise<RepoSnapshot> } }).__repoBoot;
const repo = `${boot.owner}/${boot.repo}`;
const base = `/${repo}`;
const api = `/api/repo/${repo}`;
const enc = (path: string) => path.split('/').map(encodeURIComponent).join('/');
const shortRef = (ref: string) => /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 7) : ref;
const size = (n: number) => n < 1024 ? `${n} Bytes` : n < 1048576 ? `${(n / 1024).toFixed(2)} KB` : `${(n / 1048576).toFixed(2)} MB`;
const join = (dir: string, name: string) => dir ? `${dir}/${name}` : name;
const parent = (path: string) => path.split('/').slice(0, -1).join('/');
const sorted = (entries: RepoEntry[]) => [...entries].sort((a, b) => Number(b.type === 'tree') - Number(a.type === 'tree') || a.path.localeCompare(b.path));
let snapshot: RepoSnapshot | null = null;
let epoch = 0;
let navigation = 0;
let currentPath = '';
let currentType = 'tree';
const trees = new Map<string, Promise<RepoTree>>();
const folders = new Map<string, { details: HTMLDetailsElement; load: () => Promise<void> }>();
// Directory browsing has no syntax worker or grammar requests.
let highlighter: Highlighter | undefined;
function tokenize(lang: string, docs: string[]) {
  if (lang === 'text') return Promise.resolve(null);
  highlighter ??= new Highlighter([new Worker(`/hl-worker.js?v=${boot.workerHash}`)], (lang) => `/api/lang/${encodeURIComponent(lang)}`);
  return highlighter.tokenize(lang, docs);
}
const requests = new Map<string, { expires: number; promise: Promise<unknown> }>();

function get<T>(endpoint: string, params: Record<string, string> = {}, ttl = 0, signal?: AbortSignal): Promise<T> {
  const url = `${api}/${endpoint}?${new URLSearchParams(params)}`;
  const existing = requests.get(url);
  if (existing && existing.expires > Date.now()) return existing.promise as Promise<T>;
  const promise = (async () => {
    const response = await fetch(url, { signal });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
    return body as T;
  })();
  if (ttl) {
    requests.delete(url);
    requests.set(url, { expires: Date.now() + ttl, promise });
    promise.catch(() => { if (requests.get(url)?.promise === promise) requests.delete(url); });
    while (requests.size > 32) requests.delete(requests.keys().next().value!);
  }
  return promise;
}

function tree(sha: string) {
  let p = trees.get(sha);
  if (!p) {
    p = get<RepoTree>('tree', { sha });
    trees.set(sha, p);
    p.catch(() => trees.delete(sha));
    while (trees.size > 128) trees.delete(trees.keys().next().value!);
  }
  return p;
}

/** GitHub's URL shape: /owner/repo, /owner/repo/tree/<ref>/<dir>, /owner/repo/blob/<ref>/<file>. */
function href(path = '', type = 'tree', snap = snapshot) {
  if (!snap || (!path && snap.branch === snap.defaultBranch)) return base;
  return `${base}/${type === 'blob' ? 'blob' : 'tree'}/${enc(snap.branch)}${path ? `/${enc(path)}` : ''}`;
}

function link(path: string, name: string, type = 'tree', className = '') {
  const a = h('a', { href: href(path, type), class: className, 'data-path': path }, name);
  a.addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    void navigate(path);
  });
  return a;
}

const branchButton = h('button', { class: 'btn repo-branch-button', type: 'button', 'aria-haspopup': 'dialog', 'aria-label': 'Switch branches or tags' }, ic('git-branch'), h('span', {}, '…'), h('span', { class: 'dropdown-caret' }));
const findButton = h('button', { class: 'repo-goto', type: 'button' }, ic('search'), h('span', {}, 'Go to file'), h('kbd', {}, 't'));
const grepButton = h('button', { class: 'btn btn-icon', type: 'button', title: 'Search code (⌘⇧K)', 'aria-label': 'Search code' }, ic('search'));
const sidebarList = h('nav', { class: 'repo-tree', 'aria-label': 'Repository files' });
const breadcrumbs = h('nav', { class: 'repo-breadcrumbs', 'aria-label': 'Breadcrumbs' });
const main = h('main', { class: 'repo-content', id: 'repo-content', 'aria-live': 'polite' });
const commitBar = h('div', { class: 'repo-commit' });
const sidebar = h('aside', { class: 'repo-sidebar' },
  h('div', { class: 'repo-sidebar-head' }, h('h2', {}, 'Files'), h('div', { class: 'repo-sidebar-tools' }, branchButton, grepButton), findButton), sidebarList);
document.getElementById('app')!.append(h('div', { class: 'repo-layout' }, sidebar, h('div', { class: 'repo-main' }, breadcrumbs, commitBar, main)));

function paintBreadcrumbs(path: string) {
  const parts = path ? path.split('/') : [];
  breadcrumbs.replaceChildren(parts.length ? link('', boot.repo) : h('strong', {}, boot.repo));
  parts.forEach((name, i) => {
    breadcrumbs.append(h('span', { class: 'muted' }, '/'), i === parts.length - 1 ? h('strong', {}, name) : link(parts.slice(0, i + 1).join('/'), name));
  });
}

function paintTree(container: HTMLElement, entries: RepoEntry[], directory: string, generation: number) {
  container.replaceChildren();
  for (const entry of sorted(entries)) {
    const path = join(directory, entry.path);
    if (entry.type !== 'tree') {
      const a = link(path, entry.path, 'blob', 'repo-tree-file');
      a.prepend(ic(entry.type === 'commit' ? 'file-moved' : 'file'));
      a.title = path;
      container.append(a);
      continue;
    }
    const children = h('div', { class: 'repo-tree-children' });
    const a = link(path, entry.path, 'tree');
    a.prepend(ic('file-directory-fill'));
    const summary = h('summary', {}, ic('chevron-right'), a);
    const details = h('details', { class: 'repo-tree-folder' }, summary, children);
    let loading: Promise<void> | undefined;
    const load = () => loading ??= (async () => {
      children.replaceChildren(message('Loading…'));
      try {
        const result = await tree(entry.sha);
        if (generation !== epoch) return;
        paintTree(children, result.entries, path, generation);
        if (result.truncated) children.append(message('Some entries were omitted by GitHub.'));
      } catch (e) { failure(children, e); loading = undefined; }
    })();
    details.addEventListener('toggle', () => { if (details.open) void load(); });
    folders.set(path, { details, load });
    container.append(details);
  }
}

async function selectTree(path: string, generation: number, id: number) {
  const parts = path ? path.split('/') : [];
  const end = parts.length - (currentType === 'tree' ? 0 : 1);
  for (let i = 1; i <= end; i++) {
    const folder = folders.get(parts.slice(0, i).join('/'));
    if (folder) { folder.details.open = true; await folder.load(); }
    if (generation !== epoch || id !== navigation) return;
  }
  sidebarList.querySelectorAll('[aria-current]').forEach((e) => e.removeAttribute('aria-current'));
  sidebarList.querySelectorAll<HTMLAnchorElement>('a[data-path]').forEach((a) => {
    if (a.dataset.path === path) {
      a.setAttribute('aria-current', 'page');
      const row = a.getBoundingClientRect(), box = sidebarList.getBoundingClientRect();
      if (row.top < box.top || row.bottom > box.bottom) sidebarList.scrollTop += row.top - box.top - box.height / 2;
    }
  });
}

function directoryView(entries: RepoEntry[], path: string, truncated: boolean) {
  const body = h('tbody');
  if (path) body.append(h('tr', { class: 'repo-directory-parent' }, h('td', {}, link(parent(path), '..'))));
  for (const entry of sorted(entries)) {
    const folder = entry.type === 'tree';
    const a = link(join(path, entry.path), entry.path, folder ? 'tree' : 'blob');
    body.append(h('tr', {}, h('td', {}, ic(folder ? 'file-directory-fill' : entry.type === 'commit' ? 'file-moved' : 'file'), a)));
  }
  main.replaceChildren(h('div', { class: 'repo-box' },
    h('table', { class: 'repo-directory', 'aria-label': 'Directory contents' }, h('thead', {}, h('tr', {}, h('th', {}, 'Name'))), body)));
  if (truncated) main.append(message('GitHub returned a partial listing for this directory.'));
  if (!entries.length) main.append(message('This directory is empty.'));
}

function rawURL(path: string, extra: Record<string, string> = {}) {
  return `${api}/raw?${new URLSearchParams({ tree: snapshot!.tree, path, ...extra })}`;
}

let markdown: Promise<typeof import('./markdown.ts')> | undefined;
function markdownRenderer() {
  if (!markdown) {
    let styles: HTMLElement | undefined;
    markdown = (async () => {
      const response = await fetch('/api/markdown-assets');
      if (!response.ok) throw new Error('Could not load Markdown preview');
      const { hash } = await response.json() as { hash: string };
      styles = h('link', { rel: 'stylesheet', href: `/markdown.css?v=${hash}` });
      document.head.append(styles);
      return import(`/markdown.js?v=${hash}`) as Promise<typeof import('./markdown.ts')>;
    })().catch((e) => { markdown = undefined; styles?.remove(); throw e; });
  }
  return markdown;
}

async function fileView(entry: RepoEntry, file: RepoFile, path: string, id: number) {
  const snap = snapshot!;
  const summary = h('div', { class: 'repo-file-summary' });
  const actions = h('div', { class: 'repo-file-actions BtnGroup' });
  const heading = h('div', { class: 'repo-box-heading' }, summary, actions);
  const content = h('div', { class: 'repo-file-body' });
  main.replaceChildren(h('section', { class: 'repo-box' }, heading, content));
  const info = h('span', { class: 'repo-file-info' }, entry.mode === '120000' ? 'Symbolic link · ' : '', size(file.size));
  summary.append(info);
  if (file.tooLarge) { content.append(message('This file is larger than 2 MB. Download it to view its contents.')); }
  actions.append(h('a', { class: 'btn btn-sm', href: rawURL(path), target: '_blank', rel: 'noreferrer' }, 'Raw'));
  const download = h('a', { class: 'btn btn-sm btn-icon', href: rawURL(path, { download: '1' }), 'aria-label': 'Download raw file', title: 'Download raw file' }, ic('download'));
  if (file.tooLarge) { actions.append(download); return; }
  if (file.binary) {
    actions.append(download);
    if (/\.(png|jpe?g|gif|webp|ico)$/i.test(path)) content.append(h('div', { class: 'repo-image' }, h('img', { src: rawURL(path, { image: '1' }), alt: path })));
    else content.append(message('Binary file. Download it to view its contents.'));
    return;
  }
  const text = file.text ?? '';
  const lines = text ? text.replace(/\n$/, '').split('\n') : [];
  const loc = lines.filter((l) => l.trim()).length;
  info.prepend(`${lines.length.toLocaleString()} lines (${loc.toLocaleString()} loc) · `);
  const copy = h('button', { class: 'btn btn-sm btn-icon', type: 'button', 'aria-label': 'Copy raw content', title: 'Copy raw content' }, ic('copy'));
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(text); copy.replaceChildren(ic('check')); copy.classList.add('is-copied'); }
    catch { copy.title = 'Copy unavailable'; }
    setTimeout(() => { copy.replaceChildren(ic('copy')); copy.classList.remove('is-copied'); }, 2000);
  };
  actions.append(copy, download);
  if (!lines.length) { content.append(message('This file is empty.')); return; }
  const tbody = h('tbody');
  const code = h('table', { class: 'repo-code', 'aria-label': path }, tbody);
  const more = h('button', { class: 'repo-load-more btn', type: 'button' }, 'Load more lines');
  const source = h('div', { class: 'repo-source' }, code);
  content.append(source);
  let rendered = 0;
  let tokens: Tok[][] | undefined;
  function paintLine(cell: HTMLElement, i: number) {
    if (!tokens?.[i]) { cell.textContent = lines[i] || ' '; return; }
    cell.replaceChildren(...tokens[i]!.map(([value, light, dark, italic]) => {
      const span = h('span', {}, value);
      span.style.setProperty('--shiki-light', light);
      span.style.setProperty('--shiki-dark', dark);
      if (italic) span.style.fontStyle = 'italic';
      return span;
    }));
  }
  function appendLines(until = rendered + 1000) {
    more.remove();
    const fragment = document.createDocumentFragment();
    for (; rendered < Math.min(lines.length, until); rendered++) {
      const n = rendered + 1;
      const cell = h('td', { class: 'repo-line-code' });
      paintLine(cell, rendered);
      fragment.append(h('tr', { id: `L${n}`, class: n === lineTarget ? 'repo-line-selected' : undefined }, h('td', { class: 'repo-line-number' }, h('a', { href: `#L${n}`, 'aria-label': `Line ${n}` }, n)), cell));
    }
    tbody.append(fragment);
    if (rendered < lines.length) { more.textContent = `Load more lines (${rendered.toLocaleString()} of ${lines.length.toLocaleString()})`; source.append(more); }
  }
  more.onclick = () => appendLines();
  const lineTarget = Math.min(lines.length, Number(/^#L(\d+)$/.exec(location.hash)?.[1] ?? 0));
  async function renderCode() {
    if (rendered) return;
    appendLines(Math.max(1000, lineTarget));
    if (lineTarget) document.getElementById(`L${lineTarget}`)?.scrollIntoView({ block: 'center' });
    if (text.length <= 300_000) {
      const result = await tokenize(file.lang, [text]);
      if (id !== navigation) return;
      tokens = result?.[0];
      tbody.querySelectorAll<HTMLElement>('.repo-line-code').forEach((cell, i) => paintLine(cell, i));
    }
  }
  const codeButton = h('button', { type: 'button', role: 'tab', 'aria-selected': 'true' }, ic('code'), 'Code');
  const tabs = h('span', { class: 'repo-file-tabs', role: 'tablist', 'aria-label': 'File view' }, codeButton);
  summary.prepend(tabs);
  if (!/\.(md|markdown|mdown|mkd)$/i.test(path) || entry.mode === '120000') { void renderCode(); return; }
  const preview = h('article', { class: 'markdown-body repo-markdown', role: 'tabpanel', 'aria-label': 'Markdown preview' });
  source.setAttribute('role', 'tabpanel'); source.setAttribute('aria-label', 'Markdown source');
  content.prepend(preview);
  const previewButton = h('button', { type: 'button', role: 'tab' }, ic('eye'), 'Preview');
  tabs.prepend(previewButton);
  let ready: Promise<void> | undefined;
  function showPreview(show: boolean) {
    preview.hidden = !show; source.hidden = show;
    previewButton.setAttribute('aria-selected', String(show)); codeButton.setAttribute('aria-selected', String(!show));
    if (!show) { void renderCode(); return; }
    if (!ready) {
      preview.replaceChildren(message('Rendering Markdown…'));
      ready = markdownRenderer().then(({ renderMarkdown }) => {
        if (id !== navigation) return;
        renderMarkdown(preview, text, {
          path,
          href: (path, hash) => href(path, 'blob', snap) + hash,
          raw: (path) => `${api}/raw?${new URLSearchParams({ tree: snap.tree, path, image: '1' })}`,
          navigate: (path, hash) => void navigate(path, true, 0, hash),
          tokenize,
        });
      }).catch((e) => { failure(preview, e); ready = undefined; });
    }
  }
  previewButton.onclick = () => showPreview(true);
  codeButton.onclick = () => showPreview(false);
  tabs.onkeydown = (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); const button = e.key === 'ArrowLeft' ? previewButton : codeButton; button.click(); button.focus(); }
  };
  showPreview(!lineTarget);
}

async function navigate(path: string, push = true, line = 0, hash = '') {
  if (!snapshot) return;
  const id = ++navigation;
  const generation = epoch;
  const snap = snapshot;
  currentPath = path;
  paintBreadcrumbs(path);
  main.replaceChildren(message('Loading files…'));
  try {
    // The root is already loaded for the sidebar. Other entries are immutable
    // at this tree ID, so revisiting a file needs no request or JSON parsing.
    const result: { entry: RepoEntry; entries?: RepoEntry[]; truncated?: boolean; file?: RepoFile } = path
      ? await get('entry', { tree: snap.tree, path }, Infinity)
      : { entry: { path: '', type: 'tree', mode: '040000', sha: snap.tree }, ...await tree(snap.tree) };
    if (id !== navigation || generation !== epoch) return;
    currentType = result.entry.type === 'tree' ? 'tree' : 'blob';
    const url = href(path, currentType, snap) + (line ? `#L${line}` : hash || (push ? '' : location.hash));
    if (push) history.pushState(null, '', url); else history.replaceState(null, '', url);
    if (push || !location.hash) window.scrollTo({ top: 0 });
    document.title = `${path ? `${boot.repo}/${path}` : repo} at ${shortRef(snap.branch)} · ${repo}`;
    if (result.entries) directoryView(result.entries, path, !!result.truncated);
    else if (result.file) void fileView(result.entry, result.file, path, id);
    else main.replaceChildren(message(`Git submodule at commit ${result.entry.sha}. Browse the submodule repository to view its files.`));
    void selectTree(path, generation, id);
  } catch (e) {
    if (id !== navigation || generation !== epoch) return;
    failure(main, e);
    const back = h('button', { class: 'btn', type: 'button' }, 'Go to repository root');
    back.onclick = () => void navigate('');
    main.append(back);
  }
}

/** Loads the snapshot for a `<ref>/<path>` spec (the default branch when empty). */
async function loadBranch(spec: string, prefetched?: Promise<RepoSnapshot>) {
  const generation = ++epoch;
  ++navigation;
  snapshot = null;
  folders.clear();
  branchButton.disabled = true;
  commitBar.replaceChildren(message('Loading repository…'));
  sidebarList.replaceChildren(message('Loading files…'));
  main.replaceChildren(message('Loading files…'));
  try {
    const snap = await (prefetched ?? get<RepoSnapshot>('snapshot', { spec }));
    if (generation !== epoch) return;
    snapshot = snap;
    branchButton.replaceChildren(ic('git-branch'), h('span', {}, shortRef(snap.branch)), h('span', { class: 'dropdown-caret' }));
    branchButton.title = snap.branch;
    commitBar.replaceChildren(h('img', { class: 'repo-avatar', src: snap.authorAvatar, width: 20, height: 20, alt: '', decoding: 'async' }),
      h('strong', {}, snap.author), h('span', { class: 'repo-commit-message', title: snap.message }, snap.message),
      h('span', { class: 'repo-commit-meta' },
        h('a', { class: 'repo-sha', href: `https://github.com/${repo}/commit/${snap.sha}`, title: snap.sha, target: '_blank', rel: 'noreferrer' }, snap.sha.slice(0, 7)),
        ' · ', timeEl(snap.date)));
    const root = snap.root;
    trees.set(snap.tree, Promise.resolve(root));
    while (trees.size > 128) trees.delete(trees.keys().next().value!);
    paintTree(sidebarList, root.entries, '', generation);
    if (root.truncated) sidebarList.append(message('Some entries were omitted by GitHub.'));
    // replaceState rewrites legacy ?ref= URLs and trailing slashes into the canonical shape.
    await navigate(snap.path, false);
  } catch (e) { if (generation === epoch) { failure(main, e); sidebarList.replaceChildren(); commitBar.replaceChildren(); } }
  finally { if (generation === epoch) branchButton.disabled = false; }
}

let choiceID = 0;
function dialog(title: string, placeholder: string) {
  const input = h('input', { class: 'form-control', placeholder, 'aria-label': placeholder, autocomplete: 'off' });
  const close = h('button', { class: 'repo-dialog-close', 'aria-label': 'Close', type: 'button' }, ic('x'));
  const list = h('div', { class: 'repo-dialog-list', id: `repo-choices-${++choiceID}`, role: 'listbox', 'aria-label': title });
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-controls', list.id);
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'true');
  const options = h('div', { class: 'repo-dialog-options' }, close);
  const modal = h('dialog', { class: 'repo-dialog', 'aria-label': title }, h('div', { class: 'repo-box-heading' }, h('strong', {}, title), options), h('div', { class: 'repo-dialog-search' }, input), list);
  document.body.append(modal);
  close.onclick = () => modal.close();
  modal.onclick = (e) => { if (e.target === modal) { const r = modal.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) modal.close(); } };
  let active: HTMLButtonElement | undefined;
  const choices = () => [...list.querySelectorAll<HTMLButtonElement>('.repo-choice:not(:disabled)')];
  const observer = new MutationObserver(() => {
    if (active && !list.contains(active)) { active = undefined; input.removeAttribute('aria-activedescendant'); }
    for (const choice of choices()) {
      choice.id ||= `repo-choice-${++choiceID}`;
      choice.setAttribute('role', 'option');
      choice.setAttribute('aria-selected', String(choice === active));
      choice.tabIndex = -1;
    }
  });
  observer.observe(list, { childList: true, subtree: true });
  modal.addEventListener('close', () => { observer.disconnect(); modal.remove(); });
  modal.addEventListener('keydown', (e) => {
    if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Enter' && e.target === input) {
      e.preventDefault();
      (active && list.contains(active) ? active : choices()[0])?.click();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = choices();
    if (!rows.length || (e.target !== input && !rows.includes(e.target as HTMLButtonElement))) return;
    e.preventDefault();
    const current = active ? rows.indexOf(active) : -1;
    const next = e.key === 'ArrowDown' ? Math.min(current + 1, rows.length - 1) : current < 0 ? rows.length - 1 : Math.max(0, current - 1);
    active?.setAttribute('aria-selected', 'false');
    active = rows[next]!;
    active.id ||= `repo-choice-${++choiceID}`;
    active.setAttribute('aria-selected', 'true');
    input.setAttribute('aria-activedescendant', active.id);
    input.focus({ preventScroll: true });
    active.scrollIntoView({ block: 'nearest' });
  });
  modal.showModal(); input.focus();
  return { modal, input, list, options };
}

branchButton.onclick = () => {
  const { modal, input, list } = dialog('Switch branches', 'Find a branch…');
  let seq = 0;
  let timer: ReturnType<typeof setTimeout>;
  async function search(cursor?: string) {
    const id = ++seq;
    if (!cursor) list.replaceChildren(message('Loading branches…'));
    try {
      const data = await get<RepoBranches>('branches', { q: input.value, ...(cursor ? { cursor } : {}) }, 30_000);
      if (id !== seq || !modal.open) return;
      if (!cursor) list.replaceChildren();
      list.querySelector('.repo-more')?.remove();
      const names = !input.value && !cursor && snapshot ? [...new Set([snapshot.branch, snapshot.defaultBranch, ...data.names])] : data.names;
      for (const name of names) {
        const button = h('button', { class: 'repo-choice', type: 'button' }, h('span', { class: 'repo-choice-label' }, name), name === snapshot?.defaultBranch ? h('span', { class: 'Label' }, 'default') : null, name === snapshot?.branch ? ic('check') : null);
        button.onclick = () => {
          modal.close();
          const spec = join(name, currentPath);
          history.pushState(null, '', `${base}/${currentType}/${enc(spec)}`);
          void loadBranch(spec);
        };
        list.append(button);
      }
      if (!names.length) list.append(message('No matching branches.'));
      if (data.more && data.cursor) {
        const more = h('button', { class: 'repo-choice repo-more', type: 'button' }, 'Load more branches');
        more.onclick = () => { more.disabled = true; void search(data.cursor!); };
        list.append(more);
      }
    } catch (e) { if (id === seq && modal.open) failure(list, e); }
  }
  input.oninput = () => { ++seq; list.replaceChildren(message('Searching branches…')); clearTimeout(timer); timer = setTimeout(() => void search(), 200); };
  modal.addEventListener('close', () => { ++seq; clearTimeout(timer); });
  void search();
};

findButton.onclick = async () => {
  if (!snapshot) return;
  const snap = snapshot;
  const { modal, input, list } = dialog('Go to file', 'Search file paths…');
  list.replaceChildren(message('Loading file paths…'));
  try {
    const data = await get<RepoPaths>('paths', { sha: snap.tree }, Infinity);
    if (!modal.open) return;
    const files = data.paths.map((path) => ({ path, lower: path.toLowerCase() }));
    function render() {
      const q = input.value.trim().toLowerCase();
      const matches = files.filter((e) => e.lower.includes(q));
      list.replaceChildren();
      for (const entry of matches.slice(0, 100)) {
        const button = h('button', { class: 'repo-choice', type: 'button', title: entry.path }, ic('file'), h('span', { class: 'repo-choice-label' }, entry.path));
        button.onclick = () => { modal.close(); void navigate(entry.path); };
        list.append(button);
      }
      if (!matches.length) list.append(message('No matching files.'));
      if (matches.length > 100) list.append(message(`Showing 100 of ${matches.length.toLocaleString()} matches. Keep typing to narrow the search.`));
      if (data.truncated) list.append(message('GitHub returned a partial file index. Browse folders to find files outside these results.'));
    }
    input.oninput = render;
    render();
  } catch (e) { if (modal.open) failure(list, e); }
};

grepButton.onclick = () => {
  if (!snapshot) return;
  const snap = snapshot;
  const { modal, input, list, options } = dialog(`Search code · ${shortRef(snap.branch)}`, 'Search file contents…');
  const regex = h('input', { type: 'checkbox', 'aria-label': 'Use regular expression' });
  options.prepend(h('label', { class: 'repo-regex' }, regex, 'Regex'));
  list.replaceChildren(message('Search every tracked text file at this commit.'));
  let sequence = 0;
  let timer: ReturnType<typeof setTimeout>;
  let pending: AbortController | undefined;
  async function search(id: number) {
    if (!modal.open || id !== sequence) return;
    const query = input.value.trim();
    if (!query) { list.replaceChildren(message('Search every tracked text file at this commit.')); return; }
    const controller = new AbortController();
    pending = controller;
    try {
      const result = await get<{ indexing?: boolean; matches: { path: string; line: number; text: string }[]; truncated: boolean }>('grep', { commit: snap.sha, q: query, regex: regex.checked ? '1' : '0' }, 0, controller.signal);
      if (!modal.open || id !== sequence) return;
      if (result.indexing) {
        list.replaceChildren(message('Preparing this commit for local search. The first search downloads a snapshot; later searches reuse it.'));
        timer = setTimeout(() => void search(id), 750);
        return;
      }
      list.replaceChildren();
      for (const match of result.matches) {
        const button = h('button', { class: 'repo-choice repo-code-match', type: 'button', title: `${match.path}:${match.line}` },
          h('span', { class: 'repo-match-path' }, ic('file'), `${match.path}:${match.line}`), h('code', {}, match.text));
        button.onclick = () => { modal.close(); void navigate(match.path, true, match.line); };
        list.append(button);
      }
      list.append(message(result.truncated ? 'Showing the first 200 matches. Narrow your search for more specific results.' : `${result.matches.length} matching lines.`));
    } catch (e) { if (!controller.signal.aborted && modal.open && id === sequence) failure(list, e); }
    finally { if (pending === controller) pending = undefined; }
  }
  function schedule() {
    const id = ++sequence;
    clearTimeout(timer);
    pending?.abort();
    list.replaceChildren(message(input.value.trim() ? 'Searching…' : 'Search every tracked text file at this commit.'));
    timer = setTimeout(() => void search(id), 200);
  }
  input.oninput = schedule;
  regex.onchange = schedule;
  modal.addEventListener('close', () => { ++sequence; clearTimeout(timer); pending?.abort(); });
};

/** The `<ref>/<path>` spec in the address bar; legacy `?ref=&commit=&path=` URLs map onto it. */
function urlSpec() {
  const segs = location.pathname.split('/').slice(4);
  if (segs.length) return segs.map(decodeURIComponent).join('/').replace(/\/+$/, '');
  const q = new URLSearchParams(location.search);
  return join(q.get('commit') || q.get('ref') || '', q.get('path') || '');
}

async function fromURL(initial = false) {
  const spec = urlSpec();
  if (snapshot) {
    const b = snapshot.branch;
    if (spec === b || spec.startsWith(`${b}/`)) return navigate(spec.slice(b.length + 1), false);
    if (!spec && b === snapshot.defaultBranch) return navigate('', false);
  }
  await loadBranch(spec, initial ? boot.snapshot : undefined);
}
window.addEventListener('popstate', () => void fromURL());
window.addEventListener('hashchange', () => main.querySelector('.repo-line-selected')?.classList.remove('repo-line-selected'));
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    document.querySelector<HTMLDialogElement>('dialog[open]')?.close();
    (e.shiftKey ? grepButton : findButton).click();
    return;
  }
  if ((e.target as HTMLElement)?.matches('input,textarea') || document.querySelector('dialog[open]')) return;
  if (e.key === 't' && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); findButton.click(); }
});
void fromURL(true);
