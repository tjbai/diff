import { expect, test } from 'bun:test';
import { pathOrder, splitPatch } from '../src/patch.ts';
import { buildRows, parsePatch, patchDocs, renderRows, rowHeights, screenLines } from '../src/client/diff.ts';

test('pathOrder matches git and GitHub: plain byte order of the path', () => {
  const paths = ['a/b/c.ts', 'a/b.ts', 'B.md', 'a/b10.ts', 'a/b2.ts', 'a.ts'];
  paths.sort(pathOrder);
  expect(paths).toEqual(['B.md', 'a.ts', 'a/b.ts', 'a/b/c.ts', 'a/b10.ts', 'a/b2.ts']);
});

test('splitPatch keeps each section with its own stats and kinds', () => {
  const patch = [
    'diff --git a/src/b.ts b/src/b.ts',
    'index 1111111..2222222 100644',
    '--- a/src/b.ts',
    '+++ b/src/b.ts',
    '@@ -1,2 +1,2 @@',
    '-const a = 1;',
    '+const a  =  1;',
    ' x',
    'diff --git a/old.md b/docs/new.md',
    'similarity index 100%',
    'rename from old.md',
    'rename to docs/new.md',
    'diff --git a/src/a.ts b/src/a.ts',
    'deleted file mode 100644',
    'index 3333333..0000000',
    '--- a/src/a.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-gone',
    '',
  ].join('\n');
  const { files, sections } = splitPatch(patch);
  expect(files.map((f) => f.path)).toEqual(['docs/new.md', 'src/a.ts', 'src/b.ts']);
  const [renamed, deleted, ws] = files;
  expect(renamed).toMatchObject({ status: 'renamed', prevPath: 'old.md', kinds: ['renames'], cats: ['docs', 'trivial'] });
  expect(deleted).toMatchObject({ status: 'deleted', deletions: 1, kinds: ['deleted'] });
  expect(ws).toMatchObject({ status: 'modified', additions: 1, deletions: 1, kinds: ['whitespace'] });
  expect(sections[2]!.startsWith('diff --git a/src/b.ts')).toBe(true);
  expect(sections[2]!.includes('a/src/a.ts')).toBe(false);
});

test('patchDocs highlights each hunk on its own so a cut-off string cannot leak', () => {
  const patch = [
    '@@ -1,2 +1,2 @@',
    ' def f():',
    '     """starts here, ends past the hunk',
    '@@ -10,1 +10,2 @@',
    '+x = 1',
    ' y = 2',
    '@@ -20,0 +21,1 @@',
    '+z = 3',
  ].join('\n');
  const rows = buildRows(parsePatch(patch), false, false);
  const d = patchDocs(rows);
  expect(d.old).toEqual(['def f():\n    """starts here, ends past the hunk', 'y = 2']);
  expect(d.new).toEqual(['def f():\n    """starts here, ends past the hunk', 'x = 1\ny = 2', 'z = 3']);
  const lines = rows.flatMap((r) => (r.type === 'line' ? [r.line] : []));
  expect(lines.map((l) => d.oldIdx.get(l) ?? -1)).toEqual([0, 1, -1, 2, -1]);
  expect(lines.map((l) => d.newIdx.get(l) ?? -1)).toEqual([0, 1, 2, 3, 4]);
});

test('rowHeights sizes each row renderRows makes, so a file box fits before it renders', () => {
  const patch = [
    '@@ -1,4 +1,5 @@',
    ' a',
    '-b',
    '-c',
    '+B',
    '+C',
    '+D',
    ` ${'w'.repeat(30)}`,
    '@@ -10,2 +11,2 @@',
    ' x',
    '-y',
    '+Y',
    '@@ -40,1 +41,1 @@',
    '-z',
    '+Z',
  ].join('\n');
  const rows = buildRows(parsePatch(patch), true, true);
  // Hunk rows are 28px, or 40px with both expanders after a gap of more than
  // 20 lines (12–39 here); lines are 20px a screen line, and 30 characters
  // take three at 12 per line. Split pairs b/c with B/C/D, y/Y, and z/Z.
  const unified = [28, 20, 20, 20, 20, 20, 20, 60, 28, 20, 20, 20, 40, 20, 20, 28];
  const split = [28, 20, 20, 20, 20, 60, 28, 20, 20, 40, 20, 28];
  for (const [mode, want] of [['unified', unified], ['split', split]] as const) {
    const px = rowHeights(rows, mode, 12);
    expect(px).toEqual(want);
    const trs = renderRows(rows, mode, null);
    expect(trs.map((tr) => tr.includes('is-twin'))).toEqual(px.map((h) => h === 40));
  }
});

test('screenLines wraps code where the browser does', () => {
  expect(screenLines('short', 10)).toBe(1);
  // Words move to the next line whole: three lines, though 19 characters fit in two.
  expect(screenLines('aaaaaaa bbbbbbb ccc', 10)).toBe(3);
  // A word longer than a line starts a new one, then breaks anywhere.
  expect(screenLines(`    ${'a'.repeat(12)}`, 10)).toBe(3);
  expect(screenLines('a'.repeat(25), 10)).toBe(3);
  // A tab runs to the next stop of 8.
  expect(screenLines('\tx', 8)).toBe(2);
});
