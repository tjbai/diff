// The HTML shell shared by the live page and exported files.
import { readFileSync } from 'node:fs';

// Inlined so exports carry the favicon too.
const FAVICON = `data:image/svg+xml,${encodeURIComponent(readFileSync(new URL('logo.svg', import.meta.url), 'utf8').trim())}`;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

// Inline scripts must not contain `</script` or `<!--`; both escapes are
// no-ops inside JS strings, regexes, and template literals.
const inlineScript = (js: string) => js.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');


// Shown in #app until the app mounts over it, so it plays before any script:
// five diffstat rows (i added, s deleted, u neutral) that fill in left to
// right with a hop, hold, and drain, each row a beat behind the one above.
// Its CSS lives here, not in style.css, since only the shell uses it, and is
// written tight because nothing minifies it and it counts against bytes.html.
const LOADER_CSS =
  '.boot{height:100vh;display:grid;place-content:center;gap:4px;animation:pop .4s cubic-bezier(.3,1.7,.5,1)}' +
  '.boot b{display:flex;gap:4px}' +
  '.boot b>*{--k:var(--bg-neutral-muted);padding:7px;border-radius:3px;background:var(--bg-neutral-muted);animation:boot 1.8s calc(var(--c,0)*70ms + var(--r)*120ms) infinite}' +
  '.boot i{--k:var(--diffstat-added)}.boot s{--k:var(--diffstat-deleted)}' +
  '.boot b>:nth-child(2){--c:1}.boot b>:nth-child(3){--c:2}.boot b>:nth-child(4){--c:3}.boot b>:nth-child(5){--c:4}' +
  '@keyframes pop{from{opacity:0;transform:scale(.6)}}' +
  '@keyframes boot{12%{background:var(--k);transform:translateY(-8px) scale(1.15)}24%,60%{background:var(--k);transform:none}}' +
  '@media (prefers-reduced-motion:reduce){.boot b>*{animation:none;background:var(--k)}}';
const LOADER = `<style>${LOADER_CSS}</style><div class=boot>${['iiisu', 'issss', 'iiiii', 'iisuu', 'sssuu']
  .map((row, r) => `<b style=--r:${r}>${row.replace(/./g, '<$&></$&>')}</b>`)
  .join('')}</div>`;

interface ShellOptions {
  title: string;
  css: string;
  /** Inline script that runs first and sets `window.__prvBoot`. */
  boot: string;
  /** Extra markup at the end of <body> (the app script, embedded data). */
  body: string;
  head?: string;
  /** Show the loader while the app script and data load. */
  loader?: boolean;
}

function shell(o: ShellOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(o.title)}</title>
<link rel="icon" href="${FAVICON}">
<script>${inlineScript(o.boot)}</script>
${o.head ?? ''}<style>${o.css}</style>
</head>
<body>
<div id="app">${o.loader ? LOADER : ''}</div>
${o.body}
</body>
</html>`;
}

export function livePage(p: { owner: string; repo: string; number: number; css: string; hash: string }): string {
  const api = `/api/pr/${p.owner}/${p.repo}/${p.number}?cached=1`;
  // The manifest request and the highlighter workers start before the app script loads.
  const worker = JSON.stringify(`/hl-worker.js?v=${p.hash}`);
  const boot = `window.__prvBoot={mode:'live',owner:${JSON.stringify(p.owner)},repo:${JSON.stringify(p.repo)},number:${p.number},manifest:fetch(${JSON.stringify(api)}).then(function(r){return r.ok?r.json():r.text().then(function(t){throw new Error(t)})}),workers:[new Worker(${worker}),new Worker(${worker})]};`;
  const src = `/app.js?v=${p.hash}`;
  return shell({
    title: `${p.owner}/${p.repo}#${p.number} · diff`,
    css: p.css,
    boot,
    head: `<link rel="modulepreload" href="${src}">\n`,
    body: `<script type="module" src="${src}"></script>`,
    loader: true,
  });
}

export function indexPage(p: { css: string; hash: string }): string {
  const src = `/app.js?v=${p.hash}`;
  return shell({
    title: 'diff',
    css: p.css,
    boot: `window.__prvBoot={mode:'index'};`,
    body: `<script type="module" src="${src}"></script>`,
  });
}

export function exportPage(p: { title: string; css: string; js: string; bundleB64: string; workerB64: string }): string {
  return shell({
    title: p.title,
    css: p.css,
    boot: `window.__prvBoot={mode:'export'};`,
    body: `<script type="application/octet-stream" id="prv-bundle">${p.bundleB64}</script>
<script type="application/octet-stream" id="prv-worker">${p.workerB64}</script>
<script type="module">${inlineScript(p.js)}</script>`,
    loader: true,
  });
}
