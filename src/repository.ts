import { getFiletypeFromFileName } from '@pierre/diffs';
import { githubRead } from './repository-github.ts';
import type { RepoBranches, RepoEntry, RepoFile, RepoPulls, RepoSnapshot, RepoTree } from './repository-types.ts';

export class RepoError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export function checkRepo(owner: string, repo: string) {
  if (![owner, repo].every((s) => /^[\w.-]+$/.test(s) && s !== '.' && s !== '..')) throw new RepoError('Invalid repository');
}

export function checkSha(sha: string) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new RepoError('Invalid commit or object ID');
}

export function checkPath(path: string) {
  if (path.startsWith('/') || path.includes('\0') || (path && path.split('/').some((p) => !p || p === '.' || p === '..'))) {
    throw new RepoError('Invalid repository path');
  }
}

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const body = await githubRead<{ data?: T; errors?: { message: string }[] }>('/graphql', { query, variables });
  if (body.errors?.length || !body.data) throw new RepoError(body.errors?.map((e) => e.message).join('; ') ?? 'GitHub request failed', 502);
  return body.data;
}

interface Commit {
  oid: string;
  tree: { oid: string };
  messageHeadline: string;
  committedDate: string;
  author: { name: string; avatarUrl: string };
}
const COMMIT = 'oid tree{oid} messageHeadline committedDate author{name avatarUrl}';

interface Recent<T> { expires: number; promise: Promise<T> }
const snapshots = new Map<string, Recent<Resolved>>();
const branchPages = new Map<string, Recent<RepoBranches>>();
function recent<T>(cache: Map<string, Recent<T>>, key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const existing = cache.get(key);
  if (existing && existing.expires > Date.now()) return existing.promise;
  const promise = load();
  cache.delete(key);
  cache.set(key, { expires: Date.now() + ttl, promise });
  promise.catch(() => { if (cache.get(key)?.promise === promise) cache.delete(key); });
  while (cache.size > 64) cache.delete(cache.keys().next().value!);
  return promise;
}

const isSha = (s: string) => /^[0-9a-f]{40}$/.test(s);
/** Branch names may contain slashes; only this many leading segments are tried as one. */
const MAX_REF_SEGMENTS = 8;

/** Resolve a GitHub-shaped `<ref>/<path>` spec, as in `/tree/<spec>`: the
 *  longest leading prefix that names a branch, tag, or commit wins, and the
 *  rest is the path. An empty spec is the default branch. */
export async function repoSnapshot(owner: string, repo: string, spec = ''): Promise<RepoSnapshot> {
  checkRepo(owner, repo);
  const parts = spec ? spec.split('/') : [];
  if (parts.length && isSha(parts[0]!)) {
    // A pinned commit cannot move; briefly cache its metadata to make reloads local.
    const sha = parts[0]!;
    const path = parts.slice(1).join('/');
    checkPath(path);
    const { snapshot } = await recent(snapshots, JSON.stringify([owner, repo, sha]), 60_000, () => loadSnapshot(owner, repo, [sha]));
    return { ...snapshot, path };
  }
  // Branch heads are resolved afresh, so a reload is a refresh.
  const candidates = parts.slice(0, MAX_REF_SEGMENTS).map((_, i) => parts.slice(0, i + 1).join('/'));
  const { snapshot, matched } = await loadSnapshot(owner, repo, candidates);
  const path = parts.slice(matched).join('/');
  checkPath(path);
  return { ...snapshot, path };
}

interface Resolved { snapshot: Omit<RepoSnapshot, 'path'>; matched: number }
async function loadSnapshot(owner: string, repo: string, candidates: string[]): Promise<Resolved> {
  const variables: Record<string, string> = { o: owner, r: repo };
  const declared = candidates.map((c, i) => (variables[`c${i}`] = c, `,$c${i}:String!`)).join('');
  const fields = candidates.map((_, i) => `c${i}:object(expression:$c${i}){... on Commit{${COMMIT}}}`).join(' ');
  const data = await graphql<{ repository: ({
    isPrivate: boolean;
    defaultBranchRef: { name: string; target: Commit } | null;
  } & Record<string, Commit | null>) | null }>(
    `query($o:String!,$r:String!${declared}){repository(owner:$o,name:$r){isPrivate defaultBranchRef{name target{... on Commit{${COMMIT}}}} ${fields}}}`, variables);
  const r = data.repository;
  if (!r) throw new RepoError('Repository not found or access denied', 404);
  if (!r.defaultBranchRef) throw new RepoError('This repository has no commits yet', 404);
  let matched = 0;
  let branch = r.defaultBranchRef.name;
  let c: Commit | null = r.defaultBranchRef.target;
  if (candidates.length) {
    matched = candidates.findLastIndex((_, i) => r[`c${i}`]?.tree) + 1;
    if (!matched) throw new RepoError(`Branch or commit not found: ${candidates[0]}`, 404);
    branch = candidates[matched - 1]!;
    c = r[`c${matched - 1}`]!;
  }
  const root = await repoTree(owner, repo, c.tree.oid);
  return { matched, snapshot: { repo: `${owner}/${repo}`, branch, defaultBranch: r.defaultBranchRef.name, private: r.isPrivate, sha: c.oid, tree: c.tree.oid,
    message: c.messageHeadline, author: c.author.name, authorAvatar: c.author.avatarUrl, date: c.committedDate, root } };
}

export async function repoPulls(owner: string, repo: string, state: string, after: string | null): Promise<RepoPulls> {
  checkRepo(owner, repo);
  if (state !== 'open' && state !== 'closed') throw new RepoError('Invalid pull request state');
  interface Node { number: number; title: string; isDraft: boolean; state: 'OPEN' | 'CLOSED' | 'MERGED'; author: { login: string } | null; createdAt: string; closedAt: string | null; mergedAt: string | null }
  const data = await graphql<{ repository: { open: { totalCount: number }; closed: { totalCount: number };
    pullRequests: { nodes: Node[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } | null }>(
    'query($o:String!,$r:String!,$states:[PullRequestState!]!,$after:String){repository(owner:$o,name:$r){open:pullRequests(states:OPEN){totalCount} closed:pullRequests(states:[CLOSED,MERGED]){totalCount} pullRequests(states:$states,first:25,after:$after,orderBy:{field:CREATED_AT,direction:DESC}){nodes{number title isDraft state author{login} createdAt closedAt mergedAt} pageInfo{hasNextPage endCursor}}}}',
    { o: owner, r: repo, states: state === 'open' ? ['OPEN'] : ['CLOSED', 'MERGED'], after });
  const r = data.repository;
  if (!r) throw new RepoError('Repository not found or access denied', 404);
  return {
    open: r.open.totalCount, closed: r.closed.totalCount, cursor: r.pullRequests.pageInfo.endCursor, more: r.pullRequests.pageInfo.hasNextPage,
    pulls: r.pullRequests.nodes.map((n) => ({
      number: n.number, title: n.title, author: n.author?.login ?? 'ghost',
      state: n.state === 'MERGED' ? 'merged' : n.state === 'CLOSED' ? 'closed' : n.isDraft ? 'draft' : 'open',
      at: n.mergedAt ?? n.closedAt ?? n.createdAt,
    })),
  };
}

export function repoBranches(owner: string, repo: string, query = '', cursor: string | null = null): Promise<RepoBranches> {
  checkRepo(owner, repo);
  return recent(branchPages, JSON.stringify([owner, repo, query, cursor]), 30_000, () => loadBranches(owner, repo, query, cursor));
}

async function loadBranches(owner: string, repo: string, query: string, cursor: string | null): Promise<RepoBranches> {
  const data = await graphql<{ repository: { refs: { nodes: { name: string }[]; totalCount: number; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } | null }>(
    'query($o:String!,$r:String!,$q:String!,$after:String){repository(owner:$o,name:$r){refs(refPrefix:"refs/heads/",query:$q,first:50,after:$after,orderBy:{field:ALPHABETICAL,direction:ASC}){nodes{name}totalCount pageInfo{hasNextPage endCursor}}}}',
    { o: owner, r: repo, q: query, after: cursor });
  if (!data.repository) throw new RepoError('Repository not found or access denied', 404);
  const r = data.repository.refs;
  return { names: r.nodes.map((n) => n.name), total: r.totalCount, cursor: r.pageInfo.endCursor, more: r.pageInfo.hasNextPage };
}

// Git objects are immutable. Cache a bounded number of requests by object ID,
// and share in-flight requests from the sidebar and directory viewer.
const trees = new Map<string, Promise<RepoTree>>();
function cached<T>(cache: Map<string, Promise<T>>, key: string, limit: number, load: () => Promise<T>): Promise<T> {
  let value = cache.get(key);
  if (value) return value;
  value = load();
  cache.set(key, value);
  value.catch(() => cache.delete(key));
  while (cache.size > limit) cache.delete(cache.keys().next().value!);
  return value;
}

export function repoTree(owner: string, repo: string, sha: string, recursive = false): Promise<RepoTree> {
  checkRepo(owner, repo); checkSha(sha);
  const path = `/repos/${owner}/${repo}/git/trees/${sha}${recursive ? '?recursive=1' : ''}`;
  return cached(trees, path, 128, async () => {
    const data = await githubRead<{ tree: RepoEntry[]; truncated: boolean }>(path);
    return { entries: data.tree.map(({ path, type, mode, sha, size }) => ({ path, type, mode, sha, size })), truncated: data.truncated };
  });
}

/** Resolve paths through the pinned tree, never through a moving branch name. */
export async function repoEntry(owner: string, repo: string, tree: string, path: string): Promise<RepoEntry> {
  checkPath(path); checkSha(tree); checkRepo(owner, repo);
  return resolveEntry(tree, path, (sha) => repoTree(owner, repo, sha));
}

export async function resolveEntry(tree: string, path: string, readTree: (sha: string) => Promise<RepoTree>): Promise<RepoEntry> {
  checkPath(path); checkSha(tree);
  if (!path) return { path: '', type: 'tree', mode: '040000', sha: tree };
  let entry: RepoEntry = { path: '', type: 'tree', mode: '040000', sha: tree };
  for (const part of path.split('/')) {
    if (entry.type !== 'tree') throw new RepoError('Path is not a directory', 404);
    const next = (await readTree(entry.sha)).entries.find((e) => e.path === part);
    if (!next) throw new RepoError(`Path not found on this branch: ${path}`, 404);
    entry = next;
  }
  return { ...entry, path };
}

const MAX_PREVIEW = 2 * 1024 * 1024;
const blobs = new Map<string, Promise<Buffer>>();
export async function repoBlob(owner: string, repo: string, entry: RepoEntry): Promise<Buffer> {
  checkRepo(owner, repo); checkSha(entry.sha);
  if (entry.type !== 'blob') throw new RepoError('This entry is not a file');
  if ((entry.size ?? 0) > MAX_PREVIEW) throw new RepoError('This file is larger than the 2 MB local preview limit. Open it on GitHub.', 413);
  return cached(blobs, `${owner}/${repo}/${entry.sha}`, 32, async () => {
    const blob = await githubRead<{ encoding: string; content: string; size: number }>(`/repos/${owner}/${repo}/git/blobs/${entry.sha}`);
    if (blob.size > MAX_PREVIEW) throw new RepoError('File is too large to preview', 413);
    if (blob.encoding !== 'base64') throw new RepoError('Unsupported file encoding', 415);
    return Buffer.from(blob.content, 'base64');
  });
}

export function decodeFile(bytes: Uint8Array): { text: string | null; binary: boolean } {
  if (bytes.includes(0)) return { text: null, binary: true };
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), binary: false }; }
  catch { return { text: null, binary: true }; }
}

export async function repoFile(owner: string, repo: string, entry: RepoEntry): Promise<RepoFile> {
  if (entry.type !== 'blob') throw new RepoError('This entry is not a file');
  const lang = getFiletypeFromFileName(entry.path);
  if ((entry.size ?? 0) > MAX_PREVIEW) return { size: entry.size!, binary: false, text: null, tooLarge: true, lang };
  const data = await repoBlob(owner, repo, entry);
  return { size: data.length, ...decodeFile(data), tooLarge: false, lang };
}
