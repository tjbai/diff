<img src="src/logo.svg" width="48" alt="">

# diff

a local, private, very fast github "files changed" view. point it at any PR, including private ones. the diff is computed with local git, not fetched from github, so PR size is only limited by your machine.

it's for reading and approving. comments, threads, and CI annotations stay on github.

```sh
diff https://github.com/owner/repo/pull/123
diff owner/repo#123
diff owner/repo#123 --no-open   # print the url instead of opening it
diff --restart                  # restart the background server
diff --stop
```

it shadows `/usr/bin/diff` through a tiny shim in `~/.local/bin/diff` — anything that isn't a PR ref or one of the flags above just falls through to the real diff, so `diff a b` still works.

needs `bun`, `git`, and `gh` (logged in). auth is just `gh auth token`, so whatever you can see on github, this can see.

## why

github's diff viewer is slow on big PRs and doesn't let you hide the stuff you don't care about. geld (the browser extension) fixes the second part but still sits on top of github's page. i wanted the github UI 1:1 minus the extra buttons, with geld-style hiding baked in — and "hidden" meaning actually gone, sidebar included.

## how it works

it keeps a blobless bare clone per repo in `~/.cache/prv/<owner>/<repo>.git`. on load it fetches the PR head and base, takes the merge base, and runs `git diff -M` locally — no diff API. the patch gets split per file and classified with geld's catalog (ported verbatim from geld 0.1.2). results are cached by `<merge-base>..<head>`, so an unchanged head is basically free.

a background server on `127.0.0.1:7717` (or `PRV_PORT`) serves the page. the page paints from cache immediately, then refreshes in the background, so a reload is a refresh. it renders github's own diff markup with primer styling, shiki runs in a worker, and file bodies only render near the viewport.

from ~200 loads of a large private monorepo: first paint ~110ms median from cache, ~1.5s on a new head (mostly github's API and the fetch; `git diff` on a 1,383-file PR is ~0.1s), and longer the very first time, for the clone. the server idles at ~60MB and no CPU.

## hiding

hidden files disappear from the tree and the diff list, and folders that end up empty go with them.

the eye button next to "filter files…" is one checklist w/ counts:

- manual: files you hid with the eye button on a file header, or `h` (`h` again on one brings it back). saved per PR. uncheck it to see them all again.
- geld's categories. tests, agent config, and docs are hidden by default.

the checklist itself is a global setting.

the header diffstat only counts visible files. hover it for totals and what's hidden.

## reviewed

the reviewed checkbox on a file header, or `v`, marks a file done and collapses it. its tree row fades out, and a folder collapses once everything in it is reviewed. clicking a reviewed file in the tree opens it, and it collapses again once you move on to another file. the approve button tracks progress: it fills green as you go and turns solid once every shown file is reviewed. marks are keyed by a hash of that file's diff, so if a refresh changes the file, the mark clears and you look at it again.

## approve

approve is the one primary button, and it doubles as review progress. it approves at the commit on screen, so a push that lands while you review isn't approved unseen, and it turns into "approved" until a new head comes in. on your own PRs, closed ones, and exports it's just the progress.

## export

export (in the gear menu) writes one self-contained `.html` w/ your hides baked in (hidden files' contents are left out). reviewed marks deliberately don't carry over — whoever opens it gets a clean slate to click through, and their own marks persist in their browser. no install, no network, no github access. hunk expansion and refresh are off in an export. you can also drop an export onto a live page.

## keys

`j` / `k` next / prev file · `h` hide · `v` reviewed

## firefox extension

`extension/` sends github's "files changed" tab here: clicking it, or opening a `…/pull/N/files` link from anywhere, lands on `127.0.0.1:7717` instead. if the server isn't running, github loads as usual. the toolbar button turns it off and on. links to a single commit's diff stay on github.

release firefox only keeps signed extensions, so sign it once as unlisted (free, automatic, not published) with an [AMO API key](https://addons.mozilla.org/developers/addon/api/key/):

```sh
WEB_EXT_API_KEY=… WEB_EXT_API_SECRET=… bunx web-ext sign -s extension --channel unlisted
```

then open the `.xpi` from `web-ext-artifacts/` in firefox. bump `version` in the manifest before signing again. for a quick try, `about:debugging` → load temporary add-on → `extension/manifest.json` (gone on restart).

## develop

```sh
bun install
bun run check     # types, tests, then the bundle and perf budgets
```

`checks/budget.json` holds hard budgets, and they only go down. `checks/bundle.ts` checks the size of the app, the worker, and the stylesheet. `checks/perf.ts` serves a synthetic 1,471-file PR (`checks/fixture.ts`, same bytes every run) on its own port and cache, drives headless Firefox through first load, scrolling, a scrollbar drag, `j`, tree jumps, reviewing, category toggles, the tree filter, and unified → split, and compares the median of 5 runs. Timings come from Event Timing (input → next paint) and a frame recorder (time past 50 ms per frame). `layout.shifts` counts frames where code on screen moved because something above it changed height: a file that held the wrong room before it rendered. A second fixture, `--fixture deletions`, is a 506-file PR that deletes a feature (412 whole files, up to 2,205 lines each), where that shows most; it has its own budgets. If one trips, make it faster; don't raise the number. When a change makes things faster, `bun run ratchet` lowers the budgets to the new numbers plus headroom.

`bun checks/perf.ts owner/repo#N` runs the same scenarios against a real PR from `~/.cache/prv` (open it with `diff` once first) and only reports. The first run needs Firefox for Playwright: `bunx playwright-core install firefox`.
