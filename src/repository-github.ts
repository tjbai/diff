import { token } from './github.ts';

/** Authenticated, read-only GitHub requests for the repository browser. */
export async function githubRead<T>(path: string, query?: { query: string; variables: Record<string, unknown> }): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    method: query ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${await token()}`, Accept: 'application/vnd.github+json', 'content-type': 'application/json' },
    ...(query ? { body: JSON.stringify(query) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GitHub returned ${res.status}. Check repository access and try again.`);
  return res.json() as Promise<T>;
}

export async function githubArchive(owner: string, repo: string, sha: string): Promise<Response> {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/tarball/${sha}`, {
    headers: { Authorization: `Bearer ${await token()}` }, signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Could not prepare repository search (GitHub ${response.status})`);
  return response;
}
