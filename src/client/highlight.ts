// Main-thread side of the Shiki worker pool.
import type { Tok } from './diff.ts';

/** A Shiki grammar, or the URL the worker fetches it from: then neither the
 *  fetch nor a big grammar's JSON.parse waits on (or holds up) the main thread. */
export type Grammar = unknown[] | string;

interface Slot {
  w: Worker;
  langs: Set<string>;
  pending: number;
  /** Answered its ping, so its script really runs. */
  ready: boolean;
}

/** How long a new worker gets to answer its ping before it is replaced. */
const PING_MS = 3000;

export class Highlighter {
  private slots: Slot[] = [];
  private waiters = new Map<number, (v: Tok[][][] | null) => void>();
  /** Requests waiting for a worker that has answered its ping. */
  private queued: (() => void)[] = [];
  private nextId = 1;

  constructor(
    workers: Worker[],
    private grammar: (lang: string) => Grammar | null,
    /** A replacement worker, fetched fresh. */
    private spawn: () => Worker,
  ) {
    for (const w of workers) this.adopt({ w, langs: new Set(), pending: 0, ready: false }, 1);
  }

  /** Wire up a worker and ping it. Firefox can start a worker from an empty
   *  script, which then never answers anything, so requests only go to
   *  workers that have answered. One that stays silent is replaced once,
   *  then dropped. */
  private adopt(slot: Slot, retries: number) {
    if (!this.slots.includes(slot)) this.slots.push(slot);
    slot.w.onmessage = (e: MessageEvent<{ pong?: true; id: number; out?: Tok[][][]; error?: string }>) => {
      if (e.data.pong) {
        slot.ready = true;
        return this.flush();
      }
      slot.pending--;
      if (e.data.error) console.warn('diff highlight:', e.data.error);
      this.waiters.get(e.data.id)?.(e.data.out ?? null);
      this.waiters.delete(e.data.id);
    };
    slot.w.onerror = (e) => console.warn('diff highlight worker:', e.message);
    slot.w.postMessage({ ping: true });
    setTimeout(() => {
      if (slot.ready) return;
      console.warn(`diff highlight: a worker did not start${retries ? '; replacing it' : ''}`);
      slot.w.terminate();
      if (retries) {
        slot.w = this.spawn();
        slot.langs.clear();
        this.adopt(slot, retries - 1);
      } else {
        this.slots.splice(this.slots.indexOf(slot), 1);
        this.flush();
      }
    }, PING_MS);
  }

  private flush() {
    for (const send of this.queued.splice(0)) send();
  }

  /** The grammar for `slot`, the first time it needs `lang`. */
  private grammarFor(slot: Slot, lang: string): Grammar | undefined {
    if (slot.langs.has(lang)) return undefined;
    slot.langs.add(lang);
    return this.grammar(lang) ?? undefined;
  }

  /** Have every worker load a grammar before anything needs it. */
  preload(lang: string) {
    if (lang === 'text' || !this.grammar(lang)?.length) return;
    for (const slot of this.slots) {
      const grammar = this.grammarFor(slot, lang);
      if (grammar) slot.w.postMessage({ lang, grammar });
    }
  }

  /** Token lines for each doc, or null (no grammar, no worker, or an error). */
  tokenize(lang: string, docs: string[]): Promise<Tok[][][] | null> {
    if (lang === 'text' || !this.slots.length || !this.grammar(lang)?.length) return Promise.resolve(null);
    return new Promise((resolve) => {
      const send = () => {
        const ready = this.slots.filter((s) => s.ready);
        if (!ready.length) return this.slots.length ? void this.queued.push(send) : resolve(null);
        const slot = ready.reduce((a, b) => (b.pending < a.pending ? b : a));
        const id = this.nextId++;
        const grammar = this.grammarFor(slot, lang);
        slot.pending++;
        this.waiters.set(id, resolve);
        slot.w.postMessage({ id, lang, grammar, docs });
      };
      send();
    });
  }
}
