// Geld's hiding model: glob compiler (ports of Geld's `be`/`xe`/`Se`/`Ce`),
// the default catalog, and per-file classification.
import { CATALOG, SOURCE_EXTENSIONS } from './geld-catalog.ts';

export type CategoryId = (typeof CATALOG.categories)[number]['id'];
export const CATEGORIES = CATALOG.categories.map((c) => ({
  id: c.id as CategoryId,
  title: c.title,
  description: c.description,
  defaultEnabled: c.defaultEnabled,
  groups: c.groups.map((g) => ({ id: g.id, label: g.label })),
}));

// Kind-based categories: their groups are matched against change kinds, not paths.
const KIND_CATEGORIES = new Set(['trivial', 'large']);
export const LARGE_THRESHOLD = 1000;

function splitTopLevel(e: string): string[] {
  const t: string[] = [];
  let n = 0;
  let r = '';
  for (const i of e) {
    if (i === '{') n += 1;
    if (i === '}') n -= 1;
    if (i === ',' && n === 0) {
      t.push(r);
      r = '';
      continue;
    }
    r += i;
  }
  t.push(r);
  return t;
}

export function expandBraces(e: string): string[] {
  const t = e.indexOf('{');
  if (t === -1) return [e];
  let n = 0;
  let r = -1;
  for (let i = t; i < e.length; i += 1) {
    const c = e[i];
    if (c === '{') n += 1;
    if (c === '}') {
      n -= 1;
      if (n === 0) {
        r = i;
        break;
      }
    }
  }
  if (r === -1) return [e];
  const prefix = e.slice(0, t);
  const suffix = e.slice(r + 1);
  const out: string[] = [];
  for (const alt of splitTopLevel(e.slice(t + 1, r))) {
    for (const rest of expandBraces(alt + suffix)) out.push(prefix + rest);
  }
  return out;
}

const REGEX_SPECIAL = /[\\^$.+()|[\]]/g;

function segmentToRegex(e: string): string {
  let t = '';
  for (let n = 0; n < e.length; n += 1) {
    const r = e[n]!;
    if (r === '*') t += '[^/]*';
    else if (r === '?') t += '[^/]';
    else if (r === '[') {
      const close = e.indexOf(']', n + 1);
      if (close === -1) t += '\\[';
      else {
        let cls = e.slice(n + 1, close);
        if (cls.startsWith('!')) cls = `^${cls.slice(1)}`;
        t += `[${cls.replace(/\\/g, '\\\\')}]`;
        n = close;
      }
    } else t += r.replace(REGEX_SPECIAL, '\\$&');
  }
  return t;
}

// One brace-free glob → anchored regex source. No `/`, or a trailing `/`,
// means "anywhere" (`**/` prefix); a trailing `/` matches the directory and
// everything under it.
function globToRegexSource(glob: string): string {
  let t = glob.trim();
  if (t.startsWith('/')) t = t.slice(1);
  const dir = t.endsWith('/');
  if (dir) t = t.slice(0, -1);
  if ((!t.includes('/') || dir) && !t.startsWith('**/')) t = `**/${t}`;
  const parts = t.split('/');
  let re = '^';
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    const last = i === parts.length - 1;
    if (part === '**') {
      re += last ? '.*' : '(?:[^/]+/)*';
      continue;
    }
    re += segmentToRegex(part);
    if (!last) re += '/';
  }
  if (dir) re += '(?:/.*)?';
  return `${re}$`;
}

export function compileGlob(pattern: string): RegExp {
  const sources = expandBraces(pattern).map(globToRegexSource);
  const src = sources.length === 1 ? sources[0]! : `(?:${sources.join('|')})`;
  return new RegExp(src, 'i');
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.?\//, '');
}

// Geld's Docs name globs (`HISTORY*`, `CHANGES*`, `LICENSE*`, ...) match any
// case, so they also claim code like `transcript/history.py`. Here a source
// file is Docs only by directory (`docs/`), never by name.
const SOURCE = compileGlob(`*.${SOURCE_EXTENSIONS}`);

const COMPILED = CATALOG.categories.map((c) => ({
  id: c.id as CategoryId,
  kindGroups: KIND_CATEGORIES.has(c.id) ? new Set(c.groups.map((g) => g.id)) : null,
  patterns: c.groups
    .flatMap((g) => g.patterns)
    .map((p) => ({ pattern: p, re: compileGlob(p), notSource: c.id === 'docs' && !p.includes('/') })),
}));

export interface ClassifyInput {
  path: string;
  additions: number;
  deletions: number;
  kinds?: string[];
}

// Every category the file belongs to, in catalog order. The first *enabled*
// one wins, which matches Geld evaluating enabled categories in catalog order.
export function classify(file: ClassifyInput): CategoryId[] {
  const path = normalizePath(file.path);
  const kinds = new Set(file.kinds ?? []);
  if (file.additions + file.deletions >= LARGE_THRESHOLD) kinds.add('large');
  const source = SOURCE.test(path);
  const out: CategoryId[] = [];
  for (const c of COMPILED) {
    if (c.patterns.some((p) => p.re.test(path) && !(p.notSource && source))) out.push(c.id);
    else if (c.kindGroups && [...kinds].some((k) => c.kindGroups!.has(k))) out.push(c.id);
  }
  return out;
}

export function defaultEnabledCategories(): CategoryId[] {
  return CATEGORIES.filter((c) => c.defaultEnabled).map((c) => c.id);
}
