# GENESIS_API — Input & Output Contract (v1 draft)

**Status:** specification only — no implementation in this commit.
**Scope:** `www.erome.com` only. One facade over erome's many endpoints, living inside the userscript world (`GM.xmlHttpRequest`), consumed by the frontend.
**License:** inherits the repo dual license (Unlicense / GPL-3.0-or-later).

---

## 0. Reading of the request

| Your words | Contract decision |
|---|---|
| "frontend input … always receiving anything and everything" | `GENESIS_API.*` accepts **any** input type — URL, bare id, username, search phrase, batch paste, DOM node, transport response, structured descriptor, unknown blob — and **never throws**. |
| "endpoint output" | Every operation returns **one envelope**, identical in shape, regardless of which erome endpoint served it. |
| "that is common everywhere" | The set of input shapes and item fields that erome tooling everywhere has to handle (album / profile / search / listing / CDN media / paginated pages) is enumerated in one place. |
| "is now going to be for me as well" | Identity-aware: the same routes accept `self: true`, run with the logged-in session, and partition cache per identity. |
| "Multiple endpoints that become GENESIS_API" | Route table (§4): N erome endpoints → 1 namespace, N input kinds → 1 envelope. Callers stop knowing endpoint URLs. |

---

## 1. Design invariants

1. **Never throw.** Every call resolves to an envelope with `ok`, `errors[]`, `warnings[]`. A programming mistake inside a consumer yields `ok:false`, not an exception.
2. **Never reject input.** Unknown or ambiguous input is *classified*, not refused: `kind:"unknown"` + `data.raw` passthrough + `W_UNRESOLVED` warning.
3. **One envelope shape.** `album()`, `search()`, `media()`, `batch()` and even `raw()` return the same object skeleton. Consumers write one renderer.
4. **Route is reported, never required.** Callers pass intent or a hint; the facade chooses the endpoint and discloses it in `route.endpoint`.
5. **Additive-only schema.** Unknown upstream fields land in `item.extra` and `meta.schemaDrift`; they are never dropped and never fatal. `schemaVersion` bumps only on removals (which are forbidden in v1).
6. **Binary stays out of the envelope.** Bytes are referenced by handle (§6.3); the envelope stays JSON-serializable at all times.

---

## 2. Namespace

```js
// In the userscript (page context)
const GENESIS_API = window.__GENESIS = { /* … */ };
```

* Module id: `genesis/1` (string carried in every envelope).
* Global name `GENESIS_API` is the public contract name; `window.__GENESIS` is the short alias used in console probes.
* No build step, no dependencies — same rules as the existing `erome.user.js`.

---

## 3. Input contract — "anything and everything"

### 3.1 Accepted input union

`GenesisInput = Scalar | DOM | Transport | Structured | Passthrough | GenesisInput[]`

| Family | Member | Handled as |
|---|---|---|
| **Scalar** | `"https://www.erome.com/a/XXXXXXXX"` | album |
| | `"www.erome.com/USERNAME"`, `"USERNAME"`, `"@USERNAME"` | user |
| | `"https://www.erome.com/search?q=phrase&o=new&page=2"`, `"phrase with spaces"`, `"#tag"` | search |
| | `"https://www.erome.com/explore"` | explore |
| | `"https://www.erome.com/"` | feed (home) |
| | `"https://v12.erome.com/…/x_720p.mp4"`, any `v*/s*.erome.com` asset | media |
| | `"XXXXXXXX"` (bare 6–12 char token) | **ambiguous** album-or-user (see §3.3) |
| | any other absolute URL | external — classified, never fetched without `force` |
| | multi-line paste | batch (split on newline / comma / whitespace-only blank lines) |
| **DOM** | `HTMLAnchorElement` | its `href`, re-classified |
| | `HTMLVideoElement` / `HTMLSourceElement` / `HTMLImageElement` | `currentSrc \|\| src`, re-classified |
| | `HTMLFormElement` | `action`, plus serialized fields as hints |
| | any other `Element` | `dom` — `dataset`, `className`, `textContent` sniffed for the fields of §5.2 |
| | `Document` | every album/media candidate on the page, as a batch |
| **Transport** | `Response`, `XMLHttpRequest`, GM `xhr` response object | parsed by content-type: json → structured, html → dom, else text |
| | `Blob` / `File` / `ArrayBuffer` | `payload` handle, not parsed |
| **Structured** | `{ url }`, `{ href }`, `{ album }`, `{ albumId }`, `{ user }`, `{ username }`, `{ q }`, `{ query }`, `{ tag }`, `{ media }`, `{ src }`, `{ id }`, `{ path }` | the named route |
| | `{ items: [...] }` or `{ input: … }` | recursive batch |
| | object with none of the above keys | passthrough → `kind:"unknown"`, `data.raw` intact |
| **Passthrough** | `null`, `undefined`, `""`, `NaN`, `0`, `false` | `kind:"empty"` — `ok:true`, no-op, no fetch |
| | functions | called once, result re-classified (lazy producers stay lazy) |
| **Batch** | `GenesisInput[]` | fan-out, aggregated envelope (§4.3) |

### 3.2 Hints (never required)

```js
GENESIS_API.album(input, {
  as:      "album" | "user" | "search" | "explore" | "feed" | "media" | "raw" | "auto", // default "auto"
  page:    2,                 // listing pagination (see §4.2)
  order:   "hot" | "new",     // search only, maps to o=new
  t:       "posts",           // profile tab, maps to t=… (see §7.3)
  self:    true,              // run in "for me" scope (own session), §7
  raw:     false,             // include upstream body in envelope.data.raw
  cache:   { ttl: 300000 } | false,
  probe:   "duration",        // media: sniff duration (existing Range trick), §6.2
  signal:  AbortSignal,
  timeout: 15000,
  strict:  false              // disable passthrough fallback; unknown ⇒ ok:false
});
```

### 3.3 Classification algorithm

Ordered, first match wins, deterministic, pure (no network):

```
1  null/empty/NaN/false/0            → empty
2  function                          → call, re-classify result
3  DOM Element                       → extract → re-classify extracted scalar
4  Response / XHR / GM response      → parse by content-type → re-classify
5  Blob / File / ArrayBuffer         → payload
6  Array                             → batch
7  Object                            → named keys (§3.1) | items/input → batch | else passthrough
8  String:
   8.1  multi-line / comma-list     → batch (classify each line)
   8.2  /^#(.+)$/                   → search (tag)
   8.3  erome album URL             → album    (id = \w+ after /a/)
   8.4  erome /search?…             → search   (q, o, page parsed)
   8.5  erome /explore              → explore
   8.6  erome media host v*/s*      → media
   8.7  erome root "/"              → feed
   8.8  other erome.com path        → user     (path segment = username)
   8.9  bare token /^\w{6,12}$/     → ambiguous → route probe (§3.4)
   8.10 /^@?[\w.\-]{3,}$/           → user
   8.11 contains whitespace         → search
   8.12 other absolute URL          → external (no fetch unless force)
   8.13 anything else               → unknown (passthrough)
```

Every classification emits `input.classifiedAs`, `input.confidence` (`certain` | `inferred` | `guessed`) and, when not `certain`, a warning is attached to the envelope. Guesses are always recoverable via `as:`.

### 3.4 Ambiguous bare tokens

`"aBcD1234"` could be an album id or a username. Resolution order:

1. `as:` hint, if given — no network.
2. Session cache (`genesis:resolve:{token}`), if fresh.
3. **Probe** (single cheap GET with `Range: bytes=0-0`): HTML containing `div.media-group` or an `/a/` self-link ⇒ album; HTML containing a listing grid (`.album`) ⇒ user; 404/410 ⇒ `unknown`.
4. Result is cached (default 24 h) so the probe cost is paid once per token.

---

## 4. GENESIS_API surface

### 4.1 Operations

```js
GENESIS_API = {
  version,
  caps(),                    // route availability under the current session — §7.4
  resolve(input, opts),      // classification only, zero network
  get(input, opts),          // classified fetch — the one entry point everything else uses
  album(input, opts),        // route: GET /a/{id}
  user(input, opts),         // route: GET /{user}?t=&page=
  search(input, opts),       // route: GET /search?q=&o=&page=
  explore(opts),             // route: GET /explore
  feed(opts),                // route: GET /
  media(input, opts),        // route: GET CDN asset (Referer + optional Range sniff)
  asset(input, opts),        // full binary fetch → payload handle
  batch(inputs, opts),       // fan-out, aggregated envelope
  raw(pathOrUrl, opts),      // escape hatch: any erome path/URL, verbatim response
  payload(handle),           // retrieve bytes captured by asset()/media()
  on(event, handler),        // 'result' | 'error' | 'drift' — §8
  watch(input, opts)         // repeat get() on an interval / on page mutation
}
```

`get()` is the workhorse: classify → route → fetch → parse → envelope. Every named method is thin sugar over it, so a newly discovered erome endpoint requires **one parsed route entry**, not a new public method.

### 4.2 Route table — N endpoints → 1 API

| Op / route key | erome endpoint | Method | Accepts | `kind` out | Notes |
|---|---|---|---|---|---|
| `album` | `/a/{id}` | GET | album url, id, DOM, html transport | `album` | Parses `og:title`, `.user-profile` uploader, `<p class="mt-10">` tags, `.media-group` blocks, `?v=` upload ts |
| `user` | `/{user}?t={tab}&page={n}` | GET | username, `@user`, profile url | `user` | 36 albums/page; tab param `t` — see §7.3 |
| `search` | `/search?q={q}&o={order}&page={n}` | GET | phrase, `#tag`, search url | `search` | `o=new` for latest ordering |
| `explore` | `/explore` | GET | literal, url | `explore` | Same listing parser as `user` |
| `feed` | `/` | GET | root url | `feed` | Home listing |
| `media` | `https://v{n}.erome.com/…` / `s{n}…` | GET (Range) | media url, element | `media` | **Requires `Referer: https://www.erome.com/`**; optional duration sniff §6.2 |
| `asset` | same CDN | GET | media url | `media` + payload | Opt-in bytes (§6.3) |
| `self.*` (`me`) | authenticated variants of the above | GET | as above + `self:true` | as above | §7 |
| `write.*` **(reserved, v1.1, unverified)** | upload / edit / delete / like / favorite / comment | POST/PUT/DELETE, multipart | structured descriptors | `ack` | Not enabled until session-probed §7.5 |
| `raw` | any erome path/URL | any | anything | `unknown` | Verbatim, wrapper-free escape hatch |

### 4.3 Batch semantics

* Input array (or multi-line paste) → one envelope, `items[]` in input order, each item tagged `inputIndex`.
* Independent per-item failure: `ok:true`, `partial:true`, `errors[]` populated per item.
* Concurrency capped (default 4); per-host serialization for `www.erome.com` to stay under the interstitial threshold (§6.4).
* `stopOnError:true` turns the first failure into `ok:false` and keeps already-collected items.

---

## 5. Output contract

### 5.1 Envelope (identical for every op)

```jsonc
{
  "schemaVersion": "genesis/1",
  "ok": true,                      // no unrecoverable failure for the requested op
  "partial": false,                // ≥1 item failed but the op continued
  "kind": "album",                 // album|user|search|explore|feed|media|asset|batch|empty|unknown
  "route": { "op": "album", "endpoint": "/a/{id}", "url": "https://www.erome.com/a/XXXXXXXX",
             "method": "GET", "status": 200 },
  "input": { "raw": "…", "classifiedAs": "album", "confidence": "certain", "hints": {} },
  "data": { "album": { /* §5.2, single-object ops */ } },
  "items": [ /* §5.2 item models — always an array, even for one item */ ],
  "page": { "index": 1, "size": 36, "count": 36, "hasMore": true, "cursor": "page=2" },
  "identity": { "authenticated": true, "username": "me", "scope": "self" },
  "warnings": [ { "code": "W_SCHEMA_DRIFT", "message": "2 unmapped fields", "detail": ["…"] } ],
  "errors": [],
  "cache": { "hit": false, "key": "genesis:album:XXXXXXXX", "ageMs": 0, "ttlMs": 21600000, "layer": "gm" },
  "timing": { "startedAt": "2026-10-03T00:00:00.000Z", "ms": 412 },
  "meta": { "schemaDrift": { "unmapped": [] }, "retries": 0, "redactions": 0 }
}
```

Rules:

* `items` is **always** an array (`album` → its media; `user`/`search`/`explore`/`feed` → albums; `media` → one item).
* `data` holds the single-object payload for object-shaped ops and is `null` otherwise.
* `ok:false` ⇒ `errors.length ≥ 1`. Nothing else can produce `ok:false`.
* `warnings` never affect `ok`.
* Field order is stable; consumers may JSON-diff envelopes safely.

### 5.2 Item model (superset for "anything common")

```jsonc
{
  "id": "XXXXXXXX",                       // album id | media id | username
  "kind": "video",                        // video | image | album | user | unknown
  "url": "https://www.erome.com/a/XXXXXXXX",
  "cdnUrl": "https://v12.erome.com/…/x_720p.mp4",
  "thumbUrl": "https://s7.erome.com/…/x.jpg",
  "filename": "x_720p", "ext": "mp4", "mime": "video/mp4",
  "position": 1,                          // 1-based within album/listing
  "albumId": "XXXXXXXX", "albumUrl": "…", "albumTitle": "…",
  "user": "creator", "tags": ["…"],
  "views": 12345, "likes": 42,            // when the page exposes them
  "uploadTs": 1698000000000,
  "durationMs": 96000,
  "durationSource": "mp4-sniff",          // mp4-sniff | cdn-header | page | cache | null
  "bytes": { "sniffed": 141, "total": 7340032 },
  "refererRequired": true,                // CDN reality: always true on erome
  "self": false,                          // true when it is your own content
  "extra": {},                            // every unmapped upstream field, verbatim
  "unknownFields": []                     // names routed into extra — feeds schemaDrift
}
```

Only `id`, `kind`, `url`, `refererRequired` are guaranteed present; everything else may be `null`. Consumers must never assume more — that is the point of a single shape.

### 5.3 Machine-readable mirror

`docs/genesis.contract.json` in this repo holds the same tables (input kinds, routes, envelope keys, error codes) as data, so implementations and tests can be driven from one source instead of prose.

---

## 6. Fetch behaviour

### 6.1 Common request shape

All routes go through one transport wrapper providing: `GM.xmlHttpRequest` when available (bypasses page CORS), `credentials: 'include'` semantics for same-origin, `Referer: https://www.erome.com/` on CDN requests, per-host concurrency limit, timeout, `AbortSignal`, and `Range` support.

### 6.2 Duration sniff (already proven in this repo)

The existing `videoLength()` trick generalizes:

```
GET cdnUrl with Range: bytes=0-140, responseType: blob
 → abort as soon as loaded > 150 bytes
 → locate /\x03.*\xe8/, read the following 4 bytes big-endian = duration ms
 → cache under genesis:media:{cdnUrl}
```

`GENESIS_API.media(url, { probe: 'duration' })` returns `durationMs` + `durationSource:"mp4-sniff"`; results are cached (`localStorage`, default 30 days) exactly like today's `$vl#` keys, which remain readable as a migration source.

### 6.3 Payload handles

`asset()` stores bytes in memory (bounded LRU) and returns `payload: { handle, size, contentType }`; `GENESIS_API.payload(handle)` retrieves them. Envelopes stay small and serializable; "anything and everything" never means megabytes inside a JSON result.

### 6.4 Hostile-host realities (all handled in the transport layer)

| Reality | Handling |
|---|---|
| Interstitial `<title>Please wait a few moments</title>` | Detect → backoff (5 s ×2, ×3) → retry ≤3 → `E_INTERSTITIAL` |
| Rate limiting / Cloudflare | Single-flight per URL, per-host queue, jittered retry |
| CDN 403 without Referer | `Referer` always set for `*.erome.com` media |
| Removed album (HTTP 410) | `E_NOT_FOUND`, message extracted from the page `<h1>` |
| Rotating CDN hosts (`v{n}`, `s{n}`) | Never cached as identity; treated as opaque, re-derived from page HTML |
| Selector drift | Parsers are per-route objects; unmapped markup raises `W_SCHEMA_DRIFT`, never throws |

---

## 7. "For me as well" — identity scope

### 7.1 Scope switch

`self: true` (or the `me` op) runs the same route with the session's cookies and `identity.scope:"self"`. Anonymous calls stay anonymous — the facade never silently promotes a request to authenticated.

### 7.2 Cache partitioning

Cache keys are `genesis:{scope}:{route}:{id}`. Self-scoped responses are **never** served to anonymous calls or a different logged-in user; identity is part of the key.

### 7.3 Profile tabs (`t=`) — partially unverified

`t=posts` is confirmed by the maintained extractor (default tab); the other tab values shown in erome's own profile UI (e.g. reposts/favourites/likes, exact strings) are **not yet verified in this repo**. Until probed, `t` is accepted verbatim and passed through unchanged — never guessed, never dropped.

### 7.4 Capability probe

```js
GENESIS_API.caps()
// { schemaVersion:"genesis/1", identity:{authenticated,username,scope}, routes:{album:true,…,
//    self:{album:false,…}, write:{upload:false,…}}, verified:{…}, interstitial:{seen:true} }
```
`caps()` is what makes "anything and everything … for me as well" checkable instead of assumed: consumers gate self-only UI on `caps().routes.self.*`.

### 7.5 Write routes (reserved — not v1)

Upload / edit / delete / like / favourite / comment are listed in the route table as `write.*`, default **disabled**, and require a session probe before implementation. Reasons: they are state-changing, unverified against the live DOM, and must not be shaped by guesswork. Enabling them is a one-table change once probed.

---

## 8. Events, drift, watch

```js
GENESIS_API.on('result', env => …);   // every envelope
GENESIS_API.on('error',  err => …);   // envelope.errors flush
GENESIS_API.on('drift',  d   => …);   // {route, unmapped:[…]} — new upstream fields appear
GENESIS_API.watch(input, { every: 60000, on: ['childList'] });
```

`drift` is the promise in the brief — *always* receiving anything, forever: when erome ships a new field or a new endpoint, the facade keeps working (passthrough), reports the drift, and only a parser entry needs updating.

---

## 9. Migration map against today's `erome.user.js`

| Today (line-level behaviour) | After |
|---|---|
| `GM.xmlHttpRequest` with `Range: bytes=0-140` + `onprogress` abort inside `videoLength()` | `GENESIS_API.media(url, { probe: 'duration' })` |
| `localStorage.getItem/setItem('$vl#'+url)` | transport cache (`genesis:media:{url}`), `$vl#` read as legacy |
| `/\x03.*\xe8/` byte math | parser inside route `media` |
| `document.querySelectorAll('.player video source')` loop | `GENESIS_API.batch(sources)` (DOM inputs re-classified) |
| hardcoded `.video`, `.album`, `.album-videos`, `.media-group`, `#slider_min_length` | split: `.media-group/.video/.player video source` → route parsers; slider/navbar stay UI |
| `document.location.hash` `onlyvideos=n` | unchanged — UI concern, not endpoint concern |

Nothing in this table is done yet; this commit is the contract only.

---

## 10. Verification checklist (to run in a browser on erome.com, logged in)

Each line is *unverified in this repo* until checked; endpoints marked ⚠ in §4 depend on these.

```js
__GENESIS.resolve('aBcD1234')                      // 3.4 probe correctness
__GENESIS.caps()                                   // identity + route availability
__GENESIS.album(location.href, { self: true })     // self-scope album route
__GENESIS.user('<my-username>', { t: '<tab>' })    // enumerate real tab values from the profile UI
__GENESIS.search('tag', { order: 'new', page: 2 }) // o=new + pagination
__GENESIS.media(document.querySelector('video source'), { probe: 'duration' })
__GENESIS.asset(<cdnUrl>)                           // 403 check without/with Referer
```

Checklist items to record in the contract when confirmed: real `t=` tab values; whether the interstitial appears at all for scripted requests; per-page count (36 assumed); HTTP status + message shape for removed albums; whether any account-only listing (favourites/likes) is reachable anonymously; the exact request shape of write ops (multipart field names) — required before §7.5 leaves "reserved".

Hard constraint observed while writing this: erome.com is unreachable from this sandbox (TLS blocked) and no logged-in session exists here, so **no live probing was possible**; §3–§6 are built from the maintained extractor's contract, this repo's own working code, and third-party tooling docs. Everything session-scoped is explicitly flagged.

---

## 11. Open questions

1. Implement now (§12 next step), or keep this spec until you have run §10 in your own browser?
2. Does "for me as well" include **account-scoped listings** (own albums, favourites, likes) only, or also **write** operations (upload/edit/delete/like)? v1 reserves the latter.
3. Should the facade ship as an in-userscript object (`window.GENESIS_API`) or as a separate `genesis-api.user.js` that `erome.user.js` depends on? (Both fit the namespace above; the contract is identical.)
4. Keep the batch/probe/`extra` passthrough behaviour always-on, or gate behind `strict` for CI-style consumers?

## 12. Next step (after sign-off)

Add the `genesis/` route+transport layer to the userscript in the exact order: transport → `resolve()` → `album`/`user`/`search` routes → envelope → legacy migration (§9), then run §10 and tighten §7.3/§7.5 against reality.
