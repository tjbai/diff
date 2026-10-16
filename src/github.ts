// GitHub metadata, the blobless bare-clone cache, and the per-PR diff cache.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { splitPatch, type FileEntry } from './patch.ts';

export const CACHE_ROOT = process.env.PRV_CACHE ?? join(homedir(), '.cache', 'prv');

export interface PrMeta {
  owner: string;
  repo: string;
  number: number;
  title: string;
  state: 'open' | 'closed' | 'merged' | 'draft';
  author: string;
  url: string;
  baseRef: string;
  headRef: string;
  /** `owner/repo` of the head branch when it lives in a fork; absent in older cached results. */
  headRepo?: string;
  commits: number;
  viewerDidAuthor?: boolean;
  /** The commit you last approved at, if your latest review is an approval. */
  approvedSha?: string;
}

export interface PrResult {
  meta: PrMeta;
  /** `${mergeBase}..${head}`: the cache key for the per-file results. */
  key: string;
  baseSha: string;
  headSha: string;
  files: FileEntry[];
  sections: string[];
  timings: Record<string, number>;
  /** When this result was computed or last confirmed fresh. */
  checkedAt: number;
}

// ---------------------------------------------------------------- auth

let tokenPromise: Promise<string> | undefined;
export function token(): Promise<string> {
  tokenPromise ??= (async () => {
    const p = Bun.spawn(['gh', 'auth', 'token'], { stdout: 'pipe', stderr: 'pipe' });
    const out = (await new Response(p.stdout).text()).trim();
    if ((await p.exited) !== 0 || !out) throw new Error('`gh auth token` failed; run `gh auth login`');
    return out;
  })();
  tokenPromise.catch(() => (tokenPromise = undefined));
  return tokenPromise;
}

async function gitEnv(): Promise<Record<string, string>> {
  // Pass the token as an http header through GIT_CONFIG_* so it never shows
  // up in argv and git does not have to spawn `gh` as a credential helper.
  const basic = Buffer.from(`x-access-token:${await token()}`).toString('base64');
  return {
    ...(process.env as Record<string, string>),
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    GIT_CONFIG_KEY_1: 'credential.helper',
    GIT_CONFIG_VALUE_1: '',
  };
}

// ---------------------------------------------------------------- git

export function repoDir(owner: string, repo: string): string {
  return join(CACHE_ROOT, owner, `${repo}.git`);
}

async function git(dir: string | null, args: string[]): Promise<string> {
  const p = Bun.spawn(['git', ...(dir ? ['-C', dir] : []), ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: await gitEnv(),
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.slice(0, 3).join(' ')} failed (${code}): ${err.trim()}`);
  return out;
}

const cloning = new Map<string, Promise<void>>();
async function ensureRepo(owner: string, repo: string): Promise<string> {
  const dir = repoDir(owner, repo);
  if (existsSync(join(dir, 'HEAD'))) return dir;
  let p = cloning.get(dir);
  if (!p) {
    mkdirSync(join(CACHE_ROOT, owner), { recursive: true });
    p = git(null, [
      'clone', '--bare', '--filter=blob:none', '--no-tags', '-q',
      `https://github.com/${owner}/${repo}.git`, dir,
    ]).then(() => undefined);
    cloning.set(dir, p);
    p.finally(() => cloning.delete(dir));
  }
  await p;
  return dir;
}

// Keep a commit-graph so merge-base stays ~10 ms instead of ~150 ms. Written
// in the background after a load; `--split` makes it incremental.
const graphing = new Set<string>();
function writeCommitGraph(dir: string) {
  if (graphing.has(dir)) return;
  graphing.add(dir);
  git(dir, ['commit-graph', 'write', '--reachable', '--split'])
    .catch((e) => console.error('commit-graph', e))
    .finally(() => graphing.delete(dir));
}

async function defaultBranch(dir: string): Promise<string | undefined> {
  const ref = (await git(dir, ['symbolic-ref', '-q', 'HEAD']).catch(() => '')).trim();
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : undefined;
}

const headRef = (n: number) => `refs/prv/pull/${n}`;
const baseRefName = (ref: string) => `refs/prv/heads/${ref}`;

// ---------------------------------------------------------------- disk cache

const prDir = (owner: string, repo: string) => join(CACHE_ROOT, owner, `${repo}.prv`);
// Bump when the cached per-file format or ordering changes.
const CACHE_FORMAT = 4;
const diffDir = (owner: string, repo: string) => join(prDir(owner, repo), `diffs-v${CACHE_FORMAT}`);
const diffPath = (owner: string, repo: string, key: string) => join(diffDir(owner, repo), key.replace('..', '_'));

export interface PrPointer {
  meta: PrMeta;
  key: string;
  baseSha: string;
  headSha: string;
  checkedAt: number;
}

async function readPointer(owner: string, repo: string, n: number): Promise<PrPointer | null> {
  const f = Bun.file(join(prDir(owner, repo), `pr-${n}.json`));
  return (await f.exists()) ? ((await f.json()) as PrPointer) : null;
}

export async function writePointer(p: PrPointer): Promise<void> {
  const dir = prDir(p.meta.owner, p.meta.repo);
  mkdirSync(dir, { recursive: true });
  await Bun.write(join(dir, `pr-${p.meta.number}.json`), JSON.stringify(p));
}

// The diff cache is two files: the per-file index (JSON) and all sections
// concatenated in display order, so a warm load is two reads and slices.
async function readDiff(owner: string, repo: string, key: string) {
  const base = diffPath(owner, repo, key);
  const idx = Bun.file(`${base}.json`);
  if (!(await idx.exists())) return null;
  const [index, text] = await Promise.all([
    idx.json() as Promise<{ files: FileEntry[]; offsets: number[] }>,
    Bun.file(`${base}.patch`).text(),
  ]);
  const sections = index.files.map((_, i) => text.slice(index.offsets[i], index.offsets[i + 1]));
  return { files: index.files, sections };
}

export async function writeDiff(owner: string, repo: string, key: string, files: FileEntry[], sections: string[]) {
  const base = diffPath(owner, repo, key);
  mkdirSync(diffDir(owner, repo), { recursive: true });
  const offsets = [0];
  for (const s of sections) offsets.push(offsets[offsets.length - 1]! + s.length);
  await Bun.write(`${base}.patch`, sections.join(''));
  await Bun.write(`${base}.json`, JSON.stringify({ files, offsets }));
}

const DAY = 86_400_000;

/** Drops old cache formats, diffs of superseded heads after a day (long enough
 *  for tabs still open on them), and the rest after two weeks without a rewrite. */
async function pruneDiffs(owner: string, repo: string) {
  const dir = prDir(owner, repo);
  const current = new Set<string>();
  for (const name of readdirSync(dir)) {
    if (name.startsWith('diffs-v') && name !== `diffs-v${CACHE_FORMAT}`) rmSync(join(dir, name), { recursive: true, force: true });
    if (name.startsWith('pr-')) current.add(((await Bun.file(join(dir, name)).json()) as PrPointer).key.replace('..', '_'));
  }
  const diffs = diffDir(owner, repo);
  for (const name of readdirSync(diffs)) {
    const path = join(diffs, name);
    const maxAge = current.has(name.replace(/\.(json|patch)$/, '')) ? 14 * DAY : DAY;
    if (Date.now() - statSync(path).mtimeMs > maxAge) rmSync(path, { force: true });
  }
}

// ---------------------------------------------------------------- load

interface GqlPull {
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  url: string;
  baseRefName: string;
  headRefName: string;
  headRepository: { nameWithOwner: string } | null;
  author: { login: string } | null;
  commits: { totalCount: number };
  viewerDidAuthor: boolean;
  viewerLatestReview: { state: string; commit: { oid: string } | null } | null;
}

// GraphQL answers in ~0.4 s where REST `pulls/N` takes ~0.75 s.
async function fetchPull(owner: string, repo: string, n: number): Promise<GqlPull> {
  const query = `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){title state isDraft url baseRefName headRefName headRepository{nameWithOwner} author{login} commits{totalCount} viewerDidAuthor viewerLatestReview{state commit{oid}}}}}`;
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables: { o: owner, r: repo, n } }),
  });
  const body = (await res.json()) as { data?: { repository?: { pullRequest?: GqlPull } }; errors?: { message: string }[] };
  const pr = body.data?.repository?.pullRequest;
  if (!res.ok || !pr) throw new Error(`GitHub: ${body.errors?.map((e) => e.message).join('; ') || res.status}`);
  return pr;
}

// Everything but the diff itself. These are small, so they are kept for every
// PR and diff key seen; the diffs live in `diffMemory` (the 8 most recently
// used) and are read back from disk after eviction.
type PrHead = Omit<PrResult, 'files' | 'sections'>;
const heads = new Map<string, PrHead>(); // `${owner}/${repo}#${n}` → latest
const headsByKey = new Map<string, PrHead>(); // diff key → the load that produced it
const diffMemory = new Map<string, Diff>(); // key → diff
const inflight = new Map<string, Promise<PrResult>>();

const prId = (owner: string, repo: string, n: number) => `${owner}/${repo}#${n}`.toLowerCase();

function rememberDiff(key: string, d: Diff) {
  diffMemory.delete(key);
  diffMemory.set(key, d);
  while (diffMemory.size > 8) diffMemory.delete(diffMemory.keys().next().value!);
}

async function getDiff(owner: string, repo: string, key: string): Promise<Diff | null> {
  const d = diffMemory.get(key) ?? (await readDiff(owner, repo, key));
  if (d) rememberDiff(key, d);
  return d;
}

function rememberHead(head: PrHead) {
  heads.set(prId(head.meta.owner, head.meta.repo, head.meta.number), head);
  headsByKey.set(head.key, head);
}

/** The last known result without touching the network, or null. */
export async function cachedPr(owner: string, repo: string, n: number): Promise<PrResult | null> {
  let head = heads.get(prId(owner, repo, n));
  if (!head) {
    const ptr = await readPointer(owner, repo, n);
    if (!ptr) return null;
    head = { ...ptr, timings: { cache: 1 } };
  }
  const diff = await getDiff(owner, repo, head.key);
  if (!diff) return null;
  rememberHead(head);
  return { ...head, ...diff };
}

/** A result by its diff key, for patches, hunk expansion, and export. */
export async function prByKey(key: string): Promise<PrResult | null> {
  const head = headsByKey.get(key);
  const diff = head && (await getDiff(head.meta.owner, head.meta.repo, key));
  return diff ? { ...head!, ...diff } : null;
}

/** Fetch, merge-base, and diff. Concurrent callers share one run. */
export function loadPr(owner: string, repo: string, n: number): Promise<PrResult> {
  const id = prId(owner, repo, n);
  let p = inflight.get(id);
  if (!p) {
    p = doLoadPr(owner, repo, n).finally(() => inflight.delete(id));
    inflight.set(id, p);
  }
  return p;
}

type Diff = { files: FileEntry[]; sections: string[] };

/** merge-base and per-file diff of the fetched PR head against a fetched base branch. */
async function diffAgainst(owner: string, repo: string, dir: string, n: number, base: string, mark: (k: string, since?: number) => void) {
  const [headSha, baseTip] = (await git(dir, ['rev-parse', headRef(n), baseRefName(base)])).trim().split('\n') as [string, string];
  const baseSha = (await git(dir, ['merge-base', baseTip, headSha])).trim();
  mark('mergeBase');
  const key = `${baseSha}..${headSha}`;
  let diff = await getDiff(owner, repo, key);
  if (diff) {
    mark('diffCached');
  } else {
    let t = performance.now();
    const patch = await git(dir, ['-c', 'core.quotepath=off', 'diff', '-M', '--no-color', '--no-ext-diff', baseSha, headSha]);
    mark('diff', t);
    t = performance.now();
    diff = splitPatch(patch);
    mark('split', t);
    writeDiff(owner, repo, key, diff.files, diff.sections)
      .then(() => pruneDiffs(owner, repo))
      .catch((e) => console.error('cache write', e));
  }
  return { headSha, baseSha, key, diff };
}

async function doLoadPr(owner: string, repo: string, n: number): Promise<PrResult> {
  const t0 = performance.now();
  const timings: Record<string, number> = {};
  const mark = (k: string, since = t0) => (timings[k] = Math.round(performance.now() - since));

  const prior = heads.get(prId(owner, repo, n)) ?? (await readPointer(owner, repo, n));
  const apiP = fetchPull(owner, repo, n).then((r) => (mark('api'), r));
  apiP.catch(() => {});
  const dir = await ensureRepo(owner, repo);
  mark('repo');

  // While the API call is in flight: fetch the PR head and the base branch we
  // saw last time (or the repo's default branch), then speculatively diff
  // against it. The speculation is kept only if the API confirms the base.
  const guessedBase = prior?.meta.baseRef ?? (await defaultBranch(dir));
  const refspecs = [`+refs/pull/${n}/head:${headRef(n)}`];
  if (guessedBase) refspecs.push(`+refs/heads/${guessedBase}:${baseRefName(guessedBase)}`);
  const fetchP = git(dir, ['fetch', '--no-tags', '-q', 'origin', ...refspecs]).then(() => mark('fetch'));
  const specP = guessedBase ? fetchP.then(() => diffAgainst(owner, repo, dir, n, guessedBase, mark)) : null;
  specP?.catch(() => {});

  const api = await apiP;
  let d: Awaited<ReturnType<typeof diffAgainst>>;
  if (specP && api.baseRefName === guessedBase) {
    d = await specP;
  } else {
    // The guessed base may be gone (a stacked PR's base branch deleted after
    // merge), which fails the whole speculative fetch, head included. Refetch
    // the head with the real base; it's a no-op if the first fetch got it.
    await (specP ?? fetchP).catch(() => {});
    const t = performance.now();
    await git(dir, ['fetch', '--no-tags', '-q', 'origin', refspecs[0]!, `+refs/heads/${api.baseRefName}:${baseRefName(api.baseRefName)}`]);
    mark('fetchBase', t);
    d = await diffAgainst(owner, repo, dir, n, api.baseRefName, mark);
  }
  rememberDiff(d.key, d.diff);
  mark('total');
  writeCommitGraph(dir);

  const meta: PrMeta = {
    owner,
    repo,
    number: n,
    title: api.title,
    state: api.state === 'MERGED' ? 'merged' : api.state === 'CLOSED' ? 'closed' : api.isDraft ? 'draft' : 'open',
    author: api.author?.login ?? 'ghost',
    url: api.url,
    baseRef: api.baseRefName,
    headRef: api.headRefName,
    ...(api.headRepository && api.headRepository.nameWithOwner.toLowerCase() !== `${owner}/${repo}`.toLowerCase() ? { headRepo: api.headRepository.nameWithOwner } : {}),
    commits: api.commits.totalCount,
    viewerDidAuthor: api.viewerDidAuthor,
    approvedSha: api.viewerLatestReview?.state === 'APPROVED' ? api.viewerLatestReview.commit?.oid : undefined,
  };
  const head: PrHead = { meta, key: d.key, baseSha: d.baseSha, headSha: d.headSha, timings, checkedAt: Date.now() };
  rememberHead(head);
  void writePointer({ meta, key: d.key, baseSha: d.baseSha, headSha: d.headSha, checkedAt: head.checkedAt });
  return { ...head, ...d.diff };
}

/** Approve the PR at the commit that was reviewed, so a push that lands
 *  mid-review is not approved unseen. Returns the updated metadata. */
export async function approvePr(owner: string, repo: string, n: number, headSha: string): Promise<PrMeta> {
  if (!/^[0-9a-f]{40}$/.test(headSha)) throw new Error('bad head');
  const head = heads.get(prId(owner, repo, n));
  if (!head) throw new Error('unknown PR; reload and try again');
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${n}/reviews`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await token()}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'APPROVE', commit_id: headSha }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; errors?: string[] };
    throw new Error(`GitHub: ${[body.message, ...(body.errors ?? [])].filter(Boolean).join('; ') || res.status}`);
  }
  const meta = { ...head.meta, approvedSha: headSha };
  rememberHead({ ...head, meta });
  void writePointer({ ...head, meta });
  return meta;
}

/** `git show <rev>:<path>` for hunk expansion. Returns null if the path does not exist. */
export async function showFile(owner: string, repo: string, rev: string, path: string): Promise<string | null> {
  if (!/^[0-9a-f]{40}$/.test(rev)) throw new Error('bad rev');
  try {
    return await git(repoDir(owner, repo), ['show', `${rev}:${path}`]);
  } catch {
    return null;
  }
}
