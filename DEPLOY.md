# Deployment — the final mile, without the footguns

GRID//CORE is five static files. There is no build step, no server process, no
database, and **no API key** anywhere in this repository. That last point is the
whole reason deployment can be free and permanent: nothing here can expire, get
rate-limited behind a paid plan, or be shut off for non-payment.

Everything below has been checked against the repository, not against a template.

---

## What actually gets published

| File | Required | Notes |
| --- | --- | --- |
| `index.html` | yes | the shell; carries the CSP `<meta>` fallback |
| `styles.css` | yes | |
| `app.js` | yes | engine core + terminal UI |
| `sw.js` | yes | service worker, must be served from the origin root |
| `erome.user.js` | yes | the "Download userscript" button points at it |
| `_headers` | Cloudflare / Netlify | security + cache headers, ignored elsewhere |
| `vercel.json` | Vercel | same headers for Vercel |

Do **not** publish `test/`, `scripts/`, `.github/` or the git history. The Pages
workflow copies exactly the six files above into `_site/`.

---

## Recommended: Cloudflare Pages

Best fit for "free forever, no traffic bill": static asset requests and bandwidth
are unmetered on every plan, and commercial use is allowed on the free tier.

1. Push this branch to a repository you control.
2. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**.
3. Framework preset: **None**. Build command: *empty*. Output directory: **`/`**.
4. Deploy. Every push to the production branch redeploys; pull requests get preview URLs.
5. Optional: **Custom domains** → your domain. HTTPS is issued automatically.

Free-tier limits worth knowing (they are build limits, not traffic limits):
500 builds/month, one concurrent build, 20-minute build timeout, 20,000 files per
site, 25 MiB per file, 100 `_headers` rules. This repo uses 6 files and 5 rules.

Because there is no build step you can also skip the Git integration entirely:
`npx wrangler pages deploy . --project-name gridcore` from a checkout, or drag
the folder into the dashboard.

---

## GitHub Pages (already wired: `.github/workflows/deploy.yml`)

The workflow runs `npm run verify` on the exact commit first — a red gate means
no deploy. Then it publishes the five shell files plus `_headers` (ignored by
Pages, kept for mirroring) and a permissive `robots.txt`.

1. Repository → **Settings → Pages → Source: GitHub Actions**.
2. Push to `main` (or run the workflow manually). First run publishes to
   `https://<user>.github.io/<repo>/`.
3. Nothing else to configure. No secrets, no tokens in the build.

Two honest constraints:

* **A private repository cannot publish Pages on the free plan** — GitHub
  requires Pro/Team/Enterprise for Pages from a private repo. If "private repo"
  is a hard requirement for you, use Cloudflare Pages (private repo is fine
  there) or a Netlify/Vercel deploy key scoped to that one repository.
* Free Pages is ~1 GB per published site and a **soft** 100 GB/month bandwidth
  ceiling, ~10 builds/hour. Fine at this size; not infinite.

All paths in the app are relative (`app.js`, `sw.js`, `erome.user.js`), and the
worker registers with `scope: './'`, so the `/repo/` subpath GitHub gives you
works without changes.

---

## Netlify / Vercel

Both read the same repo as-is.

* **Netlify** — *Add new site → Import existing project*. Build command: empty.
  Publish directory: `.` (or `_site` if you mirror the workflow). `_headers` is
  picked up automatically. Free tier meters 100 GB/month and 300 build minutes.
* **Vercel** — *Import project*, framework preset **Other**, build command
  empty, output directory `.`. `vercel.json` supplies the headers. The Hobby
  tier is 100 GB/month and **non-commercial only** — for personal or
  open-source use that is fine; for anything commercial, use Cloudflare Pages.

---

## After the first deploy — four checks that matter

```sh
# 1. The worker is cacheable-control, not cache-poisoned:
curl -sI https://your.site/sw.js | grep -i 'cache-control\|service-worker-allowed'

# 2. The CSP header matches the meta tag (both must be present):
curl -sI https://your.site/ | grep -i content-security-policy
curl -s https://your.site/ | grep -o "connect-src[^;]*"

# 3. The userscript is downloadable and is the version you think it is:
curl -s https://your.site/erome.user.js | grep '@version'

# 4. The shell is the shell, not a 404 page:
curl -s https://your.site/ | grep -c 'GRID//CORE'
```

Then open the site and run **03 · Diagnostics → Run self-test**. Ten checks run
locally in the tab: MP4 `mvhd` v0/v1, WebM `Duration` with a custom
`TimecodeScale`, corrupt input, formatting, GPC enforcement, cache round-trip
and one full proxy-queue probe against a synthetic container. If those are green,
the parsers work on that origin regardless of what any CDN does.

The header strip should show `SW · ACTIVE`. If it shows `SW · INSECURE ORIGIN`,
the page is on `http://` (other than localhost) and the worker will not register —
that is a browser rule, not a bug.

---

## Rollback and updates

* **Rollback** — redeploy the previous commit from the host's dashboard
  (Cloudflare: *Deployments → … → Rollback*; Pages: re-run the workflow on the
  older commit). Nothing is stateful server-side, so a rollback is instant and
  complete.
* **Service worker updates** — `sw.js` is served `no-cache`, the browser checks
  it on navigation, a new version installs to a *new* cache namespace
  (`gridcore-v<version>-*`), and activation deletes the old ones. If a tab is
  holding the old worker you get **04 · Worker → Activate update**, which sends
  `SKIP_WAITING` and reloads once.
* **Users who are offline** keep the precached shell; everything that needs the
  network (probes, the userscript download) fails honestly instead of serving
  stale bytes.

---

## What from the "final-mile checklist" is wrong for this project

Listing these because each one would cost you time or safety:

1. **"Hardcode your static keys or environment variables directly into your
   private deployment environment so they never leak into the front-end."**
   Contradictory, and the dangerous direction: *anything* in a static site is
   public. There is no key in this repo, and there must never be one — not in
   `app.js`, not in `index.html`, not in a `VITE_*`/`NEXT_PUBLIC_*` variable
   (those are compiled into the bundle by definition). If you later add an AI
   terminal, the key lives in a server-side function (Cloudflare Pages Function,
   Netlify Function, or Vercel Function) and the browser calls *that*. Build-time
   env vars are not secret; host-side secrets are.

2. **"Pin your API endpoints."** There are none. The proxy engine runs in the
   tab and talks to whatever URL is pasted into the queue, restricted to
   `http`/`https` plus the local `demo:` scheme, with an optional same-origin
   lock. A hardcoded endpoint list would only make it less useful.

3. **"Set your custom repository to Private to prevent upstream license shifts."**
   A private fork does protect your build from surprise upstream changes, and you
   may want one — but it does not work on free-tier GitHub Pages, and it does not
   do what the sentence claims: the license here is irrevocable for code you
   already hold (Unlicense *or* GPL-3.0-or-later, your choice), and no upstream
   commit reaches your deployment unless you pull it. Your deploy is a snapshot.

4. **"Register `sw.js` and `bareworker.js` with permanent local storage caching."**
   There is no `bareworker.js` in this repository — exactly one worker, `sw.js`,
   already registers itself with `scope: './'`. And "permanent" caching is not a
   thing you request from a browser: caches are evictable, and pinning the shell
   forever would freeze users on old code. The correct mechanism is what is
   implemented — versioned cache names, `no-cache` on the worker, explicit
   purge/update controls, and a shell that still loads when the network is gone.

5. **"Isolated from downstream tracking."** True as long as you add nothing: no
   analytics snippet, no font CDN, no third-party script. Cloudflare serves the
   site but injects nothing. If you ever enable host analytics, use the
   cookieless, same-origin-proxied option and say so in the README.

---

## Free-tier reality check

| Host | Static bandwidth | Builds | Private repo | Commercial |
| --- | --- | --- | --- | --- |
| Cloudflare Pages | unmetered | 500/month, 1 at a time | allowed | allowed |
| GitHub Pages | soft 100 GB/month | 10/hour | **paid plan only** | restricted |
| Netlify | 100 GB/month | 300 min/month | allowed | allowed |
| Vercel Hobby | 100 GB/month | 6,000 min/month | allowed | **not allowed** |

For a handful of static files read by people you know, all four are effectively
free for years. Cloudflare Pages is the only one where a traffic spike cannot
turn into a bill or a suspension, which is why it is the recommendation above.
