# GENESIS_API — browser probe sheet (read-only)

Companion to §10 of [`GENESIS_API.md`](GENESIS_API.md). These probes run **today**, before any
`GENESIS_API` code exists, using plain `fetch` / `curl`. They exist to replace the
`unverified` rows in `genesis.contract.json` with facts.

**Ground rules**

* Every probe here is a **read-only GET**. Nothing is uploaded, edited, deleted, liked or favourited.
* Run from your own browser, on `erome.com`, logged in, with the DevTools console open.
* Record **structure only** — status codes, counts, parameter names, selector hits. Don't paste
  page content, media titles or your username; redact them (`<me>`).
* Probes that touch CDN bytes (P6/P7) are CORS-blocked inside the page console; use the terminal
  `curl` variants instead.

---

## P1 — ambiguous bare token (contract §3.4, V1)

Decides whether the album-vs-username probe heuristic is sound. Use one album id you know and one
username you know.

```js
async function probeToken(t) {
  const get = async (u) => {
    const r = await fetch(u, { headers: { Range: 'bytes=0-8192' } });
    return { status: r.status, body: await r.text() };
  };
  const a = await get(`https://www.erome.com/a/${t}`);
  if ([200, 206].includes(a.status) && /media-group/.test(a.body)) return { token: t, kind: 'album' };
  const u = await get(`https://www.erome.com/${t}`);
  if ([200, 206].includes(u.status) && /href="\/a\//.test(u.body)) return { token: t, kind: 'user' };
  return { token: t, kind: 'unknown', albumStatus: a.status, userStatus: u.status };
}
await probeToken('XXXXXXXX');        // known album id   -> expect kind: 'album'
await probeToken('<username>');      // known username   -> expect kind: 'user'
```

Record: the two `kind` values, plus both status codes.

---

## P2 — identity & capabilities (contract §7.4, V2)

```js
({
  url: location.href,
  title: document.title,
  interstitial: /Please wait a few moments/i.test(document.title),
  nav: document.querySelector('#app-navbar-collapse')?.innerText?.replace(/\s+/g, ' ').trim().slice(0, 300),
  profileLinks: [...document.querySelectorAll('a[href^="https://www.erome.com/"]')]
                   .map((a) => a.pathname).filter((p) => p.length > 1 && !p.startsWith('/a/')).slice(0, 10),
  loginForm: !!document.querySelector('form[action*="login"]')
});
```

Record: whether `nav` shows your own account (i.e. `authenticated: true`), the `title`, and whether
any login form is present. This one line settles `caps().identity`.

---

## P3 — self-scoped album route (contract §4.2, V3)

Run **while standing on one of your own album pages**:

```js
(async () => {
  const r = await fetch(location.href);
  const h = await r.text();
  return {
    status: r.status,
    mediaGroups: (h.match(/media-group/g) || []).length,
    ogTitle: /property="og:title" content="/.test(h),
    userProfile: /class="user-profile/.test(h),
    videoMarkup: (h.match(/<source src="/g) || []).length,
    imageMarkup: (h.match(/data-src="/g) || []).length,
    tagLinks: (h.match(/\?q=/g) || []).length,
    tsParam: /v=\d{10,}/.test(h),
    goneHeading: /<h1>/.test(h) ? h.split('<h1>')[1]?.split('<')[0] : null
  };
})();
```

Record: the numbers, and whether the markup matches what the
[`gallery-dl` extractor](https://github.com/mikf/gallery-dl) expects (it should — that contract is
what §4.2 encodes). Any mismatch here means parser selectors need a re-look before implementation.

---

## P4 — profile tabs: the real `t=` values (contract §7.3, V4) ⚠ highest value

Run on **your own profile page** (and, if you like, on someone else's). This is the row the spec
most needs; the tab values behind `t=` are currently guessed.

```js
({
  href: location.href,
  tabs: [...document.querySelectorAll('a[href*="t="]')]
          .map((a) => ({ text: a.innerText.trim(), href: a.getAttribute('href') }))
          .filter((x) => x.text || x.href).slice(0, 25),
  pagination: [...document.querySelectorAll('a[href*="page="]')]
          .map((a) => a.getAttribute('href')).slice(0, 6),
  albumCount: document.querySelectorAll('.album').length
});
```

Record: the full `tabs` list verbatim (e.g. which string means favourites/likes/reposts), and
whether pagination uses `page=`, `?p=`, or a cursor.

---

## P5 — search parameters & page size (contract §4.2, V5)

Run on a search results page:

```js
({
  href: location.href,
  albumsOnPage: document.querySelectorAll('.album').length,
  nextLink: document.querySelector('a[href*="page"]')?.getAttribute('href') ?? null,
  orderLink: document.querySelector('a[href*="o="]')?.getAttribute('href') ?? null
});
```

Then click "latest/new" ordering and re-run the first line. Record: how `o=` and `page=` actually
appear, and `albumsOnPage` (spec assumes 36).

---

## P6 — duration sniff (contract §6.2, V6)

Cheapest check first: **if the existing `erome.user.js` still prints durations on an album page,
V6 is already verified — just say so and skip the rest of this section.**

Otherwise, from a terminal (CORS blocks this in the page console):

```bash
curl -s -H 'Referer: https://www.erome.com/' -H 'Range: bytes=0-140' '<CDN_URL>' -o /tmp/sniff.bin \
  -w 'status=%{http_code} bytes=%{size_download} range=%{header_json}\n'
xxd /tmp/sniff.bin | head -4
```

Record: whether the `0x03 … 0xE8` marker appears and the four big-endian bytes after it — that
number is the duration in ms the parser should produce. (You don't have to know the real length;
if the printed value looks plausible, the trick is intact.)

---

## P7 — CDN without `Referer` (contract §6.4, V7)

```bash
curl -s -o /dev/null -w 'no-referer=%{http_code}\n' '<CDN_URL>'
curl -s -o /dev/null -w 'with-referer=%{http_code}\n' -H 'Referer: https://www.erome.com/' '<CDN_URL>'
```

Record: the two status codes. Expected: 403 then 200. If it's 200/200 today, the `refererRequired`
invariant gets relaxed to "advisory".

---

## P8 — endpoint discovery: "multiple endpoints" (contract §4.2, V8) ⚠

This is the probe that keeps the route table honest about *other* erome endpoints — including any
that are only reachable while logged in ("for me as well").

1. On the erome tab, open **DevTools → Network → Fetch/XHR**, clear it.
2. Use the site normally for a minute: browse an album, open your profile, switch tabs, search,
   open favourites, paginate.
3. For every request that is **not** a plain HTML document, record one row:
   `method | URL (with query string) | request content-type | response content-type | status`.

Record those rows. JSON responses here are the highest-value find — they'd let routes skip HTML
parsing entirely. Nothing is automated; you are only reading your own traffic.

---

## P9 — interstitial threshold (contract §6.4)

Record whether `document.title` ever becomes `Please wait a few moments`, and roughly how fast you
were clicking around when it appeared. That sets the retry/backoff constants instead of guessing them.

---

## P10 — write ops (contract §7.5) — **only if and when you want them**

No automation, no scripted POSTs. If you later decide `write.*` should exist, the only safe way to
learn the shapes is: perform the action yourself once (upload/edit/delete/like) with **DevTools →
Network → Preserve log** on, and record the request's method, URL, and multipart form field names
from the *your own intentional* request. Until then `write.*` stays reserved and disabled.

---

## What to send back

Fill this in and paste it — that's all I need to tighten the contract:

```
P1 token probe:   album=<kind,status>            user=<kind,status>
P2 identity:      title=<…>  authenticated=<yes/no>  nav=<redacted snippet>
P3 self album:    status=<…> mediaGroups=<n> video=<n> image=<n> tagLinks=<n> tsParam=<y/n> h1=<…>
P4 profile tabs:  <pasted tabs list: text -> href>       pagination=<page=|p=|cursor>
P5 search:        albumsPerPage=<n>  order param=<o=new | other>  next=<href>
P6 duration:      existing script works=<yes/no>  OR  marker=<y/n> value=<ms>
P7 cdn:           no-referer=<status>   with-referer=<status>
P8 endpoints:     <method | URL | req-ct | res-ct | status  … one per line>
P9 interstitial:  seen=<yes/no>  trigger=<what I was doing>
```

Once that lands, the `unverified`/`partial` markers in `docs/genesis.contract.json` get replaced with
results, §7.3/§7.5 stop being provisional, and then the route+transport layer can be written against
facts rather than the maintained-extractor contract.
