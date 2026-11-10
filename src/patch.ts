// Split a `git diff` into per-file sections and compute the per-file data the
// client needs before it sees any patch text.
import { getFiletypeFromFileName } from '@pierre/diffs';
import { classify, type CategoryId } from './geld.ts';
import { scanPatch } from './geld-scan.ts';
import { importOnly } from './imports.ts';

export interface FileEntry {
  path: string;
  prevPath?: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed';
  additions: number;
  deletions: number;
  /** Geld trivial kinds (renames, modes, binary, deleted, whitespace, comments), and `imports`. */
  kinds?: string[];
  /** Every Geld category the file belongs to, in catalog order. */
  cats: CategoryId[];
  /** Size of this file's patch section in UTF-16 code units. */
  size: number;
  lang: string;
  /** Fingerprint of this file's patch section; a Reviewed mark holds while it matches. */
  hash: string;
}

interface Section {
  start: number;
  end: number;
}

function splitSections(patch: string): Section[] {
  const out: Section[] = [];
  let at = patch.startsWith('diff --git ') ? 0 : patch.indexOf('\ndiff --git ');
  if (at > 0) at += 1;
  while (at >= 0 && at < patch.length) {
    const next = patch.indexOf('\ndiff --git ', at);
    const end = next === -1 ? patch.length : next + 1;
    out.push({ start: at, end });
    at = next === -1 ? -1 : next + 1;
  }
  return out;
}

function renameFrom(section: string): string | undefined {
  const m = /^rename from (.*)$/m.exec(section.slice(0, Math.min(section.length, 4096)));
  return m?.[1];
}

// GitHub lists files in plain path order (git's byte order, so `a/b.ts`
// comes before `a/b/c.ts`), and its tree keeps that order. So do we.
export function pathOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface SplitPatch {
  files: FileEntry[];
  /** Patch text per file, aligned with `files`. */
  sections: string[];
}

export function splitPatch(patch: string): SplitPatch {
  const sections = splitSections(patch);
  const scanned = scanPatch(patch) as Array<{
    path: string;
    additions: number;
    deletions: number;
    status: FileEntry['status'];
    kinds?: string[];
  }>;
  if (scanned.length !== sections.length) {
    throw new Error(`patch split mismatch: ${sections.length} sections, ${scanned.length} scanned`);
  }
  const rows = sections.map((s, i) => {
    const text = patch.slice(s.start, s.end);
    const scan = scanned[i]!;
    if ((scan.status === 'modified' || scan.status === 'renamed') && importOnly(text, scan.path)) {
      scan.kinds = [...(scan.kinds ?? []), 'imports'];
    }
    const entry: FileEntry = {
      path: scan.path,
      status: scan.status,
      additions: scan.additions,
      deletions: scan.deletions,
      cats: classify(scan),
      size: text.length,
      lang: getFiletypeFromFileName(scan.path),
      hash: Bun.hash(text).toString(36),
    };
    if (scan.kinds) entry.kinds = scan.kinds;
    if (scan.status === 'renamed') entry.prevPath = renameFrom(text);
    return { entry, text };
  });
  rows.sort((a, b) => pathOrder(a.entry.path, b.entry.path));
  return { files: rows.map((r) => r.entry), sections: rows.map((r) => r.text) };
}
