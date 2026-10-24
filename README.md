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

* The `Sec-GPC: 1` and `DNT: 1` headers are attached to every media probe in
  private mode, signalling Global Privacy Control to the origin server.
* **Private mode** (userscript menu → *Private mode*) stops writing durations to
  storage and clears what is already cached, so nothing media-derived is kept
  between visits. Filter preferences are still remembered; they contain no
  information about the files you viewed.

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

No dependencies, no build step. Node 18+ is enough for the test suite:

```sh
npm test                       # 48 tests: parsers, cache, queue, network flow, boot path
npm run check                  # syntax check for the script and tests
```

Tests build real WebM and MP4 byte fixtures, so the parsers are exercised against
actual container layouts rather than mocks, and drive the probe queue with stub
timers to check concurrency, backoff and give-up behaviour. `test/boot.test.js` runs the real
`boot()` against a small DOM stub to cover anchors, filtering, the slider and the
navbar integration.

Layout:

```
erome.user.js          the userscript (pure helpers + DOM wiring)
test/core.test.js      parsers, hash state, cache, queue, GM request flow
test/boot.test.js      DOM-level integration through a stub
```

## License

This program is dual licensed under:

* The Unlicense
* GPL-3.0-or-later
