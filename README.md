# erome-userscript

A userscript for [erome.com](https://www.erome.com): shows the duration of every video
next to it, hides videos shorter than a length you choose, and can reduce album pages
to videos only.

## Install

1. Install a userscript manager ([Tampermonkey](https://www.tampermonkey.net/),
   [Violentmonkey](https://violentmonkey.github.io/), or Greasemonkey).
2. Open [`erome.user.js`](erome.user.js) and install it, or paste the file into a new script.
3. Visit any erome album or listing page.

## What it does

* **Durations** — reads the container metadata directly (WebM/Matroska `Duration`,
  MP4/M4V `mvhd`) and prints `m:ss` / `h:mm:ss` above each player. Only the first
  256 KB of the file is requested; MP4 files that keep `moov` at the end fall back to
  a 512 KB tail request.
* **Minimum length slider** — hides videos shorter than the selected length. Set it
  to *Off* to show everything again. The choice is remembered.
* **only videos** — a navbar entry that hides albums (on listing pages) or media
  groups (inside albums) that contain no video. Left click raises the threshold,
  right click turns it off, and the level is stored in `#onlyvideos=N` so a link
  can carry it.
* **Load pass** — the page is scanned again on a self-scheduling loop: every 4 s
  while new players keep showing up, backing off to at most once a minute once it
  is stable, and paused while the tab is hidden.
* **Budgeted probing** — three probes run at a time through a queue with duplicate
  collapsing, so two hundred players on one page are resolved steadily instead of
  firing two hundred requests at once. Throttling (`429`/`408`), timeouts and
  network errors retry up to three times with capped exponential backoff
  (0.75 s → 8 s, jittered); `403`/`404` and oversized bodies fail immediately
  instead of hammering a file that will not answer.
* **Status line** — the panel shows how many durations are loaded, still loading,
  or unavailable, so a slow file never looks like a dead script.
* **Caching** — resolved durations are cached in `localStorage` for 30 days
  (500 entries, oldest evicted first) so revisiting a page does not re-probe files.

## Privacy

This script adds no third-party requests and sends nothing anywhere. Two options
exist for people who want less local state:

* **Global Privacy Control is honoured, not just offered.** If the browser reports
  the signal (`navigator.globalPrivacyControl === true`), caching is forced off for
  that page load, `Sec-GPC: 1` and `DNT: 1` go out on every probe, the panel shows
  `GPC`, and the private-mode menu entry refuses to turn caching back on. Existing
  cache entries are left untouched — they are simply not read.
* **Private mode** (userscript menu → *Private mode*) stops writing durations to
  storage and clears what is already cached, so nothing media-derived is kept
  between visits. Filter preferences are still remembered; they contain no
  information about the files you viewed. A GPC signal takes precedence over this
  menu entry.

Note that a page script cannot change what other parties do; it can only state a
preference and avoid storing data itself.

## Behaviour notes

* If a file cannot be read (network error, unusual container, 403), no duration is
  shown and the page is left untouched. Parsing never throws.
* Browsers may refuse `Range` requests on some CDNs; the script then falls back to
  the normal response (capped at 8 MB by aborting oversized downloads).
* Private browsing or blocked storage degrades to an in-memory cache.
* In Tampermonkey 5+ with MV3, enable *Allow User Scripts* and check that
  `GM.xmlHttpRequest` is granted, otherwise no file can be probed.

## Changes in 2.3

* `scripts/lib.sh` — shared helpers with the safety rules enforced in code:
  `safe_rm` refuses empty paths, `/`, `.`, `..`, `~`, `$HOME`, globs,
  unexpanded variables, relative paths and anything outside its allowed root;
  `run_parallel` runs independent steps concurrently in separate bash
  processes and still reports every result.
* `scripts/lint-shell.sh` — the three classic footguns are now a failed build
  rather than a comment: unquoted expansions that word-split, `rm` with a
  variable target (or without `--`), `set -e` without `pipefail`, plus
  backticks and `eval`. Heredoc bodies are skipped, so embedded JS is not
  judged as shell.
* `check.sh all` runs syntax, metadata, lint and tests in parallel — four
  isolated processes, roughly the time of the slowest one. `RUN_JOBS=1`
  serialises.
* The gate is read-only and idempotent, verified by a test that runs it four
  times concurrently and checks `git status` is unchanged.

## Changes in 2.2

* Honours the Global Privacy Control signal (`navigator.globalPrivacyControl`):
  forced no-cache, GPC headers on every probe, a `GPC` marker in the panel, and a
  menu entry that refuses to override it.
* `scripts/check.sh` — one bash entry point for syntax, metadata, tests and repo
  hygiene, usable as a pre-commit or CI gate (`npm run verify`).

## Changes in 2.1

* Adds the recurring load pass with adaptive pacing (4 s → 60 s, paused when the
  tab is hidden) and a bounded retry queue (concurrency 3, three attempts,
  jittered backoff) instead of one burst of unbounded requests.
* Probe failures are classified: rate limits and timeouts retry, missing files do
  not.
* New status line in the panel; failed probes are logged once, not per frame.

## Changes in 2.0

* Reads durations from container metadata (WebM/Matroska and MP4/M4V) instead of
  scraping a byte pattern, so files with unusual headers no longer show wrong
  times or crash the page.
* Caches under a new prefix (`$vl2#`, 30-day TTL, bounded to 500 entries) with
  corrupt-entry and quota handling; entries written by 1.0 are simply ignored.
* Panel, slider, anchors and the *only videos* entry are injected as DOM nodes
  with `textContent` (no `innerHTML`), tolerate re-render and lazy loading, and
  never throw into the page.
* Filter is only offered when a page actually has more than one video, and the
  *only videos* level is shown in its label so the state is visible.

## Development

No dependencies, no build step. Bash and Node 18+ are enough:

```sh
npm test                       # 89 tests: parsers, cache, queue, GPC, boot path, shell
npm run verify                 # bash gate: syntax + metadata + lint + tests + hygiene
npm run lint:sh                # shell footguns only
npm run check                  # syntax only (fast)
```

Tests build real WebM and MP4 byte fixtures, so the parsers are exercised against
actual container layouts rather than mocks, and drive the probe queue with stub
timers to check concurrency, backoff and give-up behaviour. `test/boot.test.js` runs the real
`boot()` against a small DOM stub to cover anchors, filtering, the slider and the
navbar integration.

Layout:

```
erome.user.js          the userscript (pure helpers + DOM wiring)
scripts/check.sh       bash gate: syntax, metadata, lint, tests, hygiene
scripts/lib.sh         strict mode, safe_rm, run_parallel, mktemp_dir
scripts/lint-shell.sh  static checks for the shell scripts
test/core.test.js      parsers, hash state, cache, queue, GPC, request flow
test/boot.test.js      DOM-level integration through a stub
test/bash.test.js      safe_rm refusals, real concurrency, lint rules, gate idempotency
```

`scripts/check.sh` takes a step name: `syntax`, `meta`, `lint`, `test`,
`hygiene`, or `all` (default). In `all` the independent steps run concurrently,
each in its own bash process; `RUN_JOBS` caps how many at once. It exits
non-zero if any step failed, after letting every step finish, so it works as a
git hook or CI step without any extra tooling:

```sh
ln -sf ../../scripts/check.sh .git/hooks/pre-commit
```

## License

This program is dual licensed under:

* The Unlicense
* GPL-3.0-or-later
