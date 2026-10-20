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

self.onmessage = async (e: MessageEvent<Req | { ping: true }>) => {
  // The pool's liveness check: proves this script loaded and ran.
  if ('ping' in e.data) return postMessage({ pong: true });
  const { id, lang, grammar, docs } = e.data;
  try {
    const hl = await hlP;
    if (grammar?.length && !loading.has(lang)) {
      loading.set(
        lang,
        (async () => {
          const g = typeof grammar === 'string' ? await (await fetch(grammar)).json() : grammar;
          await hl.loadLanguage(...(g as never[]));
        })(),
      );
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
