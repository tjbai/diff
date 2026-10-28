import { expect, test } from 'bun:test';
import { classify, compileGlob, expandBraces } from '../src/geld.ts';

const f = (path: string, extra: Partial<Parameters<typeof classify>[0]> = {}) =>
  classify({ path, additions: 1, deletions: 1, ...extra });

test('glob: no slash or trailing slash matches at any depth; inner slash anchors at root', () => {
  expect(compileGlob('tests/').test('sapiens/tests/equivalence/cases/a/observed/x.json')).toBe(true);
  expect(compileGlob('tests/').test('tests')).toBe(true);
  expect(compileGlob('tests/').test('mytests/x.py')).toBe(false);
  expect(compileGlob('*.md').test('a/b/c.md')).toBe(true);
  expect(compileGlob('.github/copilot-instructions.md').test('.github/copilot-instructions.md')).toBe(true);
  expect(compileGlob('.github/copilot-instructions.md').test('x/.github/copilot-instructions.md')).toBe(false);
  expect(compileGlob('.github/workflows/').test('x/.github/workflows/ci.yml')).toBe(true);
});

test('glob: * stays within a segment, braces expand, matching ignores case', () => {
  expect(compileGlob('*.test.*').test('src/a.test.ts')).toBe(true);
  expect(compileGlob('*.test.*').test('src/a.test/b.ts')).toBe(false);
  expect(compileGlob('*Test.{java,kt}').test('src/FooTest.kt')).toBe(true);
  expect(compileGlob('*Test.{java,kt}').test('src/FooTest.ts')).toBe(false);
  expect(compileGlob('*.md').test('README.MD')).toBe(true);
  expect(expandBraces('a.{b,{c,d}}x')).toEqual(['a.bx', 'a.cx', 'a.dx']);
});

test('classify returns every matching category in catalog order', () => {
  expect(f('sapiens/tests/cases/AGENTS.md')).toEqual(['tests', 'agents', 'docs']);
  expect(f('pnpm-lock.yaml')).toEqual(['generated']);
  expect(f('src/app.ts')).toEqual([]);
  expect(f('temporal/src/temporal/agent/transcript/history.py')).toEqual([]);
  expect(f('HISTORY.rst')).toEqual(['docs']);
  expect(f('LICENSE')).toEqual(['docs']);
  expect(f('docs/conf.py')).toEqual(['docs']);
  expect(f('src/app.ts', { kinds: ['whitespace'] })).toEqual(['trivial']);
});

test('large starts at 1000 changed lines', () => {
  expect(f('src/a.ts', { additions: 999, deletions: 0 })).toEqual([]);
  expect(f('src/a.ts', { additions: 600, deletions: 400 })).toEqual(['large']);
});
