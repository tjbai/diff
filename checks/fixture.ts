// A synthetic, deterministic big PR for the perf check: ~1,500 files and
// ~150k changed lines of code-shaped text in GitHub's usual mix (mostly small
// edits to source, some new files, a long tail of big ones, tests and docs
// that are hidden by default, a lockfile past the "Load diff" limit). Same
// seed, same bytes, so budgets measured on it are comparable run to run.

let seed = 0x9e3779b9;
function rand(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

const WORDS = ['turn', 'plan', 'thread', 'state', 'event', 'session', 'worker', 'queue', 'cache', 'route', 'token', 'model', 'result', 'config', 'handler', 'client', 'stream', 'batch', 'record', 'index', 'query', 'schema', 'span', 'retry', 'limit'];
const id = () => pick(WORDS) + pick(WORDS).replace(/^./, (c) => c.toUpperCase());
const words = (n: number) => Array.from({ length: n }, () => pick(WORDS)).join(' ');
const lit = () => pick([`'${pick(WORDS)}'`, String(int(0, 999)), 'null', 'true', 'undefined', `\`${words(2)} \${${id()}}\``]);

const TS = [
  () => `import { ${id()}, ${id()} } from '../${pick(WORDS)}/${pick(WORDS)}.ts';`,
  () => `export async function ${id()}(${id()}: ${pick(['string', 'number', 'Turn', 'Plan[]'])}): Promise<${pick(['void', 'Result', 'string'])}> {`,
  () => `  const ${id()} = await this.${id()}.${id()}(${id()}, { ${id()}: ${lit()} });`,
  () => `  if (!${id()}) return ${lit()};`,
  () => `  // ${words(int(4, 12))}`,
  () => `  for (const ${pick(WORDS)} of ${id()}) ${id()}.push(${pick(WORDS)}.${id()});`,
  () => `  return { ${id()}, ${id()}: ${lit()}, ${id()} };`,
  () => `}`,
  () => ``,
  () => `    ${id()}: ${lit()},`,
  () => `  throw new Error(\`${words(3)}: \${${id()}}\`);`,
];
const PY = [
  () => `from ${pick(WORDS)}.${pick(WORDS)} import ${id()}, ${id()}`,
  () => `async def ${pick(WORDS)}_${pick(WORDS)}(self, ${pick(WORDS)}: ${pick(['str', 'int', 'Turn', 'list[Plan]'])}) -> ${pick(['None', 'Result', 'str'])}:`,
  () => `    ${pick(WORDS)} = await self.${pick(WORDS)}.${pick(WORDS)}(${pick(WORDS)}, ${pick(WORDS)}=${int(0, 99)})`,
  () => `    if not ${pick(WORDS)}:`,
  () => `        return ${pick(['None', 'True', `"${pick(WORDS)}"`, String(int(0, 9))])}`,
  () => `    # ${words(int(4, 12))}`,
  () => `    """${words(int(3, 8))}."""`,
  () => ``,
  () => `    raise ValueError(f"${words(3)}: {${pick(WORDS)}}")`,
];
const MD = [() => `## ${words(3)}`, () => words(int(8, 24)), () => ``, () => `- ${words(int(3, 10))}`, () => '`' + id() + '` ' + words(5)];
const YAML = [() => `${pick(WORDS)}:`, () => `  ${pick(WORDS)}: ${int(0, 999)}`, () => `  - ${pick(WORDS)}-${int(0, 99)}`, () => `  ${pick(WORDS)}: "${words(2)}"`];
const JSONL = [() => `  "${pick(WORDS)}": ${int(0, 999)},`, () => `  "${id()}": "${words(2)}",`, () => `  "${pick(WORDS)}": [${int(0, 9)}, ${int(0, 9)}],`];

type Gen = (() => string)[];
const line = (g: Gen) => pick(g)();
/** A plausible edit of a line, so most change blocks get word highlights. */
const edit = (s: string, g: Gen) => (rand() < 0.7 && s.length > 8 ? s.replace(/[A-Za-z]{4,}/, id()) : line(g));

// Most files change a little; a long tail changes a lot.
const changed = () => (rand() < 0.03 ? int(800, 3000) : Math.floor(4 + 300 * rand() ** 4));

function modified(path: string, g: Gen, n: number): string {
  let out = `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n`;
  let o = int(1, 40);
  let nn = o;
  let left = n;
  while (left > 0) {
    const ctx = Array.from({ length: 3 }, () => line(g));
    const dels = Array.from({ length: Math.min(left, int(0, 12)) }, () => line(g));
    const adds = dels.map((d) => edit(d, g));
    const extra = int(0, Math.min(left, 20));
    for (let i = 0; i < extra; i++) adds.push(line(g));
    const post = Array.from({ length: 3 }, () => line(g));
    const body = [...ctx.map((l) => ` ${l}`), ...dels.map((l) => `-${l}`), ...adds.map((l) => `+${l}`), ...post.map((l) => ` ${l}`)];
    const oLen = ctx.length + dels.length + post.length;
    const nLen = ctx.length + adds.length + post.length;
    out += `@@ -${o},${oLen} +${nn},${nLen} @@ ${pick(['', `function ${id()}() {`, `class ${id()}:`])}\n${body.join('\n')}\n`;
    left -= Math.max(1, dels.length + adds.length);
    const gap = int(5, 120);
    o += oLen + gap;
    nn += nLen + gap;
  }
  return out;
}

function added(path: string, g: Gen, n: number): string {
  const lines = Array.from({ length: n }, () => `+${line(g)}`);
  return `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..3333333\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${n} @@\n${lines.join('\n')}\n`;
}

function deleted(path: string, g: Gen, n: number): string {
  const lines = Array.from({ length: n }, () => `-${line(g)}`);
  return `diff --git a/${path} b/${path}\ndeleted file mode 100644\nindex 4444444..0000000\n--- a/${path}\n+++ /dev/null\n@@ -1,${n} +0,0 @@\n${lines.join('\n')}\n`;
}

const renamed = (from: string, to: string) => `diff --git a/${from} b/${to}\nsimilarity index 100%\nrename from ${from}\nrename to ${to}\n`;

export interface Fixture {
  owner: string;
  repo: string;
  number: number;
  title: string;
  patch: string;
}

export function fixture(): Fixture {
  seed = 0x9e3779b9;
  const sections: string[] = [];
  const used = new Set<string>();
  const unique = (make: () => string) => {
    for (;;) {
      const p = make();
      if (!used.has(p)) return (used.add(p), p);
    }
  };
  const file = (path: string, g: Gen) => {
    const r = rand();
    const n = changed();
    sections.push(r < 0.7 ? modified(path, g, n) : r < 0.95 ? added(path, g, n) : deleted(path, g, Math.min(n, 400)));
  };
  const pkgs = ['core', 'chat', 'agent', 'tasks', 'api', 'web', 'ui', 'temporal', 'storage', 'auth'];
  for (let i = 0; i < 900; i++) file(unique(() => `packages/${pick(pkgs)}/src/${pick(WORDS)}/${pick(WORDS)}-${pick(WORDS)}.${pick(['ts', 'ts', 'tsx'])}`), TS);
  for (let i = 0; i < 250; i++) file(unique(() => `services/${pick(pkgs)}/${pick(WORDS)}/${pick(WORDS)}_${pick(WORDS)}.py`), PY);
  for (let i = 0; i < 200; i++) file(unique(() => `packages/${pick(pkgs)}/test/${pick(WORDS)}-${pick(WORDS)}.test.ts`), TS);
  for (let i = 0; i < 60; i++) file(unique(() => `docs/${pick(WORDS)}/${pick(WORDS)}-${pick(WORDS)}.md`), MD);
  for (let i = 0; i < 25; i++) file(unique(() => `config/${pick(WORDS)}/${pick(WORDS)}.yaml`), YAML);
  for (let i = 0; i < 15; i++) file(unique(() => `packages/${pick(pkgs)}/${pick(WORDS)}.json`), JSONL);
  for (let i = 0; i < 20; i++) {
    const to = unique(() => `packages/${pick(pkgs)}/src/moved/${pick(WORDS)}-${pick(WORDS)}.ts`);
    sections.push(renamed(to.replace('/moved/', '/old/'), to));
  }
  sections.push(added('pnpm-lock.yaml', YAML, 12000));
  return { owner: 'perf', repo: 'fixture', number: 1, title: 'synthetic: `plan_turn` mega-PR (perf fixture)', patch: sections.join('') };
}

/** Lines in a file whose median is `median`, with a long tail: lognormal, 90th
 *  percentile at 4.5× the median. */
const tail = (median: number, max: number) => {
  const z = Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  return Math.max(1, Math.min(max, Math.round(median * Math.exp(1.17 * z))));
};

/** Python with the odd line too long for the screen, so some rows wrap. */
const PY_LONG = [...PY, ...PY, ...PY, () => `    ${pick(WORDS)} = "${words(int(25, 45))}"`];

/** A feature torn out: ~500 files, 400 of them deleted whole (~67k lines,
 *  mostly Python and its tests, up to a 2,200-line one), the rest small
 *  edits that unhook it. Shaped after a real PR where boxes sized by guesswork made the page
 *  jump as files rendered above the screen. */
export function deletions(): Fixture {
  seed = 0x2545f491;
  const sections: string[] = [];
  const used = new Set<string>();
  const unique = (make: () => string) => {
    for (;;) {
      const p = make();
      if (!used.has(p)) return (used.add(p), p);
    }
  };
  const dirs = ['wiki', 'wiki/gen', 'wiki/gen/adapters', 'wiki/runs', 'wiki/store', 'wiki/sandbox', 'wiki/eval'];
  const gone = (ext: string) => unique(() => `services/delivery/${pick(dirs)}/${pick(WORDS)}_${pick(WORDS)}.${ext}`);
  sections.push(deleted(gone('py'), PY_LONG, 2205));
  for (let i = 0; i < 240; i++) sections.push(deleted(gone('py'), PY_LONG, tail(85, 1500)));
  for (let i = 0; i < 60; i++) sections.push(deleted(unique(() => `services/delivery/tests/wiki/test_${pick(WORDS)}_${pick(WORDS)}.py`), PY_LONG, tail(85, 1500)));
  for (let i = 0; i < 40; i++) sections.push(deleted(gone('md'), MD, tail(85, 800)));
  for (let i = 0; i < 40; i++) sections.push(deleted(gone('yaml'), YAML, tail(85, 800)));
  for (let i = 0; i < 31; i++) sections.push(deleted(gone('json'), JSONL, tail(85, 800)));
  const pkgs = ['api', 'web', 'temporal', 'infra', 'tasks'];
  for (let i = 0; i < 30; i++) sections.push(modified(unique(() => `services/${pick(pkgs)}/${pick(WORDS)}/${pick(WORDS)}_${pick(WORDS)}.py`), PY_LONG, tail(5, 260)));
  for (let i = 0; i < 30; i++) sections.push(modified(unique(() => `docs/${pick(WORDS)}/${pick(WORDS)}-${pick(WORDS)}.md`), MD, tail(5, 260)));
  for (let i = 0; i < 20; i++) sections.push(modified(unique(() => `packages/${pick(pkgs)}/src/${pick(WORDS)}-${pick(WORDS)}.ts`), TS, tail(5, 260)));
  for (let i = 0; i < 14; i++) sections.push(modified(unique(() => `infra/${pick(pkgs)}/${pick(WORDS)}.yaml`), YAML, tail(5, 260)));
  return { owner: 'perf', repo: 'deletions', number: 1, title: 'synthetic: delete `delivery_wiki` (perf fixture)', patch: sections.join('') };
}

export const FIXTURES: Record<string, () => Fixture> = { mega: fixture, deletions };
