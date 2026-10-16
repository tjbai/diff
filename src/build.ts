// Bundle the client: the app as one ES module and the Shiki highlighter as one
// classic worker script. Neither has imports or chunks, so an export can
// inline both. Grammars are not bundled; the server (or the export) supplies
// the ones a PR uses.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ICONS } from './client/icons.ts';

const ROOT = join(import.meta.dir, '..');

export interface ClientBuild {
  js: string;
  css: string;
  worker: string;
  hash: string;
}

async function bundle(entry: string, format: 'esm' | 'iife'): Promise<string> {
  const res = await Bun.build({ entrypoints: [join(ROOT, entry)], target: 'browser', format, minify: true });
  if (!res.success) throw new AggregateError(res.logs, `build of ${entry} failed`);
  if (res.outputs.length !== 1) throw new Error(`${entry} produced ${res.outputs.length} outputs`);
  return res.outputs[0]!.text();
}

/** One mask image per octicon, for `.octicon-<name>` (see `icon()` in diff.ts). */
function iconCss(): string {
  return Object.entries(ICONS)
    .map(([name, d]) => `.octicon-${name}{--icon:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='${d}'/%3E%3C/svg%3E")}`)
    .join('\n');
}

/** The stylesheet is inlined into every page, so it ships minified. */
export async function buildCss(file: string): Promise<string> {
  const res = await Bun.build({ entrypoints: [join(ROOT, file)], target: 'browser', minify: true });
  if (!res.success) throw new AggregateError(res.logs, `build of ${file} failed`);
  return (await res.outputs[0]!.text()).trim();
}

export async function buildClient(): Promise<ClientBuild> {
  const [js, worker, style] = await Promise.all([bundle('src/client/app.ts', 'esm'), bundle('src/client/hl-worker.ts', 'iife'), buildCss('src/client/style.css')]);
  const css = style + iconCss();
  const hash = createHash('sha1').update(js).update(worker).update(css).digest('hex').slice(0, 10);
  return { js, css, worker, hash };
}
