// Shiki in a worker: GitHub light/dark default themes, grammars supplied per request.
import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
// The *-default themes use Primer's current syntax palette, which is what
// github.com renders; plain github-light/dark are the older VS Code colors.
import githubDark from '@shikijs/themes/github-dark-default';
import githubLight from '@shikijs/themes/github-light-default';

/** Tokenize `docs`; or, without `docs`, only load the grammar ahead of time. */
interface Req {
  id?: number;
  lang: string;
  /** The grammar, or the URL to fetch it from. */
  grammar?: unknown[] | string;
  docs?: string[];
}

const hlP = createHighlighterCore({
  themes: [githubLight, githubDark],
  langs: [],
  engine: createJavaScriptRegexEngine({ forgiving: true }),
});

// Grammars by language, loaded or loading. A request that arrives while its
// grammar is still being fetched waits for it.
const loading = new Map<string, Promise<void>>();
/** Each language's grammar as first sent, so a failed load can be tried again. */
const sources = new Map<string, unknown[] | string>();

/** A grammar from the server. Firefox has handed this worker empty 200
 *  bodies, so a bad read is logged (transferSize 0 means it came from the
 *  HTTP cache) and fetched again past the cache. */
async function fetchGrammar(url: string): Promise<unknown[]> {
  const res = await fetch(url);
  const text = await res.text();
  try {
    if (res.ok) return JSON.parse(text);
  } catch {}
  const t = performance.getEntriesByName(new URL(url, location.href).href).at(-1) as PerformanceResourceTiming | undefined;
  console.warn(`diff highlight: ${url} came back ${res.status} with ${text.length} chars (transferSize ${t?.transferSize ?? '?'}); refetching`);
  const again = await fetch(url, { cache: 'reload' });
  if (!again.ok) throw new Error(`${url}: ${again.status}`);
  return again.json();
}

self.onmessage = async (e: MessageEvent<Req | { ping: true }>) => {
  // The pool's liveness check: proves this script loaded and ran.
  if ('ping' in e.data) return postMessage({ pong: true });
  const { id, lang, grammar, docs } = e.data;
  try {
    const hl = await hlP;
    if (grammar?.length) sources.set(lang, grammar);
    const src = sources.get(lang);
    if (src && !loading.has(lang)) {
      const p = (async () => {
        const g = typeof src === 'string' ? await fetchGrammar(src) : src;
        await hl.loadLanguage(...(g as never[]));
      })();
      loading.set(lang, p);
      // Forget a failure, so the next request for this language tries again.
      p.catch(() => loading.delete(lang));
    }
    await loading.get(lang);
    if (!docs) return;
    const out = docs.map((doc) =>
      hl
        .codeToTokens(doc, {
          lang,
          themes: { light: 'github-light-default', dark: 'github-dark-default' },
          defaultColor: false,
          tokenizeMaxLineLength: 1000,
        })
        .tokens.map((line) =>
          line.map((t) => {
            const s = (t.htmlStyle ?? {}) as Record<string, string>;
            return [t.content, s['--shiki-light'] ?? '', s['--shiki-dark'] ?? '', s['--shiki-light-font-style'] === 'italic' ? 1 : 0];
          }),
        ),
    );
    postMessage({ id, out });
  } catch (err) {
    postMessage({ id, error: String(err) });
  }
};
