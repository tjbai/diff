import { esc, shell } from './html.ts';

const scriptData = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');
const prefetch = (url: string) => `fetch(${scriptData(url)}).then(function(r){return r.json().then(function(b){if(!r.ok)throw new Error(b.error||r.status);return b})})`;

/** The static repository chrome paints before any script runs. */
export function repoHead(owner: string, repo: string, selected: 'code' | 'pulls'): string {
  const base = `/${esc(owner)}/${esc(repo)}`;
  const tab = (id: 'code' | 'pulls', href: string, icon: string, label: string) =>
    `<a class="UnderlineNav-item" href="${href}"${id === selected ? ' aria-current="page"' : ''}><span class="octicon octicon-${icon}"></span>${label}</a>`;
  return `<div class="repohead"><div class="repohead-title"><a href="${base}">${esc(owner)}</a><span>/</span><a href="${base}"><strong>${esc(repo)}</strong></a></div>` +
    `<nav class="UnderlineNav" aria-label="Repository">${tab('code', base, 'code', 'Code')}${tab('pulls', `${base}/pulls`, 'git-pull-request', 'Pull requests')}</nav></div>`;
}

export function repoPage(p: { owner: string; repo: string; spec: string; css: string; hash: string; workerHash: string }): string {
  // The snapshot request starts before the page script loads.
  const api = `/api/repo/${p.owner}/${p.repo}/snapshot?${new URLSearchParams({ spec: p.spec })}`;
  return shell({
    title: `${p.owner}/${p.repo}`, css: p.css,
    boot: `window.__repoBoot={owner:${scriptData(p.owner)},repo:${scriptData(p.repo)},workerHash:${scriptData(p.workerHash)},snapshot:${prefetch(api)}};`,
    head: `<link rel="stylesheet" href="/repo.css?v=${p.hash}">\n`,
    app: repoHead(p.owner, p.repo, 'code'),
    body: `<script type="module" src="/repo.js?v=${p.hash}"></script>`,
  });
}

export function pullsPage(p: { owner: string; repo: string; state: string; after: string; css: string; hash: string; repoHash: string }): string {
  const api = `/api/repo/${p.owner}/${p.repo}/pulls?${new URLSearchParams({ state: p.state, after: p.after })}`;
  return shell({
    title: `Pull requests · ${p.owner}/${p.repo}`, css: p.css,
    boot: `window.__pullsBoot={owner:${scriptData(p.owner)},repo:${scriptData(p.repo)},pulls:${prefetch(api)}};`,
    head: `<link rel="stylesheet" href="/repo.css?v=${p.repoHash}">\n`,
    app: repoHead(p.owner, p.repo, 'pulls'),
    body: `<script type="module" src="/pulls.js?v=${p.hash}"></script>`,
  });
}
