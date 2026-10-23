// Patch model and GitHub-style diff table rendering (classic `.diff-table`
// markup: blob-num / blob-code cells, `@@` hunk rows with gutter expanders).
import type { IconName } from './icons.ts';

export type Kind = ' ' | '+' | '-';
export interface Line {
  k: Kind;
  t: string;
  /** Old/new line numbers; 0 when the side does not have the line. */
  o: number;
  n: number;
  /** Changed character ranges (word highlight). */
  x?: [number, number][];
}
export interface Hunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: Line[];
}
export interface Parsed {
  hunks: Hunk[];
  binary: boolean;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** `words: false` skips the word highlights, for when only the layout matters. */
export function parsePatch(text: string, words = true): Parsed {
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  let o = 0;
  let n = 0;
  let binary = false;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (const raw of lines) {
    if (raw.startsWith('@@')) {
      const m = HUNK_RE.exec(raw);
      if (!m) continue;
      cur = {
        header: raw,
        oldStart: +m[1]!,
        oldLines: m[2] === undefined ? 1 : +m[2],
        newStart: +m[3]!,
        newLines: m[4] === undefined ? 1 : +m[4],
        lines: [],
      };
      hunks.push(cur);
      o = cur.oldStart;
      n = cur.newStart;
      continue;
    }
    if (!cur) {
      if (raw.startsWith('Binary files ') || raw === 'GIT binary patch') binary = true;
      continue;
    }
    const c = raw[0];
    const t = raw.endsWith('\r') ? raw.slice(1, -1) : raw.slice(1);
    if (c === '+') cur.lines.push({ k: '+', t, o: 0, n: n++ });
    else if (c === '-') cur.lines.push({ k: '-', t, o: o++, n: 0 });
    else if (c === ' ') cur.lines.push({ k: ' ', t, o: o++, n: n++ });
  }
  if (words) for (const h of hunks) markWordDiffs(h.lines);
  return { hunks, binary };
}

// ------------------------------------------------------------ word diff

const WORD_MAX = 1000;

function markWordDiffs(lines: Line[]) {
  for (let i = 0; i < lines.length; ) {
    if (lines[i]!.k !== '-') {
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && lines[j]!.k === '-') j++;
    let k = j;
    while (k < lines.length && lines[k]!.k === '+') k++;
    const dels = lines.slice(i, j);
    const adds = lines.slice(j, k);
    for (let p = 0; p < Math.min(dels.length, adds.length); p++) {
      const r = wordDiff(dels[p]!.t, adds[p]!.t);
      if (r) {
        if (r[0].length) dels[p]!.x = r[0];
        if (r[1].length) adds[p]!.x = r[1];
      }
    }
    i = k;
  }
}

const TOKEN_RE = /\w+|\s+|[^\w\s]/g;

/** Changed ranges in a and b, or null when the lines are too different to pair. */
export function wordDiff(a: string, b: string): [[number, number][], [number, number][]] | null {
  if (a === b || a.length > WORD_MAX || b.length > WORD_MAX) return null;
  const ta = a.match(TOKEN_RE) ?? [];
  const tb = b.match(TOKEN_RE) ?? [];
  const keepA = new Uint8Array(ta.length);
  const keepB = new Uint8Array(tb.length);
  // Trim the common prefix and suffix, then LCS over what is left.
  let s = 0;
  while (s < ta.length && s < tb.length && ta[s] === tb[s]) keepA[s] = keepB[s++] = 1;
  let ea = ta.length;
  let eb = tb.length;
  while (ea > s && eb > s && ta[ea - 1] === tb[eb - 1]) keepA[--ea] = keepB[--eb] = 1;
  const n = ea - s;
  const m = eb - s;
  if (n && m && n * m <= 160_000) {
    const dp = new Uint16Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i * (m + 1) + j] = ta[s + i] === tb[s + j] ? dp[(i + 1) * (m + 1) + j + 1]! + 1 : Math.max(dp[(i + 1) * (m + 1) + j]!, dp[i * (m + 1) + j + 1]!);
    for (let i = 0, j = 0; i < n && j < m; ) {
      if (ta[s + i] === tb[s + j]) {
        keepA[s + i++] = 1;
        keepB[s + j++] = 1;
      } else if (dp[(i + 1) * (m + 1) + j]! >= dp[i * (m + 1) + j + 1]!) i++;
      else j++;
    }
  }
  const ranges = (toks: string[], keep: Uint8Array) => {
    const out: [number, number][] = [];
    let pos = 0;
    let same = 0;
    toks.forEach((t, i) => {
      if (keep[i]) same += t.length;
      else if (out.length && out[out.length - 1]![1] === pos) out[out.length - 1]![1] = pos + t.length;
      else out.push([pos, pos + t.length]);
      pos += t.length;
    });
    return { out, same };
  };
  const ra = ranges(ta, keepA);
  const rb = ranges(tb, keepB);
  // Like GitHub, skip highlighting when the pair shares little text.
  if (ra.same + rb.same < 0.5 * (a.length + b.length) * 0.8) return null;
  return [ra.out, rb.out];
}

// ------------------------------------------------------------ display model

/** Unshown lines between hunks: old lines [oldFrom, oldTo]; the new side starts at newFrom. */
export interface Gap {
  oldFrom: number;
  oldTo: number;
  newFrom: number;
}
export type Row =
  | { type: 'hunk'; header: string; gap: Gap | null; first: boolean }
  | { type: 'tail'; gap: Gap }
  | { type: 'line'; line: Line };

const firstLine = (s: number, c: number) => (c ? s : s + 1);
const lastLine = (s: number, c: number) => (c ? s + c - 1 : s);

export function buildRows(p: Parsed, expandable: boolean, hasTail: boolean): Row[] {
  const rows: Row[] = [];
  let prevOld = 0;
  let prevNew = 0;
  p.hunks.forEach((h, i) => {
    const from = prevOld + 1;
    const to = firstLine(h.oldStart, h.oldLines) - 1;
    const gap = expandable && to >= from ? { oldFrom: from, oldTo: to, newFrom: prevNew + 1 } : null;
    rows.push({ type: 'hunk', header: h.header, gap, first: i === 0 });
    for (const l of h.lines) rows.push({ type: 'line', line: l });
    prevOld = lastLine(h.oldStart, h.oldLines);
    prevNew = lastLine(h.newStart, h.newLines);
  });
  if (expandable && hasTail && p.hunks.length) rows.push({ type: 'tail', gap: { oldFrom: prevOld + 1, oldTo: Infinity, newFrom: prevNew + 1 } });
  return rows;
}

export const EXPAND_STEP = 20;

/** Reveal lines of the gap held by rows[i]. `newLines` is the full new file. */
export function expand(rows: Row[], i: number, dir: 'up' | 'down' | 'all', newLines: string[]): void {
  const row = rows[i]!;
  if (row.type === 'line' || !row.gap) return;
  const g = row.gap;
  const delta = g.newFrom - g.oldFrom;
  if (row.type === 'tail') g.oldTo = Math.min(g.oldTo, newLines.length - delta);
  const count = g.oldTo - g.oldFrom + 1;
  const ctx = (o: number): Row => ({ type: 'line', line: { k: ' ', t: newLines[o + delta - 1] ?? '', o, n: o + delta } });
  const take = dir === 'all' ? count : Math.min(EXPAND_STEP, count);
  const up = dir === 'up' || (dir === 'all' && row.type === 'hunk');
  if (up) {
    const add: Row[] = [];
    for (let o = g.oldTo - take + 1; o <= g.oldTo; o++) add.push(ctx(o));
    g.oldTo -= take;
    rows.splice(i + 1, 0, ...add);
  } else {
    const add: Row[] = [];
    for (let o = g.oldFrom; o < g.oldFrom + take; o++) add.push(ctx(o));
    g.oldFrom += take;
    g.newFrom += take;
    rows.splice(i, 0, ...add);
    i += add.length;
  }
  // Like GitHub, a fully expanded gap takes its hunk row with it.
  if (g.oldTo < g.oldFrom) rows.splice(i, 1);
}

// ------------------------------------------------------------ rendering

/** Syntax tokens for one line: [text, lightColor, darkColor, italic]. */
export type Tok = [string, string, string, number];
export interface Tokens {
  old: Tok[][];
  new: Tok[][];
  /** Line index into old/new: by line number when the docs are full files, else by position. */
  oldIdx: (l: Line) => number;
  newIdx: (l: Line) => number;
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ESC[c]!);

/** An octicon: one empty element, drawn by a CSS mask (see build.ts), so a
 *  page of a thousand file headers is not a thousand inline SVGs. */
export function icon(name: IconName, cls = ''): string {
  return `<i class="octicon octicon-${name}${cls ? ` ${cls}` : ''}" aria-hidden="true"></i>`;
}

/** Syntax colors as classes, one per (light, dark, italic), each rule added
 *  to the page on first use. A class lets the browser share one computed
 *  style across every token of that color; an inline style on each of a
 *  big diff's ten thousand spans cannot. */
const tokClasses = new Map<string, string>();
let tokSheet: CSSStyleSheet | undefined;
function tokClass(t: Tok): string {
  const key = `${t[1]} ${t[2]} ${t[3]}`;
  let c = tokClasses.get(key);
  if (c) return c;
  c = `tk${tokClasses.size}`;
  tokClasses.set(key, c);
  if (!tokSheet) {
    const el = document.createElement('style');
    document.head.append(el);
    tokSheet = el.sheet!;
  }
  tokSheet.insertRule(`.${c}{color:${t[1]}${t[3] ? ';font-style:italic' : ''}}`, tokSheet.cssRules.length);
  tokSheet.insertRule(`@media (prefers-color-scheme: dark){.${c}{color:${t[2]}}}`, tokSheet.cssRules.length);
  return c;
}

function lineHtml(text: string, toks: Tok[] | undefined, x: [number, number][] | undefined): string {
  if (!toks || toks.reduce((a, t) => a + t[0].length, 0) !== text.length) toks = [[text, '', '', 0]];
  if (!x?.length) return toks.map((t) => (t[1] ? `<span class="${tokClass(t)}">${esc(t[0])}</span>` : esc(t[0]))).join('');
  let out = '';
  let pos = 0;
  let ri = 0;
  for (const t of toks) {
    let s = 0;
    while (s < t[0].length) {
      const abs = pos + s;
      while (ri < x.length && x[ri]![1] <= abs) ri++;
      const r = x[ri];
      const inR = r !== undefined && r[0] <= abs;
      const end = Math.min(t[0].length, (inR ? r![1] : r ? r[0] : Infinity) - pos);
      const piece = t[0].slice(s, end);
      const cls = [inR ? `x${abs === r![0] ? ' x-first' : ''}${pos + end === r![1] ? ' x-last' : ''}` : '', t[1] ? tokClass(t) : ''].filter(Boolean).join(' ');
      out += cls ? `<span class="${cls}">${esc(piece)}</span>` : esc(piece);
      s = end;
    }
    pos += t[0].length;
  }
  return out;
}

function codeCell(l: Line, tk: Tokens | null, side?: 'left' | 'right'): string {
  const cls = l.k === '+' ? 'blob-code-addition' : l.k === '-' ? 'blob-code-deletion' : 'blob-code-context';
  const toks = tk ? (l.k === '-' ? tk.old[tk.oldIdx(l)] : tk.new[tk.newIdx(l)]) : undefined;
  return `<td class="blob-code ${cls}"${side ? ` data-split-side="${side}"` : ''}><span class="blob-code-inner blob-code-marker" data-code-marker="${l.k === ' ' ? ' ' : l.k === '+' ? '+' : '-'}">${lineHtml(l.t, toks, l.x)}</span></td>`;
}

const numCell = (k: Kind, num: number) =>
  `<td class="blob-num blob-num-${k === '+' ? 'addition' : k === '-' ? 'deletion' : 'context'}" data-line-number="${num}"></td>`;
const EMPTY = '<td class="blob-num blob-num-empty empty-cell"></td><td class="blob-code blob-code-empty empty-cell"></td>';

function expanders(row: Extract<Row, { type: 'hunk' | 'tail' }>, i: number): string {
  const g = row.gap;
  if (!g) return '<span class="blob-num-dots">…</span>';
  const btn = (dir: string, name: IconName, label: string) =>
    `<button type="button" class="directional-expander" data-expand="${dir}" data-row="${i}" aria-label="${label}" title="${label}">${icon(name)}</button>`;
  if (row.type === 'tail') return btn('down', 'fold-down', 'Expand Down');
  if (row.first) return btn('up', 'fold-up', 'Expand Up');
  const count = g.oldTo - g.oldFrom + 1;
  if (count <= EXPAND_STEP) return btn('all', 'unfold', 'Expand All');
  return btn('down', 'fold-down', 'Expand Down') + btn('up', 'fold-up', 'Expand Up');
}

/** Row heights in px (see style.css): a code line that does not wrap, a hunk
 *  row, and a hunk row with both expanders stacked. */
export const ROW_PX = 20;
export const HUNK_PX = 28;
export const TWIN_PX = 40;

const ALNUM = /[A-Za-z0-9]/;

/** Whether a line of code may wrap before `s[i]`: after spaces, a hyphen
 *  inside a word, or a slash, and before a bracket that follows punctuation.
 *  Roughly where Firefox breaks code (UAX #14). */
function breakBefore(s: string, i: number): boolean {
  const c = s[i]!;
  const p = s[i - 1]!;
  if (c === ' ') return false;
  if (p === ' ') return true;
  if (p === '-') return ALNUM.test(s[i - 2] ?? '') && /[A-Za-z]/.test(c);
  if (p === '/') return c !== '/' && !/\d/.test(c);
  return '([{'.includes(c) && ':;,!?)]}'.includes(p);
}

/** Screen lines a line of code takes in a cell `cpl` characters wide
 *  (white-space: pre-wrap, overflow-wrap: anywhere, tab-size 8). */
export function screenLines(t: string, cpl: number): number {
  if (t.length * 8 <= cpl) return 1;
  let s = t;
  if (t.includes('\t')) {
    s = '';
    for (const ch of t) s += ch === '\t' ? ' '.repeat(8 - (s.length % 8)) : ch;
  }
  if (s.length <= cpl) return 1;
  let lines = 1;
  let col = 0;
  let start = 0;
  for (let i = 1; i <= s.length; i++) {
    if (i < s.length && !breakBefore(s, i)) continue;
    let end = i;
    while (end > start && s[end - 1] === ' ') end--;
    const w = end - start;
    if (col && col + w > cpl) (lines++, (col = 0));
    // A piece longer than a whole line breaks anywhere; trailing spaces hang.
    const over = Math.max(0, Math.ceil(w / cpl) - 1);
    lines += over;
    col += w - over * cpl + (i - end);
    start = i;
  }
  return lines;
}

/** One `<tr>` per display row. */
export function renderRows(rows: Row[], mode: 'split' | 'unified', tk: Tokens | null): string[] {
  const out: string[] = [];
  const nums = mode === 'split' ? 1 : 2;
  const codeSpan = mode === 'split' ? 3 : 1;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.type !== 'line') {
      out.push(`<tr class="js-expandable-line${twin(r) ? ' is-twin' : ''}"><td class="blob-num blob-num-expandable" colspan="${nums}">${expanders(r, i)}</td><td class="blob-code blob-code-inner blob-code-hunk" colspan="${codeSpan}">${r.type === 'hunk' ? esc(r.header) : ''}</td></tr>`);
      continue;
    }
    const l = r.line;
    if (mode === 'unified') {
      out.push(`<tr>${l.o ? numCell(l.k, l.o) : '<td class="blob-num blob-num-addition empty-num"></td>'}${l.n ? numCell(l.k, l.n) : '<td class="blob-num blob-num-deletion empty-num"></td>'}${codeCell(l, tk)}</tr>`);
      continue;
    }
    if (l.k === ' ') {
      out.push(`<tr>${numCell(' ', l.o)}${codeCell(l, tk, 'left')}${numCell(' ', l.n)}${codeCell(l, tk, 'right')}</tr>`);
      continue;
    }
    const [dels, adds, j] = changeBlock(rows, i);
    for (let p = 0; p < Math.max(dels.length, adds.length); p++) {
      const d = dels[p];
      const a = adds[p];
      out.push(`<tr>${d ? numCell('-', d.o) + codeCell(d, tk, 'left') : EMPTY}${a ? numCell('+', a.n) + codeCell(a, tk, 'right') : EMPTY}</tr>`);
    }
    i = j - 1;
  }
  return out;
}

/** A hunk row after a gap too long to expand in one step: it has both expanders. */
const twin = (r: Extract<Row, { type: 'hunk' | 'tail' }>) => !!r.gap && r.type === 'hunk' && !r.first && r.gap.oldTo - r.gap.oldFrom + 1 > EXPAND_STEP;

/** A change block from rows[i] on: its deletions and additions, which split
 *  pairs line by line, and the index after it. */
function changeBlock(rows: Row[], i: number): [Line[], Line[], number] {
  const dels: Line[] = [];
  const adds: Line[] = [];
  let j = i;
  while (j < rows.length) {
    const rj = rows[j]!;
    if (rj.type !== 'line' || rj.line.k === ' ') break;
    (rj.line.k === '-' ? dels : adds).push(rj.line);
    j++;
  }
  return [dels, adds, j];
}

/** The height in px of each `<tr>` from `renderRows`, when code cells hold `cpl` characters per line. */
export function rowHeights(rows: Row[], mode: 'split' | 'unified', cpl: number): number[] {
  const out: number[] = [];
  const lines = (l: Line | undefined) => (l ? screenLines(l.t, cpl) : 1);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.type !== 'line') out.push(twin(r) ? TWIN_PX : HUNK_PX);
    else if (mode === 'unified' || r.line.k === ' ') out.push(lines(r.line) * ROW_PX);
    else {
      const [dels, adds, j] = changeBlock(rows, i);
      for (let p = 0; p < Math.max(dels.length, adds.length); p++) out.push(Math.max(lines(dels[p]), lines(adds[p])) * ROW_PX);
      i = j - 1;
    }
  }
  return out;
}

/** The highest line number shown, which sets the number columns' width. */
export function maxLine(rows: Row[]): number {
  let max = 0;
  for (const r of rows) if (r.type === 'line') max = Math.max(max, r.line.o, r.line.n);
  return max;
}

/** A character's width in 12px code (see .blob-code-inner). */
export const CHAR_PX = 7.23;

/** A line-number column's width: GitHub's 44px in split, 50px in unified, wider for long files. */
export const numWidth = (mode: 'split' | 'unified', maxLine: number) => Math.max(mode === 'split' ? 44 : 50, Math.ceil(String(maxLine).length * CHAR_PX + 20));

export function colgroup(mode: 'split' | 'unified', maxLine: number): string {
  const w = numWidth(mode, maxLine);
  return mode === 'split' ? `<colgroup><col width="${w}"><col><col width="${w}"><col></colgroup>` : `<colgroup><col width="${w}"><col width="${w}"><col></colgroup>`;
}

/**
 * Old and new documents to highlight when only the patch is known: one per
 * hunk, so a string or comment cut off at a hunk's edge does not run on into
 * the next hunk. Line indexes count across all of a side's documents.
 */
export function patchDocs(rows: Row[]): { old: string[]; new: string[]; oldIdx: Map<Line, number>; newIdx: Map<Line, number> } {
  const o: string[][] = [];
  const n: string[][] = [];
  const oldIdx = new Map<Line, number>();
  const newIdx = new Map<Line, number>();
  let oi = 0;
  let ni = 0;
  for (const r of rows) {
    if (r.type !== 'line') {
      o.push([]);
      n.push([]);
      continue;
    }
    const l = r.line;
    if (l.k !== '+') {
      oldIdx.set(l, oi++);
      o[o.length - 1]!.push(l.t);
    }
    if (l.k !== '-') {
      newIdx.set(l, ni++);
      n[n.length - 1]!.push(l.t);
    }
  }
  // An empty document still tokenizes to one line, which would shift indexes.
  const docs = (hunks: string[][]) => hunks.filter((h) => h.length).map((h) => h.join('\n'));
  return { old: docs(o), new: docs(n), oldIdx, newIdx };
}

export function diffstatBlocks(adds: number, dels: number, added = false): string {
  // GitHub shows an empty new file as five green blocks.
  if (adds + dels === 0 && added) adds = 1;
  const total = adds + dels;
  const slots = Math.min(total, 5);
  const g = total ? Math.floor((adds / total) * slots) : 0;
  const r = total ? Math.floor((dels / total) * slots) : 0;
  return `<span class="diffstat-blocks" style="--g:${g};--r:${r}"></span>`;
}

export { esc };
