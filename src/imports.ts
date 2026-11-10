// Import-only edits: every changed line of a file is part of an import
// statement, or blank. Moving a module touches every file that imports it,
// and these are the files that only follow the move.

// A line that starts an import, per language, by file extension.
const PY = /^\s*(from\s+\.*[\w.]*\s+import\s+[\w(*]|import\s+\w[\w.]*(\s+as\s+\w+)?(\s*,\s*\w[\w.]*(\s+as\s+\w+)?)*\s*(#.*)?$)/;
const JS = /^\s*(import\s+(type\s+)?[\w${*'"]|export\s+(type\s+)?[*{]|(const|let|var)\s+[\w${},\s]+=\s*require\(\s*['"][^'"]*['"]\s*\);?\s*$)/;
const GO = /^\s*import(\s*\(|\s+[\w."])/;
const JVM = /^\s*import\s+(static\s+)?\w[\w.]*/;
const RS = /^\s*(pub(\([\w\s:]+\))?\s+)?(use\s+[\w:{*]|extern\s+crate\s+\w)/;
const CS = /^\s*(global\s+)?using\s+(static\s+)?\w[\w.]*(\s*=\s*[\w.<>, ]+)?\s*;\s*$/;
const C = /^\s*#\s*(include|import)\s*[<"]/;
const SWIFT = /^\s*(@\w+\s+)*import\s+(\w+\s+)?\w[\w.]*\s*$/;
const RB = /^\s*require(_relative)?\s*\(?\s*['"][^'"]+['"]\s*\)?\s*$/;
const PHP = /^\s*(use\s+[\\\w]+[^;]*|(require|include)(_once)?\b[^;]*);\s*$/;
const DART = /^\s*(import|export|part)\s+['"]/;

const BY_EXT: Record<string, RegExp> = {
  py: PY, pyi: PY,
  js: JS, jsx: JS, ts: JS, tsx: JS, mjs: JS, cjs: JS, mts: JS, cts: JS, vue: JS, svelte: JS, astro: JS,
  go: GO,
  java: JVM, kt: JVM, kts: JVM, scala: JVM, groovy: JVM,
  rs: RS,
  cs: CS,
  c: C, h: C, cc: C, cpp: C, cxx: C, hh: C, hpp: C, hxx: C, m: C, mm: C, cu: C,
  swift: SWIFT,
  rb: RB,
  php: PHP,
  dart: DART,
};

/** Net open brackets on a line: a statement continues while this stays above 0. */
function depth(line: string): number {
  let d = 0;
  for (const ch of line) {
    if (ch === '(' || ch === '{' || ch === '[') d++;
    else if (ch === ')' || ch === '}' || ch === ']') d--;
  }
  return d;
}

/** Whether every changed line of one file's patch section is an import or blank. */
export function importOnly(section: string, path: string): boolean {
  const start = BY_EXT[path.slice(path.lastIndexOf('.') + 1).toLowerCase()];
  if (!start) return false;
  // Open import statement per side: bracket depth, and a pending `\` continuation.
  const open = { old: 0, new: 0 };
  const cont = { old: false, new: false };
  let imports = 0;
  let inHunk = false;
  // Feeds one line to one side; returns whether it belongs to an import.
  const feed = (side: 'old' | 'new', text: string): boolean => {
    const inside = open[side] > 0 || cont[side];
    const isImport = inside || start.test(text);
    open[side] = isImport ? Math.max(0, open[side] + depth(text)) : 0;
    cont[side] = isImport && text.trimEnd().endsWith('\\');
    return isImport;
  };
  for (const line of section.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true;
      // Git puts the last line before the hunk that starts with a letter in
      // the header. When that line opens a multi-line import, as
      // `from x import (` or `import {` does, the hunk starts inside it.
      const fn = /^@@ [^@]* @@ ?(.*)$/.exec(line)?.[1]?.trimEnd() ?? '';
      const opens = start.test(fn) && /[({]$/.test(fn) ? 1 : 0;
      open.old = open.new = opens;
      cont.old = cont.new = false;
      continue;
    }
    if (!inHunk) continue;
    const mark = line[0];
    const text = line.slice(1);
    if (mark === ' ') feed('old', text), feed('new', text);
    else if (mark === '-' || mark === '+') {
      const side = mark === '-' ? 'old' : 'new';
      if (!text.trim()) continue;
      if (!feed(side, text)) return false;
      imports++;
    }
  }
  return imports > 0;
}
