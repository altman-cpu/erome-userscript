# Erome Big — Userscript

A Tampermonkey / Violentmonkey / Greasemonkey userscript for [erome.com](https://www.erome.com/) that:

- 🎬 **Shows the duration** of every video, in big bold labels placed above each player — sized for a large man so you can read it from across the room.
- 📏 **Min-length slider** (top-right corner): hide all videos shorter than a chosen duration.
- 🗂 **"Only videos" navbar button**: click to hide albums with zero videos; keep clicking to require ≥1, ≥2, … videos per album. Right-click to turn off.
- ♻️ **Infinite-scroll & PJAX aware**: watches for new DOM nodes and re-scans automatically — durations appear on videos that load later (infinite scroll, pagination, tab switches).
- ⚡ **Parallel probing** (up to 6 at a time) with a proper ISO-BMFF (MP4) atom walker, so durations resolve quickly and correctly even when the `moov` atom is at the end of the file.
- 💾 **Bounded cache** with 30-day TTL and automatic eviction so `localStorage` doesn't grow forever.
- ⬇️ Direct download link next to each duration.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (or Violentmonkey, Greasemonkey).
2. Open `erome.user.js` from this repo (in Tampermonkey you can create a new script and paste its contents, or click the "Raw" button if hosted somewhere reachable).
3. Visit any erome.com page — album pages, tag pages, search results, the homepage. Durations will render as each video is probed.

## Build / dev

There is no build step — it's a single file: `erome.user.js`. Edit it, re-paste into Tampermonkey, reload.

## License

Dual-licensed under your choice of:

- The Unlicense
- GPL-3.0-or-later
