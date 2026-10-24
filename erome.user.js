// ==UserScript==
// @name         erome.com video length
// @namespace    https://github.com/drdre1/
// @icon         https://www.erome.com/favicon.ico
// @version      1.1
// @description  Duration of video on erome.com + continuous clip registration into movies
// @author       drdre1
// @match        https://www.erome.com/*
// @grant        GM.xmlHttpRequest
// ==/UserScript==

(function () {
  'use strict';

  // ==========================================================================
  // BRAND
  // --------------------------------------------------------------------------
  // Every storage key, DOM marker attribute, CSS class and window global this
  // script creates is derived from this ONE constant. That keeps all of the
  // moving parts under a single namespace so they can be found, audited and
  // torn down together.
  //
  // NOTE: the UserScript @namespace / @name above are deliberately unchanged.
  // Userscript managers identify an installed script by namespace+name, so
  // rebranding them would silently fork every existing install into a second
  // copy. The brand below governs our own state, not the manager's identity.
  // ==========================================================================
  const BRAND = 'erome-clip-registry';
  const VERSION = '1.1';
  const NS = BRAND + ':';        // localStorage key prefix  -> "<BRAND>:<table>#<key>"
  const ATTR = 'data-' + BRAND;  // DOM marker: "this node belongs to us"
  const CSS = BRAND;             // CSS class prefix
  const GLOBAL = 'EroClipRegistry';

  // v1.0 cached durations under this prefix. Migrated once into the registry,
  // then removed, so exactly one record per clip ever exists.
  const LEGACY_PREFIX = '$vl#';

  const MAX_RECORDS = 2000;          // registry cap; least-recently-seen evicted first
  const PRUNE_EVERY = 25;            // re-check the cap every N registrations
  const HEALTH_INTERVAL_MS = 2000;   // re-attach the observer if its root is detached
  const FOUR_K_MIN_PIXELS = 8000000; // 3840x2160 = 8.29M, DCI 4096x2160 = 8.85M

  // Candidates we look for. DOM-only: we never fetch, paginate or crawl.
  const SELECTOR = 'video';

  // Path segments on erome.com that look like a username but never are.
  const RESERVED_PATHS = new Set([
    'a', 'i', 'v', 'u', 'p', 'me', 'home', 'index', 'login', 'logout', 'signup',
    'register', 'signin', 'signout', 'trending', 'new', 'news', 'search', 'api',
    'faq', 'terms', 'privacy', 'dmca', '2257', 'contact', 'blog', 'tag', 'tags',
    'category', 'categories', 'model', 'models', 'video', 'videos', 'image',
    'images', 'album', 'albums', 'user', 'users', 'setting', 'settings',
    'account', 'message', 'messages', 'notification', 'notifications', 'upload',
    'popular', 'random', 'sitemap', 'help', 'about', 'status', 'feed', 'explore',
    'discover', 'collection', 'collections', 'gallery', 'galleries', 'media',
    'playlist', 'playlists', 'profile', 'profiles', 'inbox', 'friends',
    'following', 'followers', 'subscriptions', 'history', 'watch', 'download',
    'downloads', 'report', 'reports', 'feedback', 'forum', 'forums', 'community',
    'shop', 'store', 'premium', 'vip', 'gold', 'billing', 'payment', 'payments',
    'pay', 'checkout', 'cart', 'order', 'orders', 'subscribe', 'unsubscribe',
    'verify', 'verification', 'reset', 'password', 'forgot', 'confirm',
    'activate', 'activation', 'invite', 'invites', 'referral', 'referrals',
    'stats', 'statistics', 'dashboard', 'admin', 'moderator', 'mod', 'staff',
    'team', 'jobs', 'careers', 'press', 'ads', 'advertising', 'partner',
    'partners', 'affiliate', 'affiliates', 'content', 'contents', 'static',
    'assets', 'asset', 'img', 'css', 'js', 'fonts', 'font', 'favicon.ico',
    'robots.txt', 'health', 'live', 'cam', 'cams', 'top', 'most-viewed'
  ]);

  // --------------------------------------------------------------------------
  // small helpers
  // --------------------------------------------------------------------------
  function toInt(value) {
    const n = parseInt(value, 10);
    return isNaN(n) ? null : n;
  }

  function str(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  /** First argument that carries real information; 0 and null both count as unknown. */
  function firstKnown() {
    for (let i = 0; i < arguments.length; i++) {
      const v = arguments[i];
      if (v !== null && v !== undefined && v !== 0 && v !== '') return v;
    }
    return null;
  }

  function hash(text) {
    let h = 5381;
    for (let i = 0; i < text.length; i++) {
      h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
    }
    return h.toString(36);
  }

  function extFromUrl(url) {
    const m = url.split(/[?#]/)[0].match(/\.([A-Za-z0-9]{2,5})$/);
    return m ? m[1].toLowerCase() : null;
  }

  function formatDuration(milliseconds) {
    let s = milliseconds / 1000;
    const h = Math.floor(s / 3600);
    s -= h * 3600;
    const m = Math.floor(s / 60);
    s = Math.floor(s - m * 60);
    const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
    const ss = String(s).padStart(2, '0');
    return (h > 0 ? h + ':' : '') + mm + ':' + ss;
  }

  function slug(text) {
    return str(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  }

  // ==========================================================================
  // STORE
  // --------------------------------------------------------------------------
  // A small table-oriented persistence layer, in the spirit of a relational
  // store: fixed tables ("clips", "movies", "users", "meta"), one keyed record
  // per row, and a single canonical schema written by normalizePayload().
  // Backed by localStorage, degrading to an in-memory Map when storage is
  // unavailable (private mode) or full (quota exceeded).
  // ==========================================================================
  const Store = (function () {
    let usable = false;
    try {
      const probe = NS + '@probe';
      window.localStorage.setItem(probe, '1');
      window.localStorage.removeItem(probe);
      usable = true;
    } catch (err) {
      usable = false;
    }

    const memory = new Map();

    function fullKey(table, key) {
      return NS + table + '#' + key;
    }

    function readRaw(k) {
      if (usable) {
        try { return window.localStorage.getItem(k); } catch (e) { /* fall through to memory */ }
      }
      return memory.has(k) ? memory.get(k) : null;
    }

    function writeRaw(k, v) {
      if (usable) {
        try {
          window.localStorage.setItem(k, v);
          return true;
        } catch (e) {
          /* quota exceeded — keep serving this session from memory */
        }
      }
      memory.set(k, v);
      return false;
    }

    function removeRaw(k) {
      if (usable) {
        try { window.localStorage.removeItem(k); } catch (e) { /* ignore */ }
      }
      memory.delete(k);
    }

    function scanKeys(table) {
      const prefix = NS + table + '#';
      const out = [];
      if (usable) {
        try {
          const ls = window.localStorage;
          for (let i = 0; i < ls.length; i++) {
            const k = ls.key(i);
            if (k && k.indexOf(prefix) === 0) out.push(k);
          }
        } catch (e) { /* ignore */ }
      }
      memory.forEach(function (v, k) {
        if (k.indexOf(prefix) === 0 && out.indexOf(k) === -1) out.push(k);
      });
      return out;
    }

    function keyOf(fullK, table) {
      return fullK.slice(NS.length + table.length + 1);
    }

    return {
      usable: usable,

      get: function (table, key) {
        const full = fullKey(table, key);
        const raw = readRaw(full);
        if (raw === null || raw === undefined) return null;
        try {
          return JSON.parse(raw);
        } catch (e) {
          removeRaw(full); // corrupt row — drop it rather than poison every read
          return null;
        }
      },

      set: function (table, key, record) {
        return writeRaw(fullKey(table, key), JSON.stringify(record));
      },

      has: function (table, key) {
        return readRaw(fullKey(table, key)) !== null;
      },

      del: function (table, key) {
        removeRaw(fullKey(table, key));
      },

      all: function (table) {
        const out = {};
        scanKeys(table).forEach(function (k) {
          const raw = readRaw(k);
          if (raw === null) return;
          try {
            out[keyOf(k, table)] = JSON.parse(raw);
          } catch (e) {
            removeRaw(k);
          }
        });
        return out;
      },

      count: function (table) {
        return scanKeys(table).length;
      },

      clearTable: function (table) {
        scanKeys(table).forEach(removeRaw);
      },

      meta: function (key, value) {
        const full = fullKey('meta', key);
        if (arguments.length < 2) return readRaw(full);
        writeRaw(full, String(value));
      }
    };
  }());

  // ==========================================================================
  // LEGACY MIGRATION — "clone it once properly"
  // --------------------------------------------------------------------------
  // v1.0 stored bare durations as "$vl#<url>" -> "<ms>". Copy each one into a
  // full clip record exactly once, then delete the legacy key so there is a
  // single source of truth per clip.
  // ==========================================================================
  function migrateLegacyDurations() {
    if (Store.meta('legacyMigrated') === '1') return 0;

    const legacyKeys = [];
    try {
      const ls = window.localStorage;
      for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i);
        if (k && k.indexOf(LEGACY_PREFIX) === 0) legacyKeys.push(k);
      }
    } catch (e) {
      Store.meta('legacyMigrated', '1');
      return 0;
    }

    let moved = 0;
    legacyKeys.forEach(function (k) {
      let raw = null;
      try { raw = window.localStorage.getItem(k); } catch (e) { return; }

      const url = k.slice(LEGACY_PREFIX.length);
      const ms = toInt(raw);
      if (!url || ms === null || ms < 0) return;

      const id = hash(url);
      const existing = Store.get('clips', id);
      const now = Date.now();
      const rec = normalizePayload({
        url: url,
        durationMs: ms,
        albumId: existing ? existing.albumId : null,
        albumTitle: existing ? existing.albumTitle : null,
        username: existing ? existing.username : null,
        width: existing ? existing.width : null,
        height: existing ? existing.height : null,
        registeredAt: existing ? existing.registeredAt : now,
        seenCount: existing ? existing.seenCount : 0,
        source: 'migration'
      });
      Store.set('clips', id, rec);

      try { window.localStorage.removeItem(k); } catch (e) { /* ignore */ }
      moved++;
    });

    Store.meta('legacyMigrated', '1');
    Store.meta('migratedAt', String(Date.now()));
    return moved;
  }

  // ==========================================================================
  // PAYLOAD STRUCTURE
  // --------------------------------------------------------------------------
  // "handle the payload structure all the time": no matter where a clip's data
  // came from (DOM attributes, media metadata, the legacy cache, or the WebM
  // header probe), it is normalized into this one canonical record shape before
  // it is ever written. Nothing downstream has to guess at a field's type.
  // ==========================================================================
  function normalizePayload(input) {
    const rec = input || {};
    const url = str(rec.url);
    const width = toInt(rec.width);
    const height = toInt(rec.height);
    const durationMs = toInt(rec.durationMs);
    const now = Date.now();

    const hasDuration = durationMs !== null && durationMs >= 0;
    const w = width !== null && width > 0 ? width : null;
    const h = height !== null && height > 0 ? height : null;

    return {
      id: hash(url),
      url: url,
      ext: extFromUrl(url),

      durationMs: hasDuration ? durationMs : null,
      durationLabel: hasDuration ? formatDuration(durationMs) : null,

      width: w,
      height: h,
      pixels: w && h ? w * h : null,
      is4k: !!(w && h && (w * h) >= FOUR_K_MIN_PIXELS),

      albumId: str(rec.albumId) || null,
      albumTitle: str(rec.albumTitle) || null,
      username: str(rec.username) || null,
      index: toInt(rec.index),

      registeredAt: toInt(rec.registeredAt) || now,
      lastSeen: now,
      seenCount: (toInt(rec.seenCount) || 0) + 1,
      source: str(rec.source) || 'dom'
    };
  }

  // ==========================================================================
  // DOM READING
  // ==========================================================================
  function resolveSrc(el) {
    if (!el) return '';
    const raw = el.currentSrc || el.src || el.getAttribute('src') || '';
    if (!raw) return '';
    if (/^(blob:|data:|javascript:)/i.test(raw)) return '';
    try {
      return new URL(raw, document.baseURI).href;
    } catch (e) {
      return raw;
    }
  }

  function usernameFromEl(el) {
    if (!el || !el.getAttribute) return null;

    const explicit = el.getAttribute('data-username') || el.getAttribute('data-user');
    if (explicit && /^[A-Za-z0-9_.\-]{2,40}$/.test(explicit)) return explicit;

    const href = el.getAttribute('href');
    if (!href) return null;

    // Profile links on erome are bare "/<username>"; album/media links are
    // "/a/<id>", "/i/<id>", "/v/<id>" — RESERVED_PATHS rejects those.
    // Strip query/hash first: the "only videos" toggle rewrites a.hash on every
    // anchor in the page, which would otherwise invalidate real profile links.
    const path = str(href).split(/[?#]/)[0];
    const m = path.match(/^(?:https?:\/\/(?:www\.)?erome\.com)?\/([^/?#]+)\/?$/i);
    if (!m) return null;

    const name = m[1];
    if (RESERVED_PATHS.has(name.toLowerCase())) return null;
    if (!/^[A-Za-z0-9_.\-]{2,40}$/.test(name)) return null;

    // Require the visible text to agree with the slug; navigation links
    // ("Home", "Trending", ...) otherwise leak through as fake usernames.
    const text = str(el.textContent);
    if (text && text.toLowerCase().indexOf(name.toLowerCase()) === -1) return null;

    return name;
  }

  function findUsername(root) {
    const scope = root || document;
    const preferred = [
      '.user a[href]',
      '.username a[href]',
      'a.username[href]',
      '.uploader a[href]',
      '.user-info a[href]',
      '.author a[href]',
      '.album-header a[href]',
      '.album-title a[href]',
      '[data-username]'
    ];

    for (let i = 0; i < preferred.length; i++) {
      let matches;
      try { matches = scope.querySelectorAll(preferred[i]); } catch (e) { continue; }
      for (let j = 0; j < matches.length; j++) {
        const name = usernameFromEl(matches[j]);
        if (name) return name;
      }
    }

    // Fallback: any profile-shaped anchor outside the media grid.
    const anchors = scope.querySelectorAll('a[href]');
    for (let k = 0; k < anchors.length; k++) {
      const a = anchors[k];
      if (a.closest && a.closest('.media-group, .video, .player, .img')) continue;
      const name = usernameFromEl(a);
      if (name) return name;
    }
    return null;
  }

  function albumContext(el) {
    let albumId = null;
    let albumTitle = null;
    let username = null;

    const albumEl = el && el.closest ? el.closest('.album') : null;
    if (albumEl) {
      const link = albumEl.querySelector('a[href*="/a/"]');
      if (link) {
        const m = str(link.getAttribute('href')).match(/\/a\/([^/?#]+)/);
        if (m) albumId = m[1];
      }
      const titleEl = albumEl.querySelector('.album-title, .title, h1, h2, h3');
      if (titleEl) albumTitle = str(titleEl.textContent);
      username = findUsername(albumEl);
    }

    if (!albumId) {
      const m = document.location.pathname.match(/^\/a\/([^/?#]+)/);
      if (m) albumId = m[1];
    }
    if (!albumTitle) {
      const h = document.querySelector('h1');
      if (h) albumTitle = str(h.textContent);
    }
    if (!username) username = findUsername(document);
    if (!albumId && albumTitle) albumId = slug(albumTitle);

    return { albumId: albumId, albumTitle: albumTitle, username: username };
  }

  function mediaIndex(videoEl) {
    const group = videoEl && videoEl.closest ? videoEl.closest('.media-group') : null;
    if (!group) return null;
    const items = group.querySelectorAll('.video, .img');
    for (let i = 0; i < items.length; i++) {
      if (items[i].contains(videoEl)) return i;
    }
    return null;
  }

  /** Everything the DOM already knows about this element, no network involved. */
  function readDomPayload(sourceEl, videoEl, url) {
    const ctx = albumContext(videoEl || sourceEl);
    let width = null;
    let height = null;
    let durationMs = null;

    if (videoEl) {
      if (videoEl.videoWidth > 0) width = videoEl.videoWidth;
      if (videoEl.videoHeight > 0) height = videoEl.videoHeight;
      if (isFinite(videoEl.duration) && videoEl.duration > 0) {
        durationMs = Math.round(videoEl.duration * 1000);
      }
      const dw = toInt(videoEl.getAttribute('width'));
      const dh = toInt(videoEl.getAttribute('height'));
      width = firstKnown(width, dw);
      height = firstKnown(height, dh);
    }

    return normalizePayload({
      url: url,
      width: width,
      height: height,
      durationMs: durationMs,
      albumId: ctx.albumId,
      albumTitle: ctx.albumTitle,
      username: ctx.username,
      index: mediaIndex(videoEl || sourceEl),
      source: durationMs !== null ? 'metadata' : 'dom'
    });
  }

  // ==========================================================================
  // WRITE PATH — clips -> movies -> users
  // ==========================================================================
  function recordClip(payload) {
    const rec = normalizePayload(payload);
    if (!rec.url) return null;

    const prev = Store.get('clips', rec.id);
    if (prev) {
      // Merge, never clobber: a later pass may see the element before its
      // metadata has loaded, and must not erase what an earlier pass learned.
      rec.registeredAt = toInt(prev.registeredAt) || rec.registeredAt;
      rec.seenCount = (toInt(prev.seenCount) || 0) + 1;
      rec.durationMs = firstKnown(rec.durationMs, prev.durationMs);
      rec.durationLabel = rec.durationMs !== null ? formatDuration(rec.durationMs) : null;
      rec.width = firstKnown(rec.width, prev.width);
      rec.height = firstKnown(rec.height, prev.height);
      rec.pixels = rec.width && rec.height ? rec.width * rec.height : null;
      rec.is4k = !!(rec.pixels && rec.pixels >= FOUR_K_MIN_PIXELS);
      rec.albumId = firstKnown(rec.albumId, prev.albumId);
      rec.albumTitle = firstKnown(rec.albumTitle, prev.albumTitle);
      rec.username = firstKnown(rec.username, prev.username);
      // index is zero-based, so 0 is a real position — firstKnown() treats 0 as
      // unknown and would erase the first clip of every media group.
      rec.index = rec.index !== null && rec.index !== undefined ? rec.index : prev.index;
      rec.ext = firstKnown(rec.ext, prev.ext);
    }

    Store.set('clips', rec.id, rec);
    if (rec.albumId) touchMovie(rec);
    if (rec.username) touchUser(rec);
    return rec;
  }

  /** An album is the "movie": the ordered set of clips registered under it. */
  function touchMovie(rec) {
    const key = rec.albumId;
    const prev = Store.get('movies', key);
    const movie = prev || {
      albumId: key,
      title: null,
      username: null,
      clipIds: [],
      clipCount: 0,
      totalDurationMs: 0,
      fourKCount: 0,
      has4k: false,
      createdAt: Date.now(),
      updatedAt: 0
    };

    movie.title = firstKnown(rec.albumTitle, movie.title);
    movie.username = firstKnown(rec.username, movie.username);
    if (movie.clipIds.indexOf(rec.id) === -1) movie.clipIds.push(rec.id);
    if (toInt(rec.index) !== null) {
      movie.clipIds.sort(function (a, b) {
        const ca = Store.get('clips', a);
        const cb = Store.get('clips', b);
        return (ca && toInt(ca.index) !== null ? toInt(ca.index) : 0) -
               (cb && toInt(cb.index) !== null ? toInt(cb.index) : 0);
      });
    }

    let total = 0;
    let fourK = 0;
    movie.clipIds.forEach(function (id) {
      const c = Store.get('clips', id);
      if (!c) return;
      if (toInt(c.durationMs) !== null) total += toInt(c.durationMs);
      if (c.is4k) fourK++;
    });

    movie.clipCount = movie.clipIds.length;
    movie.totalDurationMs = total;
    movie.totalDurationLabel = total ? formatDuration(total) : null;
    movie.fourKCount = fourK;
    movie.has4k = fourK > 0;
    movie.updatedAt = Date.now();

    Store.set('movies', key, movie);
    return movie;
  }

  /** Usernames are tracked across albums for the whole life of the registry. */
  function touchUser(rec) {
    const key = rec.username;
    const prev = Store.get('users', key);
    const user = prev || {
      username: key,
      clipIds: [],
      clipCount: 0,
      albumIds: [],
      albumCount: 0,
      fourKCount: 0,
      totalDurationMs: 0,
      firstSeen: Date.now(),
      lastSeen: 0
    };

    if (user.clipIds.indexOf(rec.id) === -1) user.clipIds.push(rec.id);
    if (rec.albumId && user.albumIds.indexOf(rec.albumId) === -1) user.albumIds.push(rec.albumId);

    let total = 0;
    let fourK = 0;
    user.clipIds.forEach(function (id) {
      const c = Store.get('clips', id);
      if (!c) return;
      if (toInt(c.durationMs) !== null) total += toInt(c.durationMs);
      if (c.is4k) fourK++;
    });

    user.clipCount = user.clipIds.length;
    user.albumCount = user.albumIds.length;
    user.totalDurationMs = total;
    user.fourKCount = fourK;
    user.firstSeen = toInt(user.firstSeen) || Date.now();
    user.lastSeen = Date.now();

    Store.set('users', key, user);
    return user;
  }

  // ==========================================================================
  // DECORATION — duration label + 4K badge
  // ==========================================================================
  function injectStyles() {
    if (document.querySelector('style[' + ATTR + ']')) return;
    const style = document.createElement('style');
    style.setAttribute(ATTR, 'style');
    style.textContent =
      '.' + CSS + '-badge{' +
      'display:inline-block;margin-left:6px;padding:0 5px;border-radius:3px;' +
      'font:600 11px/16px system-ui,sans-serif;vertical-align:middle;' +
      'background:#111;color:#f5c518;border:1px solid #f5c518;' +
      '}' +
      '.' + CSS + '-badge-4k{background:#f5c518;color:#111;}' +
      '.' + CSS + '-link{display:block;overflow:hidden;text-overflow:ellipsis;' +
      'white-space:nowrap;font:11px/1.4 ui-monospace,monospace;opacity:.65;}';
    (document.head || document.documentElement).appendChild(style);
  }

  /** Direct child of `parent` carrying our marker with this exact value. */
  function brandChild(parent, value) {
    if (!parent || !parent.children) return null;
    for (let i = 0; i < parent.children.length; i++) {
      const c = parent.children[i];
      if (c.getAttribute && c.getAttribute(ATTR) === value) return c;
    }
    return null;
  }

  function ensureAnchor(sourceEl, videoEl, url) {
    const player = videoEl && videoEl.parentNode;
    const holder = player && player.parentNode;
    if (!holder || typeof holder.insertBefore !== 'function') return null;

    const a = brandChild(holder, 'link');
    if (a) return a;
    return createAnchor(holder, player, url);
  }

  function createAnchor(holder, player, url) {
    const a = document.createElement('a');
    a.setAttribute(ATTR, 'link');
    a.className = CSS + '-link';
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.appendChild(document.createTextNode(url));
    try {
      holder.insertBefore(a, player);
    } catch (e) {
      holder.appendChild(a);
    }
    return a;
  }

  /**
   * The label and badge live in ONE brand-marked container placed immediately
   * after the anchor. The first cut of v1.1 looked them up as *children* of the
   * anchor while inserting them as *siblings* (insertAdjacentElement), so the
   * lookup never matched and every repaint minted a duplicate. Searching the
   * container's own children is what makes repaints idempotent.
   */
  function ensureMeta(anchor) {
    let node = anchor.nextElementSibling;
    while (node) {
      if (node.nodeType === 1 && node.getAttribute) {
        const mark = node.getAttribute(ATTR);
        if (mark === 'meta') return node;
        if (mark === 'link') break; // reached the next clip's anchor
      }
      node = node.nextElementSibling;
    }
    const meta = document.createElement('span');
    meta.setAttribute(ATTR, 'meta');
    anchor.insertAdjacentElement('afterend', meta);
    return meta;
  }

  function decorate(anchor, rec) {
    if (!anchor || !anchor.parentNode || !rec) return;
    const meta = ensureMeta(anchor);

    let label = brandChild(meta, 'length');
    if (!label) {
      label = document.createElement('span');
      label.setAttribute(ATTR, 'length');
      meta.appendChild(label);
    }
    label.textContent = rec.durationLabel ? ' ' + rec.durationLabel : '';

    let badge = brandChild(meta, 'badge');
    if (rec.is4k) {
      if (!badge) {
        badge = document.createElement('span');
        badge.setAttribute(ATTR, 'badge');
        badge.className = CSS + '-badge ' + CSS + '-badge-4k';
        badge.textContent = '4K';
        meta.appendChild(badge);
      }
      badge.title = rec.width + 'x' + rec.height;
    } else if (badge) {
      badge.remove(); // resolution was provisional and turned out not to be 4K
    }
  }

  /** Keeps the min-length slider filter working, exactly as v1.0 did. */
  function syncSlider(videoEl, rec) {
    if (!videoEl || !rec || toInt(rec.durationMs) === null) return;
    const s = Math.floor(rec.durationMs / 1000);
    videoEl.dataset.length = s;
    const slider = document.getElementById('slider_min_length');
    if (slider) slider.max = Math.max(parseInt(slider.max, 10) || 0, s);
  }

  // ==========================================================================
  // DURATION PROBE (last resort)
  // --------------------------------------------------------------------------
  // The only network call in the script, carried over from v1.0: read the first
  // 140 bytes of the WebM and pull the duration out of the header. It runs ONLY
  // when the browser has not exposed duration via media metadata and we have no
  // cached value. Resolution is never probed — it comes from the element.
  // ==========================================================================
  const inFlight = new Set();

  function probeDuration(url, onResult) {
    if (inFlight.has(url)) return;
    if (typeof GM === 'undefined' || typeof GM.xmlHttpRequest !== 'function') return;

    inFlight.add(url);
    let settled = false;
    const finish = function (ms) {
      if (settled) return;
      settled = true;
      inFlight.delete(url);
      onResult(ms);
    };

    const req = GM.xmlHttpRequest({
      url: url,
      method: 'GET',
      headers: {
        Accept: 'video/webm,video/ogg,video/*;q=0.9,application/ogg;q=0.7,audio/*;q=0.6,*/*;q=0.5',
        Referer: 'https://www.erome.com/',
        Range: 'bytes=0-140'
      },
      responseType: 'blob',
      onprogress: function (response) {
        if (Math.max(response.loaded, response.total) > 150) {
          try { req.abort(); } catch (e) { /* already done */ }
        }
      },
      onload: function (response) {
        const text = response.responseText || '';
        const m = text.match(/\x03.*\xe8/);
        if (!m) return finish(null);
        const i = text.indexOf(m[0]) + m[0].length;
        const s = text.substring(i, i + 4);
        const ms = Array.from(s)
          .map(function (c) { return c.charCodeAt(0); })
          .map(function (value, index, values) { return value * Math.pow(256, values.length - index - 1); })
          .reduce(function (a, b) { return a + b; }, 0);
        finish(ms > 0 ? ms : null);
      },
      onerror: function () { finish(null); },
      ontimeout: function () { finish(null); }
    });
  }

  // ==========================================================================
  // REGISTRY — continuous registration with full MutationObserver control
  // ==========================================================================
  const Registry = (function () {
    // Element-level dedupe: each media node is registered exactly once per page
    // life, so re-observing the same subtree never produces a duplicate row.
    const registered = new WeakSet();
    const metadataBound = new WeakSet();

    const queued = new Set();   // nodes waiting for the next animation frame
    const dropped = { count: 0 }; // "unused work": nodes discarded before render

    let observer = null;
    let observedRoot = null;
    let frame = 0;
    let active = false;
    let paused = false;
    let sincePrune = 0;
    let stats = { scanned: 0, registered: 0, probed: 0, mutations: 0, flushes: 0, reattaches: 0 };
    let startedAt = 0;
    let healthTimer = 0;

    function scheduleFlush() {
      if (frame || !active || paused) return;
      frame = window.requestAnimationFrame(flush);
    }

    function candidatesFrom(node) {
      const out = [];
      const seen = new Set();

      function push(keyEl, videoEl, url) {
        if (!url || seen.has(keyEl)) return;
        seen.add(keyEl);
        out.push({ keyEl: keyEl, videoEl: videoEl, url: url });
      }

      function consider(v) {
        if (!v || v.tagName !== 'VIDEO') return;
        const sources = v.querySelectorAll('source');
        if (sources.length) {
          sources.forEach(function (s) { push(s, v, resolveSrc(s)); });
        } else {
          push(v, v, resolveSrc(v));
        }
      }

      if (!node || node.nodeType !== 1) return out;
      if (node.tagName === 'VIDEO') consider(node);
      else if (node.tagName === 'SOURCE' && node.parentNode && node.parentNode.tagName === 'VIDEO') consider(node.parentNode);
      if (node.querySelectorAll) node.querySelectorAll(SELECTOR).forEach(consider);
      return out;
    }

    function bindMetadata(cand, onChange) {
      const v = cand.videoEl;
      if (!v || metadataBound.has(v)) return;
      metadataBound.add(v);

      const handler = function () {
        const payload = readDomPayload(cand.keyEl, v, cand.url);
        const rec = recordClip(payload);
        syncSlider(v, rec);
        if (rec) onChange(rec);
      };

      ['loadedmetadata', 'resize', 'durationchange'].forEach(function (evt) {
        v.addEventListener(evt, handler, { passive: true });
      });
      // If the metadata is already there, take it now instead of waiting.
      if (v.readyState >= 1) handler();
    }

    function registerCandidate(cand) {
      stats.scanned++;
      if (registered.has(cand.keyEl)) return false;
      registered.add(cand.keyEl);

      const anchor = ensureAnchor(cand.keyEl, cand.videoEl, cand.url);
      const initial = readDomPayload(cand.keyEl, cand.videoEl, cand.url);
      let rec = recordClip(initial);

      const paint = function (next) {
        if (next) rec = next;
        decorate(anchor, rec);
        syncSlider(cand.videoEl, rec);
      };
      paint(rec);

      bindMetadata(cand, paint);

      // Only reach for the network when nothing else can tell us the duration.
      if (rec && rec.durationMs === null) {
        stats.probed++;
        probeDuration(cand.url, function (ms) {
          if (ms === null) return;
          const stored = Store.get('clips', rec.id);
          const merged = recordClip(Object.assign({}, stored || rec, {
            durationMs: ms,
            source: 'webm-header'
          }));
          paint(merged);
        });
      }

      stats.registered++;
      sincePrune++;
      if (sincePrune >= PRUNE_EVERY) {
        sincePrune = 0;
        prune();
      }
      return true;
    }

    function scanNode(node) {
      candidatesFrom(node).forEach(registerCandidate);
    }

    function flush() {
      frame = 0;
      if (!active) { queued.clear(); return; }
      stats.flushes++;

      const nodes = Array.from(queued);
      queued.clear();

      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        if (!node || node.nodeType !== 1) continue;
        // Unused work: the node was torn down again before we ever got to it.
        if (!document.contains(node)) { dropped.count++; continue; }
        scanNode(node);
      }

      // The observed root can be replaced wholesale by client-side rendering;
      // re-attach so registration truly never stops.
      if (observer && observedRoot && !document.contains(observedRoot)) reattach();
    }

    function onMutations(records) {
      if (!active || paused) return;
      for (let i = 0; i < records.length; i++) {
        const m = records[i];
        stats.mutations++;

        const target = m.target;
        const ours = target && target.nodeType === 1 &&
          typeof target.hasAttribute === 'function' && target.hasAttribute(ATTR);
        if (ours) continue; // our own decoration — ignore, or we would loop forever

        if (m.type === 'attributes') {
          if (target && target.nodeType === 1) queued.add(target);
          continue;
        }

        const added = m.addedNodes;
        for (let j = 0; j < added.length; j++) {
          const node = added[j];
          if (node.nodeType !== 1) continue;
          if (node.hasAttribute && node.hasAttribute(ATTR)) continue; // ours
          queued.add(node);
        }
      }
      if (queued.size) scheduleFlush();
    }

    function attach() {
      // Prefer documentElement: it survives a wholesale <body> replacement, so
      // client-side rendering that swaps the body cannot orphan the observer.
      const root = document.documentElement || document.body;
      if (!root) return false;
      observedRoot = root;
      observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src']
      });
      return true;
    }

    function reattach() {
      if (!observer) return false;
      try { observer.disconnect(); } catch (e) { /* ignore */ }
      observedRoot = null;
      const ok = attach();
      if (ok) stats.reattaches++;
      return ok;
    }

    function isHealthy() {
      return !!(observer && observedRoot && document.contains(observedRoot));
    }

    /**
     * Recovery that does NOT depend on mutation flow. If the observed root is
     * detached, no mutation can ever fire on it again, so flush() would never
     * run and the re-attach inside it would never be reached — registration
     * would silently stop forever. This timer is the backstop for that case.
     * Cleared in stop(), so it never outlives the registry.
     */
    function healthCheck() {
      if (!active || !observer) return;
      if (!isHealthy()) {
        reattach();
        rescan(document); // pick up anything that arrived while we were blind
      }
    }

    function onPageHide() {
      // Full teardown: no observer, no pending frame, no queued work left behind.
      stop();
    }

    function start() {
      if (active) return true;
      injectStyles();
      observer = new MutationObserver(onMutations);
      active = true;
      paused = false;
      startedAt = Date.now();
      const ok = attach();
      window.addEventListener('pagehide', onPageHide, { passive: true });
      if (!healthTimer) healthTimer = window.setInterval(healthCheck, HEALTH_INTERVAL_MS);
      rescan(document);
      return ok;
    }

    function stop() {
      active = false;
      paused = false;
      if (frame) { window.cancelAnimationFrame(frame); frame = 0; }
      if (healthTimer) { window.clearInterval(healthTimer); healthTimer = 0; }
      queued.clear();
      if (observer) {
        try { observer.disconnect(); } catch (e) { /* ignore */ }
        observer = null;
      }
      observedRoot = null;
      window.removeEventListener('pagehide', onPageHide);
    }

    function pause() {
      if (!active) return;
      paused = true;
      if (frame) { window.cancelAnimationFrame(frame); frame = 0; }
      queued.clear();
    }

    function resume() {
      if (!active) return start();
      paused = false;
      rescan(document);
    }

    function rescan(root) {
      const scope = root || document;
      if (scope.querySelectorAll) scope.querySelectorAll(SELECTOR).forEach(function (v) { scanNode(v); });
      if (scope.tagName === 'VIDEO') scanNode(scope);
    }

    /** Drop rows past the cap, then reap movies/users left with no clips. */
    function prune() {
      const clips = Store.all('clips');
      const ids = Object.keys(clips);
      if (ids.length > MAX_RECORDS) {
        ids.sort(function (a, b) {
          return (toInt(clips[a].lastSeen) || 0) - (toInt(clips[b].lastSeen) || 0);
        });
        ids.slice(0, ids.length - MAX_RECORDS).forEach(function (id) {
          Store.del('clips', id);
        });
      }

      ['movies', 'users'].forEach(function (table) {
        const rows = Store.all(table);
        Object.keys(rows).forEach(function (key) {
          const row = rows[key];
          const live = (row.clipIds || []).filter(function (id) { return Store.has('clips', id); });
          if (!live.length) {
            Store.del(table, key); // orphaned aggregate — unused work, reclaimed
            return;
          }
          if (live.length !== row.clipIds.length) {
            row.clipIds = live;
            Store.set(table, key, row);
          }
        });
      });
    }

    function status() {
      return {
        brand: BRAND,
        version: VERSION,
        active: active,
        paused: paused,
        observing: isHealthy(),
        healthTimer: !!healthTimer,
        observedRoot: observedRoot ? observedRoot.nodeName : null,
        uptimeMs: startedAt && active ? Date.now() - startedAt : 0,
        queued: queued.size,
        droppedNodes: dropped.count,
        storage: Store.usable ? 'localStorage' : 'memory',
        counts: {
          clips: Store.count('clips'),
          movies: Store.count('movies'),
          users: Store.count('users')
        },
        stats: Object.assign({}, stats)
      };
    }

    return {
      start: start,
      stop: stop,
      pause: pause,
      resume: resume,
      rescan: rescan,
      reattach: reattach,
      healthCheck: healthCheck,
      prune: prune,
      status: status,
      _scanNode: scanNode
    };
  }());

  // ==========================================================================
  // PUBLIC CONTROL SURFACE
  // --------------------------------------------------------------------------
  // One branded global with full control over the observer and the registry.
  // ==========================================================================
  window[GLOBAL] = {
    brand: BRAND,
    version: VERSION,

    start: Registry.start,
    stop: Registry.stop,
    pause: Registry.pause,
    resume: Registry.resume,
    rescan: Registry.rescan,
    reattach: Registry.reattach,
    healthCheck: Registry.healthCheck,
    status: Registry.status,

    clips: function () { return Store.all('clips'); },
    movies: function () { return Store.all('movies'); },
    users: function () { return Store.all('users'); },
    clip: function (url) { return Store.get('clips', hash(url)); },

    export: function () {
      return JSON.stringify({
        brand: BRAND,
        version: VERSION,
        exportedAt: new Date().toISOString(),
        clips: Store.all('clips'),
        movies: Store.all('movies'),
        users: Store.all('users')
      }, null, 2);
    },

    clear: function (table) {
      if (table) { Store.clearTable(table); return; }
      ['clips', 'movies', 'users'].forEach(Store.clearTable);
    },

    prune: Registry.prune,
    store: Store
  };

  // ==========================================================================
  // MINIMUM-LENGTH SLIDER (v1.0 behaviour, preserved)
  // ==========================================================================
  const showSlider = function () {
    const div = document.body.appendChild(document.createElement('div'));
    div.setAttribute(ATTR, 'slider');
    div.setAttribute('style', 'position:fixed; right:0px; top:50px');
    div.innerHTML = 'Minimal length:<br>';
    const output = div.appendChild(document.createElement('output'));
    output.setAttribute('id', 'slider_min_length_output');
    const slider = div.appendChild(document.createElement('input'));
    slider.setAttribute('id', 'slider_min_length');
    slider.setAttribute('type', 'range');
    slider.setAttribute('step', '1');
    slider.setAttribute('min', '1');
    slider.setAttribute('max', '5');
    slider.setAttribute('value', '1');
    slider.addEventListener('input', () => {
      const minS = parseInt(slider.value);
      if (minS > 1) {
        const m = parseInt(slider.value / 60);
        const s = minS - m * 60;
        output.textContent = `${m}:${s > 9 ? s : (`0${s}`)}`;
        document.querySelectorAll('.video')
          .forEach((vc) => {
            const video = vc.querySelector('.player video');
            if (video && 'length' in video.dataset && video.dataset.length < minS) {
              vc.style.display = 'none';
            } else {
              vc.style.display = '';
            }
          });
      } else {
        output.textContent = 'Off';
        document.querySelectorAll('.video')
          .forEach((vc) => {
            vc.style.display = '';
          });
      }
    });
  };

  // ==========================================================================
  // "ONLY VIDEOS" FILTER (v1.0 behaviour, preserved)
  // ==========================================================================
  let minNumberOfVideos = 0;

  const showOnlyVideosThumbs = function () {
    document.querySelectorAll('.album')
      .forEach((album) => {
        const e = album.querySelector('.album-videos');
        if (e && e.textContent && parseInt(e.textContent) && parseInt(e.textContent) >= minNumberOfVideos) {
          return;
        }
        album.style.display = 'none';
      });
  };

  const showOnlyVideosAlbum = function () {
    document.querySelectorAll('.media-group')
      .forEach((mediaGroup) => {
        if (!mediaGroup.querySelector('.video')) {
          mediaGroup.remove();
        }
      });
  };

  const showOnlyVideos = function (ev) {
    if (ev) {
      ev.preventDefault();
    }
    minNumberOfVideos++;
    if (document.location.hash.match(/onlyvideos=(\d+)/)) {
      document.location.hash = document.location.hash.replace(/onlyvideos=\d+/, `onlyvideos=${minNumberOfVideos}`);
    } else {
      document.location.hash = `#onlyvideos=${minNumberOfVideos}`;
    }
    if (document.location.pathname.startsWith('/a/')) {
      showOnlyVideosAlbum();
    } else {
      showOnlyVideosThumbs();
    }
    document.querySelectorAll('a[href]')
      .forEach((a) => {
        a.hash = `#onlyvideos=${minNumberOfVideos}`;
      });
  };

  const disableShowOnlyVideos = function (ev) {
    if (ev) {
      ev.preventDefault();
    }
    document.location.hash = '';
    document.location.reload();
  };

  // ==========================================================================
  // BOOT
  // ==========================================================================
  if (document.querySelectorAll('video').length > 1) {
    showSlider();
  }

  const migrated = migrateLegacyDurations();
  if (migrated) Store.meta('migratedCount', String(migrated));

  Registry.start();

  if (document.querySelector('#app-navbar-collapse ul.navbar-right')) {
    const a = document.querySelector('#app-navbar-collapse ul.navbar-right')
      .appendChild(document.createElement('li'))
      .appendChild(document.createElement('a'));
    a.setAttribute(ATTR, 'nav');
    a.href = `#onlyvideos=${minNumberOfVideos + 1}`;
    a.title = 'Right click to disable';
    a.addEventListener('click', showOnlyVideos);
    a.addEventListener('contextmenu', disableShowOnlyVideos);
    a.appendChild(document.createTextNode('only videos'));
  }

  if (document.location.hash.match(/onlyvideos=(\d+)/)) {
    const n = parseInt(document.location.hash.match(/onlyvideos=(\d+)/)[1]);
    for (let i = 0; i < n; i++) {
      showOnlyVideos();
    }
  }
}());
