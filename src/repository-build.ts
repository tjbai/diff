// Optional assets are built once, on demand. None participate in the PR hash.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { buildCss } from './build.ts';

const ROOT = join(import.meta.dir, '..');
export interface FeatureBuild { js: string; css: string; hash: string }

async function build(entry: string, stylesheet: string): Promise<FeatureBuild> {
  const result = await Bun.build({ entrypoints: [join(ROOT, entry)], target: 'browser', format: 'esm', minify: true });
  if (!result.success) throw new AggregateError(result.logs, `build of ${entry} failed`);
  if (result.outputs.length !== 1) throw new Error(`${entry} produced ${result.outputs.length} outputs`);
  const js = await result.outputs[0]!.text();
  const css = await buildCss(stylesheet);
  const hash = createHash('sha1').update(js).update(css).digest('hex').slice(0, 10);
  return { js, css, hash };
}

const builds = new Map<string, Promise<FeatureBuild>>();
function cached(entry: string, stylesheet: string): Promise<FeatureBuild> {
  let pending = builds.get(entry);
  if (!pending) {
    pending = build(entry, stylesheet);
    builds.set(entry, pending);
    const current = pending;
    pending.catch(() => { if (builds.get(entry) === current) builds.delete(entry); });
  }
  return pending;
}

export const pullsBuild = () => cached('src/client/pulls.ts', 'src/client/repository.css');
export const repositoryBuild = () => cached('src/client/repository.ts', 'src/client/repository.css');
export const markdownBuild = () => cached('src/client/markdown.ts', 'node_modules/github-markdown-css/github-markdown.css');
export const resetBuilds = () => builds.clear();
