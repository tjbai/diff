import { expect, test } from 'bun:test';
import { checkPath, decodeFile, resolveEntry } from '../src/repository.ts';
import type { RepoTree } from '../src/repository-types.ts';

test('a nested file follows only the selected snapshot tree, including unusual path names', async () => {
  const root = 'a'.repeat(40), folder = 'b'.repeat(40), blob = 'c'.repeat(40);
  const objects: Record<string, RepoTree> = {
    [root]: { entries: [{ path: 'folder with spaces', type: 'tree', mode: '040000', sha: folder }], truncated: false },
    [folder]: { entries: [{ path: 'café #1.ts', type: 'blob', mode: '100644', sha: blob, size: 10 }], truncated: false },
  };
  const requests: string[] = [];
  const entry = await resolveEntry(root, 'folder with spaces/café #1.ts', async (sha) => { requests.push(sha); return objects[sha]!; });
  expect(entry).toMatchObject({ sha: blob, path: 'folder with spaces/café #1.ts', type: 'blob' });
  expect(requests).toEqual([root, folder]);
});

test('missing paths and traversing a symlink do not silently show a different file', async () => {
  const root = 'a'.repeat(40);
  const read = async (): Promise<RepoTree> => ({ entries: [{ path: 'link', type: 'blob', mode: '120000', sha: 'b'.repeat(40) }], truncated: false });
  await expect(resolveEntry(root, 'missing.ts', read)).rejects.toThrow('Path not found');
  await expect(resolveEntry(root, 'link/private.txt', read)).rejects.toThrow('not a directory');
  expect(await resolveEntry(root, 'link', read)).toMatchObject({ type: 'blob', mode: '120000' });
});

test('root browsing avoids a file lookup and path traversal is rejected', async () => {
  const root = 'a'.repeat(40);
  expect(await resolveEntry(root, '', async () => { throw new Error('unexpected lookup'); })).toMatchObject({ type: 'tree', sha: root });
  for (const path of ['/etc/passwd', '../secret', 'src/../secret', 'src//file', 'src/./file', 'a\0b']) expect(() => checkPath(path)).toThrow();
});

test('file decoding preserves empty and Unicode text and treats binary bytes as binary', () => {
  const encoder = new TextEncoder();
  expect(decodeFile(encoder.encode(''))).toEqual({ text: '', binary: false });
  expect(decodeFile(encoder.encode('const café = "☕";\n'))).toEqual({ text: 'const café = "☕";\n', binary: false });
  expect(decodeFile(new Uint8Array([0x50, 0, 0x47]))).toEqual({ text: null, binary: true });
  expect(decodeFile(new Uint8Array([0xff, 0xfe]))).toEqual({ text: null, binary: true });
});
