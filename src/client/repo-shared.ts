// Helpers shared by the repository pages (Code, Pull requests), not the PR app.
import { h } from './dom.ts';

export const ic = (name: string) => h('span', { class: `octicon octicon-${name}`, 'aria-hidden': true });
export const message = (text: string) => h('div', { class: 'repo-message', role: 'status' }, text);

export function failure(container: HTMLElement, error: unknown) {
  container.replaceChildren(h('div', { class: 'flash flash-error', role: 'alert' }, error instanceof Error ? error.message : String(error)));
}

/** GitHub's relative-time wording: "15 hours ago", "yesterday", "last month". */
export function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  const ago = (n: number, unit: string) => n === 1 ? (unit === 'day' ? 'yesterday' : `last ${unit}`) : `${n} ${unit}s ago`;
  if (s < 60) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const hours = Math.floor(m / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const d = Math.floor(hours / 24);
  if (d < 7) return ago(d, 'day');
  if (d < 30) return ago(Math.floor(d / 7), 'week');
  if (d < 365) return ago(Math.floor(d / 30.44), 'month');
  return ago(Math.floor(d / 365.25), 'year');
}

export function timeEl(iso: string) {
  return h('time', { datetime: iso, title: new Date(iso).toLocaleString() }, timeAgo(iso));
}
