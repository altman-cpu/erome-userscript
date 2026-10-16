// ==UserScript==
// @name         Erome Big — Video Durations, Length Filter, "Only Videos"
// @namespace    https://github.com/altman-cpu/erome-userscript
// @icon         https://www.erome.com/favicon.ico
// @version      2.0.0
// @description  Show video durations on erome.com album pages & thumbnails, filter by minimum length, hide non-video albums. Bold, big UI. Handles infinite scroll / lazy loads.
// @author       drdre1 + contributors
// @match        https://www.erome.com/*
// @match        https://erome.com/*
// @grant        GM.xmlHttpRequest
// @run-at       document-idle
// @license      Unlicense OR GPL-3.0-or-later
// ==/UserScript==

(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────────────
  // Configuration — sized for a large man
  // ─────────────────────────────────────────────────────────────────────
  const CFG = {
    // How many bytes of the start of the MP4 to fetch. 64 KB is enough to
    // contain the moov/mvhd atoms on virtually every Erome encode.
    probeBytes: 65536,
    // Max parallel duration probes
    concurrency: 6,
    // LocalStorage TTL (30 days) and max cache entries
    cacheTTLMs: 30 * 24 * 60 * 60 * 1000,
    cacheMaxEntries: 2000,
    cachePrefix: 'erome:vlen:',
    // UI sizing (rem-like px values scaled up for readability)
    durationFontSize: '15px',
    durationFontWeight: '700',
    panelFontSize: '16px',
    panelWidth: '220px',
    navbarFontSize: '16px',
  };

  // ─────────────────────────────────────────────────────────────────────
  // MP4 duration parser — walks the ISO-BMFF atom tree to find mvhd and
  // read timescale + duration. Works on both version-0 and version-1 mvhd,
  // with moov at front or back (we retry with tail range if not found).
  // ─────────────────────────────────────────────────────────────────────
  function parseMp4Duration(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;
    let mvhd = null;

    function readBox(start, end) {
      let p = start;
      while (p + 8 <= end) {
        let size = dv.getUint32(p);
        const type = String.fromCharCode(dv.getUint8(p + 4), dv.getUint8(p + 5),
                                        dv.getUint8(p + 6), dv.getUint8(p + 7));
        let headerSize = 8;
        if (size === 1) {
          if (p + 16 > end) return;
          size = Number(dv.getBigUint64(p + 8));
          headerSize = 16;
        } else if (size === 0) {
          size = end - p;
        }
        if (size < headerSize || p + size > end) return;
        const bodyStart = p + headerSize;
        const bodyEnd = p + size;
        if (type === 'moov') {
          readBox(bodyStart, bodyEnd);
        } else if (type === 'mvhd') {
          mvhd = parseMvhd(dv, bodyStart, bodyEnd);
        } else if (type === 'moof' || type === 'trak' || type === 'mdia') {
          readBox(bodyStart, bodyEnd);
        }
        p += size;
        if (mvhd) return;
      }
    }

    function parseMvhd(view, b, e) {
      if (b + 4 > e) return null;
      const version = view.getUint8(b);
      // flags are 3 bytes; skip to timescale/duration
      if (version === 1) {
        if (b + 8 + 8 + 4 + 8 > e) return null;
        const timescale = view.getUint32(b + 20);
        const duration = Number(view.getBigUint64(b + 24));
        return { timescale, duration };
      } else {
        if (b + 4 + 4 + 4 + 4 > e) return null;
        const timescale = view.getUint32(b + 12);
        const duration = view.getUint32(b + 16);
        return { timescale, duration };
      }
    }

    readBox(offset, bytes.byteLength);
    if (!mvhd || !mvhd.timescale) return null;
    return Math.round((mvhd.duration / mvhd.timescale) * 1000); // ms
  }

  // ─────────────────────────────────────────────────────────────────────
  // Tiny fetch queue for parallel but bounded probes
  // ─────────────────────────────────────────────────────────────────────
  const queue = [];
  let inflight = 0;
  function enqueue(fn) {
    queue.push(fn);
    pump();
  }
  function pump() {
    while (inflight < CFG.concurrency && queue.length) {
      inflight++;
      const fn = queue.shift();
      fn().finally(() => {
        inflight--;
        pump();
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Cache (localStorage) with TTL + LRU-ish eviction
  // ─────────────────────────────────────────────────────────────────────
  function cacheKey(url) { return CFG.cachePrefix + url; }

  function cacheGet(url) {
    try {
      const raw = localStorage.getItem(cacheKey(url));
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj.ms !== 'number') return null;
      if (obj.t && Date.now() - obj.t > CFG.cacheTTLMs) {
        localStorage.removeItem(cacheKey(url));
        return null;
      }
      return obj.ms;
    } catch { return null; }
  }

  function cacheSet(url, ms) {
    try {
      localStorage.setItem(cacheKey(url), JSON.stringify({ ms, t: Date.now() }));
      maybeEvictCache();
    } catch {
      // storage full — drop half the oldest entries
      evictOldest(Math.floor(CFG.cacheMaxEntries / 2));
    }
  }

  function maybeEvictCache() {
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(CFG.cachePrefix)) {
          let t = 0;
          try { t = JSON.parse(localStorage.getItem(k)).t || 0; } catch {}
          keys.push({ k, t });
        }
      }
      if (keys.length > CFG.cacheMaxEntries) {
        keys.sort((a, b) => a.t - b.t);
        const toKill = keys.length - CFG.cacheMaxEntries + 100;
        for (let i = 0; i < toKill; i++) localStorage.removeItem(keys[i].k);
      }
    } catch {}
  }

  function evictOldest(n) {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(CFG.cachePrefix)) {
        let t = 0;
        try { t = JSON.parse(localStorage.getItem(k)).t || 0; } catch {}
        keys.push({ k, t });
      }
    }
    keys.sort((a, b) => a.t - b.t);
    for (let i = 0; i < Math.min(n, keys.length); i++) localStorage.removeItem(keys[i].k);
  }

  // ─────────────────────────────────────────────────────────────────────
  // Duration formatting  h:mm:ss  /  m:ss
  // ─────────────────────────────────────────────────────────────────────
  function formatDuration(ms) {
    let s = Math.round(ms / 1000);
    const h = Math.floor(s / 3600);
    s -= h * 3600;
    const m = Math.floor(s / 60);
    s -= m * 60;
    const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Probe a video URL for its duration, then call cb(ms)
  // ─────────────────────────────────────────────────────────────────────
  function probeDuration(url, cb) {
    const cached = cacheGet(url);
    if (cached != null) { cb(cached); return; }

    enqueue(() => new Promise((resolve) => {
      let done = false;
      const finish = (ms) => {
        if (done) return;
        done = true;
        if (ms != null) cacheSet(url, ms);
        cb(ms);
        resolve();
      };

      const tryRange = (range, isTail) => {
        GM.xmlHttpRequest({
          url,
          method: 'GET',
          headers: {
            Accept: 'video/webm,video/ogg,video/*;q=0.9,application/ogg;q=0.7,audio/*;q=0.6,*/*;q=0.5',
            Referer: 'https://www.erome.com/',
            Range: range,
          },
          responseType: 'arraybuffer',
          timeout: 15000,
          onload(response) {
            try {
              if (!response.response || response.response.byteLength === 0) {
                return finish(null);
              }
              const bytes = new Uint8Array(response.response);
              const ms = parseMp4Duration(bytes);
              if (ms != null) return finish(ms);
              // mvhd not found in head — try tail if we haven't yet
              if (!isTail) {
                // Some MP4s have moov at the end. Fetch last 64KB.
                // We can't easily know content-length; use a suffix range.
                tryRange('bytes=-65536', true);
              } else {
                finish(null);
              }
            } catch {
              finish(null);
            }
          },
          onerror: () => finish(null),
          ontimeout: () => finish(null),
          onabort: () => finish(null),
        });
      };

      tryRange(`bytes=0-${CFG.probeBytes - 1}`, false);
    }));
  }

  // ─────────────────────────────────────────────────────────────────────
  // Attach duration label + dataset to a <video>
  // ─────────────────────────────────────────────────────────────────────
  const processedVideos = new WeakSet();

  function attachDurationTo(video) {
    if (!video || processedVideos.has(video)) return;
    processedVideos.add(video);

    const source = video.querySelector('source');
    const url = (source && source.src) || video.currentSrc || video.src;
    if (!url) return;

    // Build a big, bold duration label and insert it above the player.
    const label = document.createElement('span');
    label.className = 'erome-big-duration';
    label.textContent = '…';
    label.setAttribute('style', `
      display: inline-block;
      padding: 4px 10px;
      margin: 4px 0 6px 0;
      font-size: ${CFG.durationFontSize};
      font-weight: ${CFG.durationFontWeight};
      color: #fff;
      background: rgba(0,0,0,0.75);
      border-radius: 4px;
      letter-spacing: 0.5px;
    `);

    // Try to place the label just above the player, inside its container.
    const container = video.closest('.player') || video.parentElement;
    if (container && container.parentNode) {
      container.parentNode.insertBefore(label, container);
    } else {
      video.parentNode.insertBefore(label, video);
    }

    // Direct download link (small, next to duration)
    const dl = document.createElement('a');
    dl.href = url;
    dl.target = '_blank';
    dl.rel = 'noopener';
    dl.textContent = ' ⬇';
    dl.setAttribute('style', `
      color:#fff;background:rgba(0,0,0,0.75);padding:4px 10px;border-radius:4px;
      text-decoration:none;font-size:${CFG.durationFontSize};font-weight:700;margin-left:4px;
    `);
    label.parentNode.insertBefore(dl, label.nextSibling);

    probeDuration(url, (ms) => {
      if (ms == null) {
        label.textContent = '—:——';
        label.style.background = 'rgba(120,120,120,0.7)';
        return;
      }
      const seconds = Math.round(ms / 1000);
      label.textContent = formatDuration(ms);
      video.dataset.length = String(seconds);
      // Update slider max
      const slider = document.getElementById('slider_min_length');
      if (slider) {
        const curMax = parseInt(slider.max) || 0;
        if (seconds > curMax) slider.max = String(seconds);
      }
      // Re-run filter in case one is active
      applyMinLengthFilter();
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // Minimum-length slider panel
  // ─────────────────────────────────────────────────────────────────────
  let sliderPanel = null;

  function ensureSliderPanel() {
    if (sliderPanel) return sliderPanel;
    const panel = document.createElement('div');
    panel.id = 'erome-big-panel';
    panel.setAttribute('style', `
      position: fixed;
      right: 12px;
      top: 70px;
      z-index: 99999;
      padding: 10px 14px;
      background: rgba(20,20,20,0.92);
      color: #fff;
      border: 2px solid #444;
      border-radius: 8px;
      font-size: ${CFG.panelFontSize};
      font-weight: 600;
      width: ${CFG.panelWidth};
      box-shadow: 0 4px 16px rgba(0,0,0,0.5);
      user-select: none;
    `);
    panel.innerHTML = `
      <div style="margin-bottom:6px;">Min video length:</div>
      <div style="display:flex;align-items:center;gap:8px;">
        <output id="slider_min_length_output" style="min-width:64px;text-align:right;font-variant-numeric:tabular-nums;">Off</output>
        <input id="slider_min_length" type="range" min="1" max="60" step="1" value="1"
               style="flex:1;height:8px;accent-color:#ff5500;cursor:pointer;">
      </div>
      <div style="margin-top:6px;font-size:12px;color:#aaa;">Hide videos shorter than this</div>
    `;
    document.body.appendChild(panel);
    sliderPanel = panel;

    const slider = panel.querySelector('#slider_min_length');
    slider.addEventListener('input', applyMinLengthFilter);
    return panel;
  }

  function applyMinLengthFilter() {
    const slider = document.getElementById('slider_min_length');
    const output = document.getElementById('slider_min_length_output');
    if (!slider || !output) return;
    const minS = parseInt(slider.value);
    if (minS <= 1) {
      output.textContent = 'Off';
      document.querySelectorAll('.video, .media-group').forEach((el) => {
        el.style.display = '';
      });
      return;
    }
    output.textContent = formatDuration(minS * 1000);
    document.querySelectorAll('.video').forEach((vc) => {
      const video = vc.querySelector('.player video');
      if (video && video.dataset.length && parseInt(video.dataset.length) < minS) {
        vc.style.display = 'none';
      } else {
        vc.style.display = '';
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // "Only videos" navbar button
  // ─────────────────────────────────────────────────────────────────────
  let onlyVideosCount = 0;

  function applyOnlyVideosThumbs() {
    document.querySelectorAll('.album').forEach((album) => {
      const badge = album.querySelector('.album-videos');
      const n = badge && badge.textContent ? parseInt(badge.textContent) : 0;
      if (!n || n < onlyVideosCount) album.style.display = 'none';
    });
  }

  function applyOnlyVideosAlbum() {
    document.querySelectorAll('.media-group').forEach((mg) => {
      if (!mg.querySelector('.video')) mg.remove();
    });
  }

  function applyOnlyVideos() {
    if (document.location.pathname.startsWith('/a/')) {
      applyOnlyVideosAlbum();
    } else {
      applyOnlyVideosThumbs();
    }
  }

  function showOnlyVideos(ev) {
    if (ev) ev.preventDefault();
    onlyVideosCount++;
    const hash = `#onlyvideos=${onlyVideosCount}`;
    history.replaceState(null, '', document.location.pathname + document.location.search + hash);
    applyOnlyVideos();
    // Stamp future in-page links
    document.querySelectorAll('a[href]').forEach((a) => {
      if (a.href && !a.href.includes('onlyvideos=')) {
        try {
          const u = new URL(a.href, location.href);
          if (u.origin === location.origin) {
            u.hash = `onlyvideos=${onlyVideosCount}`;
            a.href = u.toString();
          }
        } catch {}
      }
    });
    updateNavbarButton();
  }

  function disableShowOnlyVideos(ev) {
    if (ev) ev.preventDefault();
    onlyVideosCount = 0;
    history.replaceState(null, '', document.location.pathname + document.location.search);
    document.location.reload();
  }

  function updateNavbarButton() {
    const a = document.getElementById('erome-big-onlyvideos');
    if (!a) return;
    a.textContent = onlyVideosCount > 0 ? `only videos (≥${onlyVideosCount})` : 'only videos';
  }

  function installNavbarButton() {
    const nav = document.querySelector('#app-navbar-collapse ul.navbar-right');
    if (!nav || document.getElementById('erome-big-onlyvideos')) return;
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.id = 'erome-big-onlyvideos';
    a.href = `#onlyvideos=${onlyVideosCount + 1}`;
    a.title = 'Click: require more videos per album · Right-click: turn off';
    a.style.fontSize = CFG.navbarFontSize;
    a.style.fontWeight = '700';
    a.addEventListener('click', showOnlyVideos);
    a.addEventListener('contextmenu', disableShowOnlyVideos);
    li.appendChild(a);
    nav.appendChild(li);
    updateNavbarButton();
  }

  // ─────────────────────────────────────────────────────────────────────
  // Scan the page and wire up all videos. Safe to call repeatedly.
  // ─────────────────────────────────────────────────────────────────────
  function scan() {
    // Videos on album pages (inside .player) and inline
    document.querySelectorAll('video').forEach((v) => {
      if (!processedVideos.has(v)) attachDurationTo(v);
    });
    // Show slider if there's more than one video on the page
    if (document.querySelectorAll('video').length > 0) {
      ensureSliderPanel();
    }
    installNavbarButton();
    if (onlyVideosCount > 0) applyOnlyVideos();
  }

  // ─────────────────────────────────────────────────────────────────────
  // Watch for infinite-scroll / lazy-loaded content
  // ─────────────────────────────────────────────────────────────────────
  const observer = new MutationObserver(() => {
    // Debounce a tick to let DOM settle
    if (observer._t) return;
    observer._t = setTimeout(() => {
      observer._t = null;
      scan();
    }, 100);
  });

  function start() {
    // Restore onlyvideos state from hash
    const m = document.location.hash.match(/onlyvideos=(\d+)/);
    if (m) onlyVideosCount = parseInt(m[1]) || 0;

    scan();
    observer.observe(document.body, { childList: true, subtree: true });

    // Also rescan on pushState/replaceState (Erome uses PJAX-ish navigation)
    const _ps = history.pushState;
    const _rs = history.replaceState;
    history.pushState = function () { const r = _ps.apply(this, arguments); setTimeout(scan, 250); return r; };
    history.replaceState = function () { const r = _rs.apply(this, arguments); setTimeout(scan, 250); return r; };
    window.addEventListener('popstate', () => setTimeout(scan, 250));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
}());
