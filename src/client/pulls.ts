import { h } from './dom.ts';
import { failure, ic, message, timeEl } from './repo-shared.ts';
import type { RepoPull, RepoPulls } from '../repository-types.ts';

const boot = (window as unknown as { __pullsBoot: { owner: string; repo: string; pulls: Promise<RepoPulls> } }).__pullsBoot;
const repo = `${boot.owner}/${boot.repo}`;
const base = `/${repo}`;
const STATE_ICON: Record<RepoPull['state'], string> = { open: 'git-pull-request', draft: 'git-pull-request-draft', merged: 'git-merge', closed: 'git-pull-request-closed' };

const input = h('input', { class: 'form-control pulls-search', type: 'search', placeholder: 'Search pull requests', 'aria-label': 'Search pull requests', autocomplete: 'off' });
const openTab = h('a', { class: 'pulls-state' }, 'Open', h('span', { class: 'Counter' }));
const closedTab = h('a', { class: 'pulls-state' }, 'Closed', h('span', { class: 'Counter' }));
const list = h('div', { class: 'pulls-list', role: 'list' });
const pager = h('nav', { class: 'pulls-pager', 'aria-label': 'Pagination' });
document.getElementById('app')!.append(h('div', { class: 'pulls' },
  h('div', { class: 'pulls-filter' }, ic('search'), input),
  h('div', { class: 'Box' }, h('div', { class: 'Box-header pulls-states' }, openTab, closedTab), list, pager)));

let seq = 0;
let rows: { row: HTMLElement; text: string }[] = [];

function row(pull: RepoPull) {
  // GitHub: "#12 opened 2 days ago by alice" / "#11 by alice was merged 3 days ago".
  const active = pull.state === 'open' || pull.state === 'draft';
  const meta = active ? [`#${pull.number} opened `, timeEl(pull.at), ` by ${pull.author}`]
    : [`#${pull.number} by ${pull.author} was ${pull.state} `, timeEl(pull.at)];
  return h('div', { class: 'pulls-row', role: 'listitem' },
    h('span', { class: `pulls-icon pulls-icon--${pull.state}`, title: pull.state === 'draft' ? 'Draft' : pull.state[0]!.toUpperCase() + pull.state.slice(1) }, ic(STATE_ICON[pull.state])),
    h('div', { class: 'pulls-text' },
      h('a', { class: 'pulls-title', href: `${base}/pull/${pull.number}` }, pull.title),
      h('div', { class: 'pulls-meta' }, ...meta)));
}

function filter() {
  const q = input.value.trim().toLowerCase();
  let shown = 0;
  for (const { row, text } of rows) { const hit = !q || text.includes(q); row.hidden = !hit; shown += Number(hit); }
  list.querySelector('.pulls-empty')?.remove();
  if (!shown && rows.length) list.append(h('div', { class: 'pulls-empty repo-message' }, 'No pull requests on this page match.'));
}

function paint(page: RepoPulls, state: string, after: string) {
  const open = state !== 'closed';
  openTab.lastElementChild!.textContent = page.open.toLocaleString();
  closedTab.lastElementChild!.textContent = page.closed.toLocaleString();
  openTab.href = `${base}/pulls`; closedTab.href = `${base}/pulls?state=closed`;
  openTab.classList.toggle('is-selected', open); closedTab.classList.toggle('is-selected', !open);
  document.title = `${open ? 'Pull requests' : 'Closed pull requests'} · ${repo}`;
  rows = page.pulls.map((pull) => ({ row: row(pull), text: `${pull.title} #${pull.number} ${pull.author}`.toLowerCase() }));
  list.replaceChildren(...rows.map((r) => r.row));
  if (!page.pulls.length) list.append(message(open ? 'There aren’t any open pull requests.' : 'There aren’t any closed pull requests.'));
  filter();
  pager.replaceChildren();
  if (!after && !page.more) return;
  const previous = h('button', { class: 'btn-link pulls-page', type: 'button', disabled: !after }, 'Previous');
  previous.onclick = () => history.back();
  const next = h('button', { class: 'btn-link pulls-page', type: 'button', disabled: !page.more }, 'Next');
  next.onclick = () => { history.pushState(null, '', `${base}/pulls?${new URLSearchParams({ ...(open ? {} : { state: 'closed' }), after: page.cursor! })}`); void load(); };
  pager.append(previous, next);
}

async function load(initial = false) {
  const id = ++seq;
  const q = new URLSearchParams(location.search);
  const state = q.get('state') === 'closed' ? 'closed' : 'open';
  const after = q.get('after') ?? '';
  pager.replaceChildren();
  list.replaceChildren(message('Loading pull requests…'));
  try {
    const page = initial ? await boot.pulls : await (await fetch(`/api/repo/${repo}/pulls?${new URLSearchParams({ state, after })}`)).json().then((body: RepoPulls & { error?: string }) => {
      if (body.error) throw new Error(body.error);
      return body;
    });
    if (id !== seq) return;
    paint(page, state, after);
    window.scrollTo({ top: 0 });
  } catch (e) { if (id === seq) failure(list, e); }
}

for (const tab of [openTab, closedTab]) tab.addEventListener('click', (e) => {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  history.pushState(null, '', tab.href);
  void load();
});
input.oninput = filter;
input.onkeydown = (e) => {
  if (e.key !== 'Enter') return;
  const n = /^(?:#|(?:https?:\/\/github\.com\/)?[\w.-]+\/[\w.-]+\/pull\/)?(\d+)(?:\/.*)?$/.exec(input.value.trim())?.[1];
  if (n) location.assign(`${base}/pull/${n}`);
};
window.addEventListener('popstate', () => void load());
void load(true);
