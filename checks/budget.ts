// checks/budget.json: the ratchet both gates read and tighten. A number only
// ever goes down: `--ratchet` lowers each budget to the measurement plus
// headroom when that is below it, and never raises one. Timings are medians
// from this machine (an M-series Mac); bytes and counts are exact.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Metrics = Record<string, number>;
export interface Budget {
  bundle: Metrics;
  /** The mega fixture's; the others' are under `perf <fixture>`. */
  perf: Metrics;
  [section: string]: Metrics;
}

export const BUDGET_FILE = join(import.meta.dir, 'budget.json');

export const readBudget = (): Budget => JSON.parse(readFileSync(BUDGET_FILE, 'utf8')) as Budget;
export const writeBudget = (b: Budget) => writeFileSync(BUDGET_FILE, `${JSON.stringify(b, null, 2)}\n`);

/** The budget a fresh measurement earns: timings get room for run-to-run noise, sizes get 1%. */
function headroom(key: string, v: number): number {
  if (key.endsWith(' ms')) return Math.ceil((v * 1.25 + 10) / 5) * 5;
  if (key.endsWith(' %')) return v + 2;
  return Math.ceil((v * 1.01) / 100) * 100;
}

export function ratchet(measured: Metrics, old: Metrics = {}): Metrics {
  const out: Metrics = {};
  for (const [k, v] of Object.entries(measured)) out[k] = Math.min(old[k] ?? Infinity, headroom(k, v));
  return out;
}

/** Print each metric against its budget; returns the number over budget (or without one). */
export function report(label: string, measured: Metrics, budget: Metrics = {}): number {
  let failures = 0;
  for (const [k, v] of Object.entries(measured)) {
    const max = budget[k];
    const ok = max !== undefined && v <= max;
    if (!ok) failures++;
    const line = `${ok ? '✓' : '✗'} ${label} ${k.padEnd(26)} ${String(v).padStart(8)}  ${max === undefined ? '(no budget)' : `budget ${max}`}`;
    (ok ? console.log : console.error)(line);
  }
  return failures;
}
