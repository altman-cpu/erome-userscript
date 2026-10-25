# Erome video-duration userscript

Displays video durations above Erome album videos and provides an Angular control panel for filtering short videos and albums without video content.

## Build

Requires Node.js 20.19+ (or 22.12+) and npm.

```sh
npm ci
npm run build
```

The build compiles the modular Angular application and packages it into the installable `erome.user.js` userscript. Install that generated file in a userscript manager such as Tampermonkey or Violentmonkey.

## Website

A responsive Angular landing page for the project is available as a separate build target:

```sh
npm run start:site       # local development server on port 4200
npm run build:site       # production site in dist/site/browser
npm run build:all        # userscript and website
```

The page includes an interactive duration-filter demo, feature overview, privacy boundaries, and installation steps. Its install links serve the built `erome.user.js` bundle.

## Controls

- **Minimum duration:** hide videos shorter than the selected threshold; zero disables this filter.
- **Video-only albums/groups:** hide album cards or media groups without videos.
- **Minimum videos per album:** set the minimum album video count when video-only filtering is enabled.

## Defensive boundaries

- Runs only on `https://www.erome.com/*` and is disabled in frames.
- Duration lookups accept HTTPS URLs on `erome.com` and its subdomains only, use a bounded byte-range request with a timeout, and never send account or payment data.
- Duration values are cached locally in browser storage. No analytics, remote scripts, package auto-installation, or data uploads are included.
- DOM content is rendered as text; the script does not evaluate page-provided code or inject HTML from media URLs.

This program is dual licensed under:
* The Unlicense
* GPL-3.0-or-later
