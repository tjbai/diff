import { marked } from 'marked';
import DOMPurify from 'dompurify';
import GithubSlugger from 'github-slugger';
import { h } from './dom.ts';
import type { Tok } from './diff.ts';

interface Context {
  path: string;
  href: (path: string, hash: string) => string;
  raw: (path: string) => string;
  navigate: (path: string, hash: string) => void;
  tokenize: (language: string, docs: string[]) => Promise<Tok[][][] | null>;
}

/** Render into an inert fragment before attaching any repository-authored HTML. */
export function renderMarkdown(container: HTMLElement, text: string, context: Context) {
  const fragment = DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true }), {
    RETURN_DOM_FRAGMENT: true,
    USE_PROFILES: { html: true },
    SANITIZE_NAMED_PROPS: true,
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select'],
    FORBID_ATTR: ['style', 'srcset'],
  });
  const slugger = new GithubSlugger();
  for (const heading of fragment.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')) {
    const slug = slugger.slug(heading.textContent ?? '');
    heading.id = `user-content-${slug}`;
    heading.prepend(h('a', { class: 'anchor', href: `#${encodeURIComponent(slug)}`, 'aria-label': `Link to ${heading.textContent}` }, h('span', { class: 'octicon octicon-link', 'aria-hidden': true })));
  }
  for (const input of fragment.querySelectorAll('input')) {
    if (input.type !== 'checkbox') input.remove();
    else { input.disabled = true; input.classList.add('task-list-item-checkbox'); input.closest('li')?.classList.add('task-list-item'); }
  }
  const base = new URL(`https://repo.invalid/${context.path.split('/').map(encodeURIComponent).join('/')}`);
  function local(value: string) {
    if (!value || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value)) return null;
    try {
      const url = new URL(value, base);
      return { path: decodeURIComponent(url.pathname.slice(1)), hash: url.hash };
    } catch { return null; }
  }
  function scrollAnchor(hash: string) {
    try { container.querySelector(`#${CSS.escape(`user-content-${decodeURIComponent(hash.slice(1))}`)}`)?.scrollIntoView({ block: 'start' }); }
    catch { /* Malformed external fragment: leave the document at its current position. */ }
  }
  for (const a of fragment.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const value = a.getAttribute('href')!;
    const target = local(value);
    if (target) {
      a.href = context.href(target.path, target.hash);
      a.addEventListener('click', (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        if (target.path === context.path && target.hash) {
          history.pushState(null, '', a.href);
          scrollAnchor(target.hash);
        } else context.navigate(target.path, target.hash);
      });
    } else { a.rel = 'noreferrer noopener'; a.target = '_blank'; }
  }
  for (const img of fragment.querySelectorAll<HTMLImageElement>('img[src]')) {
    const target = local(img.getAttribute('src')!);
    if (target) img.src = context.raw(target.path);
    img.loading = 'lazy'; img.decoding = 'async';
  }
  for (const quote of fragment.querySelectorAll('blockquote')) {
    const p = quote.querySelector('p');
    const first = p?.firstChild;
    const match = first?.nodeType === Node.TEXT_NODE && /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/.exec(first.textContent ?? '');
    if (match && first) {
      const kind = match[1]!.toLowerCase();
      quote.className = `markdown-alert markdown-alert-${kind}`;
      first.textContent = first.textContent!.slice(match[0].length);
      quote.prepend(h('p', { class: 'markdown-alert-title' }, kind[0]!.toUpperCase() + kind.slice(1)));
    }
  }
  container.replaceChildren(fragment);
  for (const code of container.querySelectorAll<HTMLElement>('pre > code')) {
    const pre = code.parentElement!;
    const source = code.textContent ?? '';
    const copy = h('button', { class: 'btn btn-sm repo-code-copy', type: 'button', 'aria-label': 'Copy code' }, 'Copy');
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(source); copy.textContent = 'Copied!'; }
      catch { copy.textContent = 'Copy unavailable'; }
    };
    pre.append(copy);
    const language = /\blanguage-([^\s]+)/.exec(code.className)?.[1];
    if (language && source.length <= 300_000) void context.tokenize(language, [source]).then((result) => {
      if (!code.isConnected || !result?.[0]) return;
      const tokens = document.createDocumentFragment();
      result[0].forEach((line, i) => {
        if (i) tokens.append('\n');
        for (const [text, light, dark, italic] of line) {
          const span = h('span', {}, text);
          span.style.setProperty('--shiki-light', light); span.style.setProperty('--shiki-dark', dark);
          if (italic) span.style.fontStyle = 'italic';
          tokens.append(span);
        }
      });
      code.replaceChildren(tokens);
    });
  }
  if (location.hash && !/^#L\d+$/.test(location.hash)) requestAnimationFrame(() => scrollAnchor(location.hash));
}
