# erome-userscript

Display the duration of each video above the video in erome.com albums, and
continuously register every clip into a local, structured registry.

This program is dual licensed under:
*  The Unlicense
*  GPL-3.0-or-later

## Features

**Carried over from v1.0**

* Duration label rendered above each video.
* "Minimal length" slider that hides clips shorter than a chosen runtime.
* "only videos" navbar toggle (left-click to filter, right-click to disable),
  persisted through the URL hash as `#onlyvideos=N`.

**New in v1.1 — continuous clip registration**

* Clips are registered as they appear, indefinitely, rather than in a single
  pass at load. One `MutationObserver` drives it.
* **Movies** — each album is a "movie": its clips are aggregated into a record
  holding clip count, total runtime, and whether any clip is 4K. On listing
  pages every album card is grouped separately.
* **Usernames** — uploaders are tracked across albums with clip counts, album
  counts, 4K counts and first/last seen.
* **4K detection** — resolution is read from the `<video>` element's own media
  metadata (`videoWidth`/`videoHeight`), so it costs no network. Clips at or
  above ~8.29 megapixels (3840x2160 UHD and 4096x2160 DCI both qualify) get a
  `4K` badge.
* **Canonical payload schema** — every record is normalized to one fixed shape
  before it is written, so no consumer has to guess a field's type. Absent
  numeric fields normalize to `null`, never `0`.
* **Written exactly once** — element-level dedupe plus merge-on-update means a
  re-scan never clones a row or a DOM node. Merging never clobbers data an
  earlier pass already learned.
* **DOM only** — the registry never crawls album pages, paginates, or makes its
  own requests.

## One brand

Every storage key, DOM marker attribute, CSS class and window global is derived
from a single constant:

```js
const BRAND = 'erome-clip-registry';
```

localStorage keys are namespaced as `erome-clip-registry:<table>#<key>` across
four tables — `clips`, `movies`, `users`, `meta`. Everything this script adds to
the page carries a `data-erome-clip-registry` attribute, which is also how the
observer distinguishes its own decorations from real page changes (without that
guard it would react to itself forever).

The UserScript `@namespace` and `@name` are deliberately unchanged: managers
identify an installed script by namespace + name, so rebranding them would fork
every existing install into a second copy.

## Control surface

```js
EroClipRegistry.status()      // active, paused, observing, counts, stats, uptime
EroClipRegistry.start()       // (re)attach the observer and rescan
EroClipRegistry.stop()        // full teardown: observer, frame, queue, timer
EroClipRegistry.pause()       // keep the observer, ignore callbacks
EroClipRegistry.resume()      // resume and catch up on what was missed
EroClipRegistry.rescan(root)  // re-walk a subtree (idempotent)
EroClipRegistry.reattach()    // force the observer onto the current root
EroClipRegistry.healthCheck() // reattach + rescan if the root was detached

EroClipRegistry.clips()       // all clip records
EroClipRegistry.movies()      // all album aggregates
EroClipRegistry.users()       // all tracked usernames
EroClipRegistry.clip(url)     // one record by clip URL
EroClipRegistry.export()      // the whole registry as JSON
EroClipRegistry.prune()       // enforce the row cap, reap orphaned aggregates
EroClipRegistry.clear(table)  // drop one table, or all three
```

## Observer lifecycle

* Observes `document.documentElement`, not `<body>`, so client-side rendering
  that swaps the body cannot orphan it.
* Mutations are coalesced into one `requestAnimationFrame` flush.
* Nodes torn down before their flush lands are counted as dropped work
  (`status().droppedNodes`) instead of being registered.
* If the observed root is ever detached, no mutation can fire on it again, so
  the flush-time reattach check would never be reached. A 2-second health check
  is the backstop for that case; it is cleared by `stop()`, so nothing keeps
  running after teardown.
* `pagehide` triggers a full teardown.

## Storage

Backed by `localStorage`, capped at 2000 clip rows with least-recently-seen
eviction. Orphaned `movies`/`users` aggregates whose clips are all gone are
reaped on prune. If storage is unavailable (private mode) or full (quota
exceeded), the store degrades to an in-memory `Map` for the session;
`status().storage` reports which is live.

v1.0 cached bare durations as `$vl#<url>`. Those are cloned into full clip
records exactly once on first run, then deleted, leaving one source of truth per
clip. `meta.legacyMigrated` records that this happened.

## Network

The only request is v1.0's WebM header probe: a `Range: bytes=0-140` fetch that
reads the duration out of the container header. It is now a **last resort** —
duration and resolution are taken from the element's media metadata first, and
from the registry cache before that. The probe is unchanged from v1.0.

### Known upstream quirk

The probe locates the duration with `/\x03.*\xe8/`. That `.*` is greedy, so when
a duration's own big-endian bytes happen to contain `0xE8`, the match extends
into them and the parsed value is wrong (e.g. 1000 ms = `00 00 03 E8`). This is
inherited from v1.0 and was left as-is: fixing it properly means real EBML
variable-length-integer parsing, which cannot be validated without access to
live erome media.

## Tests

The suite runs the real userscript against a simulated erome page in jsdom —
141 assertions across 13 sections covering initial registration, movie and
username aggregation, idempotency, continuous registration of later clips,
pause/resume/stop, 4K detection without network, legacy migration, payload
schema, pruning and orphan reaping, listing-page grouping, preserved v1.0
features, body replacement, reattach and health check, source shapes
(direct `video[src]`, `blob:`/`data:` skipped), and long-run stability over 40
sequential additions.

## Privacy

Everything is stored locally in your browser. Nothing is uploaded anywhere.
